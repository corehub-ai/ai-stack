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

export function registerAnthropicRoutes(app: Hono<AuthEnv>, config: GatewayConfig): void {
  app.post("/v1/messages", (c) =>
    proxy(`${config.headroomUrl}/v1/messages`, {
      ...c.req,
      headers: proxyHeaders(c),
    }),
  );

  app.post("/v1/messages/count_tokens", (c) =>
    proxy(`${config.headroomUrl}/v1/messages/count_tokens`, {
      ...c.req,
      headers: proxyHeaders(c),
    }),
  );
}
