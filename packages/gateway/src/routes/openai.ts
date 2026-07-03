import type { Hono } from "hono";
import { proxy } from "hono/proxy";
import type { AuthEnv } from "../auth.js";
import type { GatewayConfig } from "../config.js";
import { proxyHeaders } from "../proxy-headers.js";

export function registerOpenAiRoutes(app: Hono<AuthEnv>, config: GatewayConfig): void {
  app.post("/v1/chat/completions", (c) =>
    proxy(`${config.headroomUrl}/v1/chat/completions`, {
      ...c.req,
      headers: proxyHeaders(c),
    }),
  );

  app.post("/v1/responses", (c) =>
    proxy(`${config.headroomUrl}/v1/responses`, {
      ...c.req,
      headers: proxyHeaders(c),
    }),
  );

  app.get("/v1/models", (c) =>
    proxy(`${config.headroomUrl}/v1/models`, {
      ...c.req,
      headers: proxyHeaders(c),
    }),
  );
}
