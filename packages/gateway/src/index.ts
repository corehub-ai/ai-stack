import { Hono } from "hono";
import { cors } from "hono/cors";
import { type AuthEnv, createAuthMiddleware } from "./auth.js";
import { type GatewayConfig, loadConfig } from "./config.js";
import { registerAnthropicRoutes } from "./routes/anthropic.js";
import { registerHealthRoute } from "./routes/health.js";
import { registerOpenAiRoutes } from "./routes/openai.js";

export function buildApp(config: GatewayConfig): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  if (config.corsOrigins.length > 0) {
    app.use("*", cors({ origin: config.corsOrigins }));
  }

  registerHealthRoute(app, config);

  app.use("/v1/*", createAuthMiddleware(config));
  registerOpenAiRoutes(app, config);
  registerAnthropicRoutes(app, config);

  return app;
}

if (import.meta.main) {
  const config = loadConfig();
  const app = buildApp(config);

  Bun.serve({
    port: config.port,
    fetch(req, server) {
      const ip = server.requestIP(req)?.address;
      return app.fetch(req, { ip });
    },
  });

  console.log(`corehub gateway listening on :${config.port} (headroom=${config.headroomUrl})`);
}
