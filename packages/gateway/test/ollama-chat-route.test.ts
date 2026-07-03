import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { type AuthEnv, createAuthMiddleware } from "../src/auth.js";
import type { GatewayConfig } from "../src/config.js";
import { registerOllamaRoutes } from "../src/routes/ollama.js";
import { startMockUpstream } from "./support/mock-upstream.js";

function buildApp(headroomUrl: string) {
  const config: GatewayConfig = {
    port: 0,
    headroomUrl,
    manifestUrl: "http://unused:2099",
    trustedCidrs: [],
    defaultKey: "mnfst_default",
    corsOrigins: [],
    ollamaVersion: "0.31.1",
  };
  const app = new Hono<AuthEnv>();
  app.use("/api/chat", createAuthMiddleware(config));
  app.use("/api/generate", createAuthMiddleware(config));
  registerOllamaRoutes(app, config);
  return app;
}

describe("POST /api/chat", () => {
  it("translates the OpenAI SSE stream into Ollama NDJSON terminated by done:true", async () => {
    const upstream = startMockUpstream("chat-completions-stream");
    try {
      const app = buildApp(upstream.url);
      const res = await app.request(
        "/api/chat",
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
      expect(res.headers.get("content-type")).toContain("application/x-ndjson");
      const text = await res.text();
      const lines = text.trim().split("\n").filter(Boolean);
      const last = JSON.parse(lines[lines.length - 1] ?? "{}") as {
        done: boolean;
        message: { role: string };
      };
      expect(last.done).toBe(true);
      expect(last.message.role).toBe("assistant");
      // nenhuma linha tem prefixo data: nem sentinela [DONE]
      expect(text.includes("data:")).toBe(false);
      expect(text.includes("[DONE]")).toBe(false);
    } finally {
      upstream.stop();
    }
  });

  it("401s a credential-less caller from outside the trusted set", async () => {
    const upstream = startMockUpstream("chat-completions-stream");
    try {
      const app = buildApp(upstream.url);
      const res = await app.request(
        "/api/chat",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] }),
        },
        { ip: "203.0.113.9" },
      );
      expect(res.status).toBe(401);
    } finally {
      upstream.stop();
    }
  });
});
