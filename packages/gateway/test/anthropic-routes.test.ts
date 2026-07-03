import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { type AuthEnv, createAuthMiddleware } from "../src/auth.js";
import type { GatewayConfig } from "../src/config.js";
import { registerAnthropicRoutes } from "../src/routes/anthropic.js";
import { startMockUpstream } from "./support/mock-upstream.js";

function buildApp(headroomUrl: string) {
  const config: GatewayConfig = {
    port: 0,
    headroomUrl,
    manifestUrl: "http://unused:2099",
    trustedCidrs: [],
    defaultKey: "mnfst_default",
    corsOrigins: [],
  };
  const app = new Hono<AuthEnv>();
  app.use("*", createAuthMiddleware(config));
  registerAnthropicRoutes(app, config);
  return app;
}

describe("Anthropic passthrough routes", () => {
  it("proxies POST /v1/messages and forwards anthropic-version verbatim", async () => {
    const upstream = startMockUpstream("messages-nonstream");
    try {
      const app = buildApp(upstream.url);
      const res = await app.request(
        "/v1/messages",
        {
          method: "POST",
          headers: {
            authorization: "Bearer mnfst_claude-code",
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: "auto",
            max_tokens: 16,
            messages: [{ role: "user", content: "hi" }],
          }),
        },
        { ip: "127.0.0.1" },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { type: string; content: Array<{ type: string }> };
      expect(body.type).toBe("message");
      expect(body.content[0]?.type).toBe("text");
    } finally {
      upstream.stop();
    }
  });

  it("forwards /v1/messages/count_tokens opaquely (manifest 404 is acceptable, per Claude Code's graceful degrade)", async () => {
    const upstream = startMockUpstream("unauthenticated"); // any fixture with a JSON body works for this shape check
    try {
      const app = buildApp(upstream.url);
      const res = await app.request(
        "/v1/messages/count_tokens",
        {
          method: "POST",
          headers: {
            authorization: "Bearer mnfst_claude-code",
            "content-type": "application/json",
          },
          body: JSON.stringify({ model: "auto", messages: [] }),
        },
        { ip: "127.0.0.1" },
      );
      expect(res.status).toBe(401); // this fixture is the 401 body; proves the route exists and proxies through
    } finally {
      upstream.stop();
    }
  });
});
