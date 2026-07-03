import type { Context, Hono } from "hono";
import { proxy } from "hono/proxy";
import type { AuthEnv } from "../auth.js";
import type { GatewayConfig } from "../config.js";

function proxyHeaders(c: Context<AuthEnv>): Record<string, string> {
  const injected = c.get("injectedAuthHeader");
  const headers: Record<string, string> = { ...c.req.header() };
  delete headers.host;
  if (injected) headers.authorization = injected;
  return headers;
}

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
