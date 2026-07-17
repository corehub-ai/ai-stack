import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { type AuthEnv, createAuthMiddleware } from "../src/auth.js";
import type { GatewayConfig } from "../src/config.js";
import { registerOpenAiRoutes } from "../src/routes/openai.js";
import { testAuthOpts } from "./support/key-validator.js";
import { startMockUpstream } from "./support/mock-upstream.js";

function buildApp(headroomUrl: string) {
  const config: GatewayConfig = {
    port: 0,
    headroomUrl,
    manifestUrl: "http://unused:2099",
    trustedCidrs: [],
    trustedProxies: [],
    defaultKey: "mnfst_default",
    corsOrigins: [],
    ollamaVersion: "0.31.1",
    ollamaDefaultKey: "mnfst_default",
  };
  const app = new Hono<AuthEnv>();
  app.use("*", createAuthMiddleware(testAuthOpts(config.defaultKey)));
  registerOpenAiRoutes(app, config);
  return app;
}

describe("OpenAI passthrough routes", () => {
  it("proxies a non-streaming chat.completions response byte-for-byte", async () => {
    const upstream = startMockUpstream("chat-completions-nonstream");
    try {
      const app = buildApp(upstream.url);
      const res = await app.request(
        "/v1/chat/completions",
        {
          method: "POST",
          headers: { authorization: "Bearer mnfst_opencode", "content-type": "application/json" },
          body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] }),
        },
        { ip: "127.0.0.1" },
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("x-manifest-model")).toBe("qwen2.5:0.5b");
      const body = (await res.json()) as { object: string };
      expect(body.object).toBe("chat.completion");
    } finally {
      upstream.stop();
    }
  });

  it("proxies a streaming SSE response with headers and terminator intact", async () => {
    const upstream = startMockUpstream("chat-completions-stream");
    try {
      const app = buildApp(upstream.url);
      const res = await app.request(
        "/v1/chat/completions",
        {
          method: "POST",
          headers: { authorization: "Bearer mnfst_opencode", "content-type": "application/json" },
          body: JSON.stringify({
            model: "auto",
            stream: true,
            messages: [{ role: "user", content: "hi" }],
          }),
        },
        { ip: "127.0.0.1" },
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const text = await res.text();
      expect(text.trim().endsWith("data: [DONE]")).toBe(true);
    } finally {
      upstream.stop();
    }
  });

  it("proxies GET /v1/models", async () => {
    const upstream = startMockUpstream("models");
    try {
      const app = buildApp(upstream.url);
      const res = await app.request(
        "/v1/models",
        { headers: { authorization: "Bearer mnfst_opencode" } },
        { ip: "127.0.0.1" },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Array<{ id: string }> };
      expect(body.data[0]?.id).toBe("auto");
    } finally {
      upstream.stop();
    }
  });

  it("injects the default key when an untrusted-CIDR caller has none", async () => {
    const upstream = startMockUpstream("models");
    try {
      const app = buildApp(upstream.url);
      const okRes = await app.request("/v1/models", {}, { ip: "127.0.0.1" });
      expect(okRes.status).toBe(200);
    } finally {
      upstream.stop();
    }
  });

  it("returns manifest's 401 body untouched when the upstream itself rejects (bad key case)", async () => {
    const upstream = startMockUpstream("unauthenticated");
    try {
      const app = buildApp(upstream.url);
      const res = await app.request(
        "/v1/models",
        { headers: { authorization: "Bearer mnfst_invalid" } },
        { ip: "127.0.0.1" },
      );
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("manifest_auth");
    } finally {
      upstream.stop();
    }
  });
});
