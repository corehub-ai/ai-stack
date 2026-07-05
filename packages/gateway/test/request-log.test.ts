import { describe, expect, it } from "bun:test";
import { loadConfig } from "../src/config.js";
import { buildApp } from "../src/index.js";

function startOkUpstream() {
  const server = Bun.serve({
    port: 0,
    fetch: () => Response.json({ ok: true }),
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

function appWithLogs(headroomUrl: string) {
  const logs: Record<string, unknown>[] = [];
  const app = buildApp(
    loadConfig({
      HEADROOM_URL: headroomUrl,
      GATEWAY_DEFAULT_KEY: "mnfst_lan_anon",
      GATEWAY_OLLAMA_DEFAULT_KEY: "mnfst_ollama_facade",
    }),
    (entry) => logs.push(entry),
  );
  return { app, logs };
}

const CHAT_BODY = JSON.stringify({ model: "auto", messages: [{ role: "user", content: "oi" }] });

describe("gateway request log", () => {
  it("logs an injected-default entry for an anonymous/trusted caller", async () => {
    const upstream = startOkUpstream();
    try {
      const { app, logs } = appWithLogs(upstream.url);
      const res = await app.request(
        "/v1/chat/completions",
        { method: "POST", headers: { "content-type": "application/json" }, body: CHAT_BODY },
        { ip: "127.0.0.1" },
      );
      expect(res.status).toBe(200);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        event: "gateway.request",
        method: "POST",
        path: "/v1/chat/completions",
        status: 200,
        auth: "injected-default",
      });
      expect(typeof logs[0]?.latencyMs).toBe("number");
    } finally {
      upstream.stop();
    }
  });

  it("logs a client credential without a manifest-key shape (never the value itself)", async () => {
    const upstream = startOkUpstream();
    try {
      const { app, logs } = appWithLogs(upstream.url);
      await app.request(
        "/api/chat",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer ghu_copilot_token",
          },
          body: CHAT_BODY,
        },
        { ip: "172.28.1.1" },
      );
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        event: "gateway.request",
        path: "/api/chat",
        auth: "client",
        authHeader: "authorization",
        manifestKeyShape: false,
      });
      // o valor da credencial nunca pode vazar pro log
      expect(JSON.stringify(logs[0])).not.toContain("ghu_copilot_token");
    } finally {
      upstream.stop();
    }
  });

  it("marks manifestKeyShape true for a Bearer mnfst_ credential", async () => {
    const upstream = startOkUpstream();
    try {
      const { app, logs } = appWithLogs(upstream.url);
      await app.request(
        "/api/chat",
        {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer mnfst_real_key" },
          body: CHAT_BODY,
        },
        { ip: "172.28.1.1" },
      );
      expect(logs[0]).toMatchObject({ auth: "client", manifestKeyShape: true });
    } finally {
      upstream.stop();
    }
  });

  it("logs a rejected anonymous caller with status 401 and auth anonymous", async () => {
    const upstream = startOkUpstream();
    try {
      const { app, logs } = appWithLogs(upstream.url);
      const res = await app.request(
        "/api/chat",
        { method: "POST", headers: { "content-type": "application/json" }, body: CHAT_BODY },
        { ip: "203.0.113.9" },
      );
      expect(res.status).toBe(401);
      expect(logs[0]).toMatchObject({ path: "/api/chat", status: 401, auth: "anonymous" });
    } finally {
      upstream.stop();
    }
  });

  it("does not log /health (healthcheck interno a cada 10s viraria spam)", async () => {
    const upstream = startOkUpstream();
    try {
      const { app, logs } = appWithLogs(upstream.url);
      await app.request("/health");
      expect(logs).toHaveLength(0);
    } finally {
      upstream.stop();
    }
  });

  it("logs x-api-key credentials under authHeader x-api-key", async () => {
    const upstream = startOkUpstream();
    try {
      const { app, logs } = appWithLogs(upstream.url);
      await app.request(
        "/v1/chat/completions",
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": "sk-something-else" },
          body: CHAT_BODY,
        },
        { ip: "172.28.1.1" },
      );
      expect(logs[0]).toMatchObject({
        auth: "client",
        authHeader: "x-api-key",
        manifestKeyShape: false,
      });
    } finally {
      upstream.stop();
    }
  });
});
