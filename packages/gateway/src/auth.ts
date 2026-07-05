import type { Context, Next } from "hono";
import { ipInAnyCidr, normalizeIp } from "./cidr.js";

export type AuthEnv = {
  Bindings: { ip?: string };
  Variables: { injectedAuthHeader?: string };
};

const LOOPBACK_IPS = new Set(["127.0.0.1", "::1"]);

// Só credencial com formato de chave do manifest merece passar adiante: o
// manifest é o único upstream e rejeita qualquer outra coisa com M003 ("keys
// start with mnfst_") -- que ainda volta embrulhado num 200 pelo headroom,
// virando um erro indecifrável no cliente. Caso concreto (2026-07-05): o
// GitHub Copilot manda o token GitHub dele no Authorization. Tratar
// não-mnfst como "sem credencial" é estritamente melhor que repassar.
function presentsManifestKey(c: Context<AuthEnv>): boolean {
  if (c.req.header("authorization")?.startsWith("Bearer mnfst_")) return true;
  return c.req.header("x-api-key")?.startsWith("mnfst_") ?? false;
}

export function createAuthMiddleware(opts: { trustedCidrs: string[]; defaultKey: string }) {
  return async (c: Context<AuthEnv>, next: Next) => {
    if (presentsManifestKey(c)) {
      await next();
      return;
    }

    const rawIp = c.env?.ip;
    const ip = rawIp !== undefined ? normalizeIp(rawIp) : undefined;
    const trusted =
      ip !== undefined && (LOOPBACK_IPS.has(ip) || ipInAnyCidr(ip, opts.trustedCidrs));
    if (!trusted) {
      return c.json(
        {
          error: {
            message:
              "No manifest key (mnfst_*) in Authorization/x-api-key (missing or non-manifest credential), and the caller is not loopback or in GATEWAY_TRUSTED_CIDRS.",
            type: "auth_error",
            code: "gateway_auth",
          },
        },
        401,
      );
    }

    c.set("injectedAuthHeader", `Bearer ${opts.defaultKey}`);
    await next();
  };
}
