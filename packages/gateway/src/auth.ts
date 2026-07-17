import type { Context, Next } from "hono";
import { ipInAnyCidr, normalizeIp } from "./cidr.js";
import type { ManifestKeyValidator } from "./manifest-key.js";

export type AuthEnv = {
  Bindings: { ip?: string };
  Variables: {
    injectedAuthHeader?: string;
    /** Resultado da validação (content-free) — preenchido pelo middleware. */
    authValidate?: string;
  };
};

const LOOPBACK_IPS = new Set(["127.0.0.1", "::1"]);

export type AuthMiddlewareOpts = {
  defaultKey: string;
  /**
   * IPs/CIDRs tratados como "lado do host" (além de loopback): HTTP ok e
   * anônimo com injeção de defaultKey. Uso típico: `172.28.1.1/32` (hairpin
   * do docker-proxy para `http://127.0.0.1:11434`) e/ou a subnet do compose
   * para serviços internos (Open WebUI → gateway).
   */
  trustedCidrs: string[];
  /**
   * Proxies TLS que podem afirmar HTTPS via `X-Forwarded-Proto`.
   * - Vazio: qualquer peer fora do host-side precisa mandar
   *   `X-Forwarded-Proto: https` (spoofável se a porta estiver na LAN).
   * - Preenchido: fora do host-side só aceita peers nesta lista E com
   *   `X-Forwarded-Proto: https` (recomendado com Caddy/nginx na frente).
   */
  trustedProxies: string[];
  /**
   * Valida credenciais `mnfst_*` apresentadas pelo cliente contra o Manifest.
   * Obrigatório em produção; testes podem passar um stub.
   */
  validateKey: ManifestKeyValidator;
};

// Só credencial com formato de chave do manifest merece passar adiante: o
// manifest é o único upstream e rejeita qualquer outra coisa com M003 ("keys
// start with mnfst_") -- que ainda volta embrulhado num 200 pelo headroom,
// virando um erro indecifrável no cliente. Caso concreto (2026-07-05): o
// GitHub Copilot manda o token GitHub dele no Authorization. Tratar
// não-mnfst como "sem credencial" é estritamente melhor que repassar.
function extractManifestKey(c: Context<AuthEnv>): string | undefined {
  const authorization = c.req.header("authorization");
  if (authorization?.startsWith("Bearer mnfst_")) {
    return authorization.slice("Bearer ".length);
  }
  const apiKey = c.req.header("x-api-key");
  if (apiKey?.startsWith("mnfst_")) return apiKey;
  return undefined;
}

function peerIp(c: Context<AuthEnv>): string | undefined {
  const rawIp = c.env?.ip;
  if (rawIp === undefined) return undefined;
  return normalizeIp(rawIp) ?? rawIp;
}

/** Loopback real OU CIDR em GATEWAY_TRUSTED_CIDRS (host / compose interno). */
export function isHostSide(ip: string | undefined, trustedCidrs: string[]): boolean {
  if (ip === undefined) return false;
  if (LOOPBACK_IPS.has(ip)) return true;
  return ipInAnyCidr(ip, trustedCidrs);
}

/**
 * HTTPS efetivo via proxy TLS (a stack não termina SSL). Aceita o primeiro
 * valor de `X-Forwarded-Proto` ou `Forwarded: proto=https`.
 */
export function isForwardedHttps(c: Context<AuthEnv>): boolean {
  const xfp = c.req.header("x-forwarded-proto");
  if (xfp !== undefined) {
    const first = xfp.split(",")[0]?.trim().toLowerCase();
    if (first === "https") return true;
  }
  const forwarded = c.req.header("forwarded");
  if (forwarded !== undefined) {
    // RFC 7239: Forwarded: for=…;proto=https;by=…
    for (const part of forwarded.split(",")) {
      const m = /(?:^|;)\s*proto\s*=\s*"?(https)"?/i.exec(part);
      if (m) return true;
    }
  }
  return false;
}

function httpsAllowedForExternal(
  c: Context<AuthEnv>,
  ip: string | undefined,
  trustedProxies: string[],
): boolean {
  if (!isForwardedHttps(c)) return false;
  // Sem lista de proxies: confia no header (documentar spoof se :11434 estiver
  // exposto na LAN). Com lista: só o proxy pode afirmar HTTPS.
  if (trustedProxies.length === 0) return true;
  return ip !== undefined && ipInAnyCidr(ip, trustedProxies);
}

/**
 * Auth do gateway:
 * 1. **Host-side** (loopback + `GATEWAY_TRUSTED_CIDRS`): HTTP ok; sem chave
 *    injeta `defaultKey`; com `mnfst_*` valida no Manifest.
 * 2. **Fora do host**: exige HTTPS via proxy (`X-Forwarded-Proto: https`,
 *    opcionalmente só de `GATEWAY_TRUSTED_PROXIES`) **e** chave `mnfst_*`
 *    válida. Sem SSL nativo — o proxy termina TLS.
 */
export function createAuthMiddleware(opts: AuthMiddlewareOpts) {
  return async (c: Context<AuthEnv>, next: Next) => {
    const ip = peerIp(c);
    const hostSide = isHostSide(ip, opts.trustedCidrs);

    if (!hostSide && !httpsAllowedForExternal(c, ip, opts.trustedProxies)) {
      c.set("authValidate", "reject_http");
      return c.json(
        {
          error: {
            message:
              "External callers must use HTTPS via a TLS-terminating proxy that sets X-Forwarded-Proto: https. Direct HTTP is only allowed from the host (loopback / GATEWAY_TRUSTED_CIDRS).",
            type: "auth_error",
            code: "gateway_https_required",
          },
        },
        403,
      );
    }

    const key = extractManifestKey(c);
    if (key !== undefined) {
      const verdict = await opts.validateKey(key);
      if (verdict === "valid") {
        c.set("authValidate", "pass");
        await next();
        return;
      }
      if (verdict === "invalid") {
        c.set("authValidate", "reject");
        return c.json(
          {
            error: {
              message:
                "Manifest key rejected (unknown, rotated, expired, or deleted). Get a current mnfst_ key from the Manifest dashboard.",
              type: "auth_error",
              code: "gateway_auth_invalid_key",
            },
          },
          401,
        );
      }
      c.set("authValidate", "unavailable");
      return c.json(
        {
          error: {
            message:
              "Could not validate manifest key: Manifest upstream unreachable or returned an unexpected status.",
            type: "auth_error",
            code: "gateway_auth_unavailable",
          },
        },
        503,
      );
    }

    if (!hostSide) {
      c.set("authValidate", "reject_anon");
      return c.json(
        {
          error: {
            message:
              "No manifest key (mnfst_*) in Authorization/x-api-key (missing or non-manifest credential). Callers outside the host must present a valid key.",
            type: "auth_error",
            code: "gateway_auth",
          },
        },
        401,
      );
    }

    c.set("authValidate", "injected_host");
    c.set("injectedAuthHeader", `Bearer ${opts.defaultKey}`);
    await next();
  };
}
