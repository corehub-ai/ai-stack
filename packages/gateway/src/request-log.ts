import type { MiddlewareHandler } from "hono";
import type { AuthEnv } from "./auth.js";
import { normalizeIp } from "./cidr.js";

export type GatewayLogger = (entry: Record<string, unknown>) => void;

export const defaultLogger: GatewayLogger = (entry) => console.log(JSON.stringify(entry));

// Healthcheck do compose bate a cada 10s -- logar isso é só ruído.
const SKIPPED_PATHS = new Set(["/health"]);

// Paths caros (/v1 inferência + Anthropic): logar o START ajuda a distinguir
// "cliente nunca chegou" (ex.: Cursor BYOK bloqueado por SSRF em localhost)
// de "chegou e travou/erroou rio acima". Discovery Ollama (/api/tags, …) é
// alta frequência e fica só no log de conclusão.
const START_LOG_PATHS = new Set([
  "/v1/chat/completions",
  "/v1/responses",
  "/v1/messages",
  "/api/chat",
  "/api/generate",
]);

const RATE_LIMIT_HEADERS = [
  "retry-after",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
] as const;

/** Extrai type/code de erro OpenAI/Anthropic sem logar `message` (pode vazar prompt). */
export async function extractErrorMeta(
  res: Response,
): Promise<{ errorType?: string; errorCode?: string }> {
  if (res.status < 400) return {};
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("json")) return {};
  try {
    const text = await res.clone().text();
    if (text.length === 0 || text.length > 8192) return {};
    const body: unknown = JSON.parse(text);
    if (body === null || typeof body !== "object") return {};
    const root = body as Record<string, unknown>;
    const err = root.error;
    const src = err !== null && typeof err === "object" ? (err as Record<string, unknown>) : root;
    const out: { errorType?: string; errorCode?: string } = {};
    if (typeof src.type === "string") out.errorType = src.type.slice(0, 80);
    if (typeof src.code === "string") out.errorCode = src.code.slice(0, 80);
    else if (typeof src.code === "number") out.errorCode = String(src.code);
    return out;
  } catch {
    return {};
  }
}

/**
 * Log estruturado, content-free, de toda request que passa pelo gateway.
 * O ponto central é a ORIGEM da credencial (cliente vs injetada) e se ela tem
 * o formato de chave do manifest (`mnfst_`) -- exatamente o que o erro M003
 * do manifest acusa (achado 2026-07-05: cliente Ollama-native recebendo M003
 * sem nenhum rastro nos logs da cadeia). O valor da credencial NUNCA é logado.
 *
 * Em 4xx/5xx também captura `errorType`/`errorCode` do JSON (sem `message`) e
 * headers de rate-limit -- pra distinguir 429 real do stack vs UI enganosa
 * (Cursor "User Provided API Key Rate Limit Exceeded" sem request no gateway).
 */
export function createRequestLog(logger: GatewayLogger): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const path = new URL(c.req.url).pathname;
    if (SKIPPED_PATHS.has(path)) {
      await next();
      return;
    }

    const rawIp = c.env?.ip;
    const clientIp = rawIp !== undefined ? (normalizeIp(rawIp) ?? rawIp) : undefined;
    const ua = c.req.header("user-agent");

    if (START_LOG_PATHS.has(path)) {
      const start: Record<string, unknown> = {
        event: "gateway.request.start",
        method: c.req.method,
        path,
      };
      if (clientIp !== undefined) start.clientIp = clientIp;
      if (ua !== undefined) start.ua = ua.slice(0, 80);
      logger(start);
    }

    const startedAt = performance.now();
    await next();

    const entry: Record<string, unknown> = {
      event: "gateway.request",
      method: c.req.method,
      path,
      status: c.res.status,
      // pra respostas streaming, mede até o início da resposta (headers), não
      // até o fim do stream
      latencyMs: Math.round(performance.now() - startedAt),
    };
    if (clientIp !== undefined) entry.clientIp = clientIp;

    // Diagnóstico content-free via headers (sem consumir o body): quem é o
    // cliente (user-agent -- Copilot vs Claude Code vs curl), tamanho da
    // request, e o tier pedido -- pra correlacionar quais requests falham.
    if (ua !== undefined) entry.ua = ua.slice(0, 80);
    const contentLength = c.req.header("content-length");
    if (contentLength !== undefined) {
      const bytes = Number(contentLength);
      if (Number.isFinite(bytes)) entry.reqBytes = bytes;
    }
    const tier = c.req.header("x-manifest-tier");
    if (tier !== undefined) entry.tier = tier;

    const respCt = c.res.headers.get("content-type");
    if (respCt) {
      entry.respContentType = (respCt.split(";")[0] ?? "").trim().slice(0, 80);
      if (respCt.includes("text/event-stream")) entry.stream = true;
    }

    if (c.res.status >= 400) {
      for (const name of RATE_LIMIT_HEADERS) {
        const v = c.res.headers.get(name);
        if (v) entry[name] = v.slice(0, 40);
      }
      const meta = await extractErrorMeta(c.res);
      if (meta.errorType !== undefined) entry.errorType = meta.errorType;
      if (meta.errorCode !== undefined) entry.errorCode = meta.errorCode;
    }

    // Shape da credencial que o CLIENTE apresentou (se alguma) -- fica no log
    // mesmo quando o gateway a substitui pela injetada.
    const authorization = c.req.header("authorization");
    const apiKey = c.req.header("x-api-key");
    if (authorization !== undefined) {
      entry.authHeader = "authorization";
      entry.manifestKeyShape = /^Bearer mnfst_/.test(authorization);
    } else if (apiKey !== undefined) {
      entry.authHeader = "x-api-key";
      entry.manifestKeyShape = apiKey.startsWith("mnfst_");
    }

    // O que foi de fato rio acima: injetado (anônimo confiável OU credencial
    // não-mnfst substituída), a credencial do cliente, ou nada (401 aqui).
    if (c.get("injectedAuthHeader") !== undefined) {
      entry.auth = "injected-default";
    } else if (authorization !== undefined || apiKey !== undefined) {
      entry.auth = "client";
    } else {
      entry.auth = "anonymous";
    }

    const authValidate = c.get("authValidate");
    if (authValidate !== undefined) entry.authValidate = authValidate;

    logger(entry);
  };
}
