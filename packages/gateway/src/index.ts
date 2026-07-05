import { Hono } from "hono";
import { cors } from "hono/cors";
import { type AuthEnv, createAuthMiddleware } from "./auth.js";
import { type GatewayConfig, loadConfig } from "./config.js";
import { createRequestLog, defaultLogger, type GatewayLogger } from "./request-log.js";
import { registerAnthropicRoutes } from "./routes/anthropic.js";
import { registerHealthRoute } from "./routes/health.js";
import { registerOllamaRoutes } from "./routes/ollama.js";
import { registerOpenAiRoutes } from "./routes/openai.js";

export function buildApp(
  config: GatewayConfig,
  logger: GatewayLogger = defaultLogger,
): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  // Antes de tudo (inclusive do auth middleware) pra logar também os 401.
  app.use("*", createRequestLog(logger));

  if (config.corsOrigins.length > 0) {
    app.use("*", cors({ origin: config.corsOrigins }));
  }

  registerHealthRoute(app, config);

  app.use("/v1/*", createAuthMiddleware(config));
  registerOpenAiRoutes(app, config);
  registerAnthropicRoutes(app, config);

  // Inferência Ollama usa a mesma lógica de auth do /v1/*, mas com um
  // defaultKey próprio (config.ollamaDefaultKey) -- dá identidade dedicada no
  // manifest pro caller anônimo/confiável da façade Ollama, sem afetar quem já
  // manda sua própria credencial (spec 2026-07-05-ollama-facade-harness).
  // Discovery (GET /, /api/version, /api/tags, /api/show) fica sem auth
  // (Ollama real não tem).
  const ollamaAuth = createAuthMiddleware({
    trustedCidrs: config.trustedCidrs,
    defaultKey: config.ollamaDefaultKey,
  });
  app.use("/api/chat", ollamaAuth);
  app.use("/api/generate", ollamaAuth);
  registerOllamaRoutes(app, config);

  return app;
}

if (import.meta.main) {
  const config = loadConfig();
  const app = buildApp(config);

  Bun.serve({
    port: config.port,
    // Máximo do Bun (255s). O default (10s) mata a conexão em qualquer
    // silêncio de 10s — e requests de LLM ficam mudos por mais que isso
    // (time-to-first-token de contexto grande + compressão do headroom),
    // cortando o stream no meio ("Connection closed mid-response" no Claude
    // Code, visto 2026-07-04). NÃO usar 0 (desabilitado): a LAN não é
    // confiável neste gateway (ver GATEWAY_TRUSTED_CIDRS) e sem timeout
    // qualquer peer segura sockets pra sempre (slowloris).
    idleTimeout: 255,
    fetch(req, server) {
      const ip = server.requestIP(req)?.address;
      return app.fetch(req, { ip });
    },
  });

  console.log(`corehub gateway listening on :${config.port} (headroom=${config.headroomUrl})`);
}
