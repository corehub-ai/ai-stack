import type { MiddlewareHandler } from "hono";
import type { AuthEnv } from "./auth.js";

export type GatewayLogger = (entry: Record<string, unknown>) => void;

export const defaultLogger: GatewayLogger = (entry) => console.log(JSON.stringify(entry));

// Healthcheck do compose bate a cada 10s -- logar isso é só ruído.
const SKIPPED_PATHS = new Set(["/health"]);

/**
 * Log estruturado, content-free, de toda request que passa pelo gateway.
 * O ponto central é a ORIGEM da credencial (cliente vs injetada) e se ela tem
 * o formato de chave do manifest (`mnfst_`) -- exatamente o que o erro M003
 * do manifest acusa (achado 2026-07-05: cliente Ollama-native recebendo M003
 * sem nenhum rastro nos logs da cadeia). O valor da credencial NUNCA é logado.
 */
export function createRequestLog(logger: GatewayLogger): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const path = new URL(c.req.url).pathname;
    if (SKIPPED_PATHS.has(path)) {
      await next();
      return;
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

    logger(entry);
  };
}
