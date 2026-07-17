import { describe, expect, it } from "bun:test";
import { loadConfig } from "../src/config.js";
import { buildApp } from "../src/index.js";
import { extractErrorMeta } from "../src/request-log.js";
import { acceptAllKeys } from "./support/key-validator.js";

function startOkUpstream() {
  const server = Bun.serve({
    port: 0,
    fetch: () => Response.json({ ok: true }),
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

function startErrorUpstream(status: number, body: unknown, headers?: Record<string, string>) {
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", ...headers },
      }),
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
    { validateKey: acceptAllKeys },
  );
  return { app, logs };
}

function doneLog(logs: Record<string, unknown>[]) {
  return logs.find((e) => e.event === "gateway.request");
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
      expect(logs[0]).toMatchObject({
        event: "gateway.request.start",
        path: "/v1/chat/completions",
        clientIp: "127.0.0.1",
      });
      expect(doneLog(logs)).toMatchObject({
        event: "gateway.request",
        method: "POST",
        path: "/v1/chat/completions",
        status: 200,
        auth: "injected-default",
        clientIp: "127.0.0.1",
      });
      expect(typeof doneLog(logs)?.latencyMs).toBe("number");
    } finally {
      upstream.stop();
    }
  });

  it("logs client identity (ua), request size (reqBytes), and tier from headers", async () => {
    const upstream = startOkUpstream();
    try {
      const { app, logs } = appWithLogs(upstream.url);
      await app.request(
        "/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "user-agent": "GitHubCopilotChat/0.55.0",
            "content-length": String(CHAT_BODY.length),
            "x-manifest-tier": "reasoning",
            authorization: "Bearer mnfst_x",
          },
          body: CHAT_BODY,
        },
        { ip: "127.0.0.1" },
      );
      expect(doneLog(logs)).toMatchObject({
        event: "gateway.request",
        ua: "GitHubCopilotChat/0.55.0",
        reqBytes: CHAT_BODY.length,
        tier: "reasoning",
      });
    } finally {
      upstream.stop();
    }
  });

  it("logs a client credential without a manifest-key shape (never the value itself)", async () => {
    const upstream = startOkUpstream();
    try {
      const { app, logs } = appWithLogs(upstream.url);
      const res = await app.request(
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
      // Fora do host-side sem X-Forwarded-Proto → HTTPS obrigatório (antes da auth de chave).
      expect(res.status).toBe(403);
      expect(doneLog(logs)).toMatchObject({
        event: "gateway.request",
        path: "/api/chat",
        auth: "client",
        authHeader: "authorization",
        manifestKeyShape: false,
        authValidate: "reject_http",
        errorCode: "gateway_https_required",
      });
      expect(JSON.stringify(logs)).not.toContain("ghu_copilot_token");
    } finally {
      upstream.stop();
    }
  });

  it("logs injected-default (com a shape da credencial original) quando um caller confiável manda credencial não-mnfst", async () => {
    const upstream = startOkUpstream();
    try {
      const { app, logs } = appWithLogs(upstream.url);
      const res = await app.request(
        "/api/chat",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer ghu_copilot_token",
          },
          body: CHAT_BODY,
        },
        { ip: "127.0.0.1" },
      );
      expect(res.status).toBe(200);
      expect(doneLog(logs)).toMatchObject({
        auth: "injected-default",
        authHeader: "authorization",
        manifestKeyShape: false,
        status: 200,
        authValidate: "injected_host",
      });
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
          headers: {
            "content-type": "application/json",
            authorization: "Bearer mnfst_real_key",
            "x-forwarded-proto": "https",
          },
          body: CHAT_BODY,
        },
        { ip: "172.28.1.1" },
      );
      expect(doneLog(logs)).toMatchObject({
        auth: "client",
        authValidate: "pass",
        manifestKeyShape: true,
      });
    } finally {
      upstream.stop();
    }
  });

  it("logs a rejected external caller with status 403 when HTTPS is missing", async () => {
    const upstream = startOkUpstream();
    try {
      const { app, logs } = appWithLogs(upstream.url);
      const res = await app.request(
        "/api/chat",
        { method: "POST", headers: { "content-type": "application/json" }, body: CHAT_BODY },
        { ip: "203.0.113.9" },
      );
      expect(res.status).toBe(403);
      expect(doneLog(logs)).toMatchObject({
        path: "/api/chat",
        status: 403,
        auth: "anonymous",
        errorType: "auth_error",
        errorCode: "gateway_https_required",
        authValidate: "reject_http",
        clientIp: "203.0.113.9",
      });
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
      const res = await app.request(
        "/v1/chat/completions",
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": "sk-something-else" },
          body: CHAT_BODY,
        },
        { ip: "172.28.1.1" },
      );
      expect(res.status).toBe(403);
      expect(doneLog(logs)).toMatchObject({
        auth: "client",
        authHeader: "x-api-key",
        manifestKeyShape: false,
        authValidate: "reject_http",
      });
    } finally {
      upstream.stop();
    }
  });

  it("logs OpenAI error type/code and rate-limit headers on upstream 429 (never the message)", async () => {
    const upstream = startErrorUpstream(
      429,
      {
        error: {
          message: "SECRET_PROMPT_FRAGMENT should not leak",
          type: "rate_limit_error",
          code: "rate_limit_exceeded",
        },
      },
      { "retry-after": "12", "x-ratelimit-remaining": "0" },
    );
    try {
      const { app, logs } = appWithLogs(upstream.url);
      const res = await app.request(
        "/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer mnfst_x",
          },
          body: CHAT_BODY,
        },
        { ip: "127.0.0.1" },
      );
      expect(res.status).toBe(429);
      expect(doneLog(logs)).toMatchObject({
        status: 429,
        errorType: "rate_limit_error",
        errorCode: "rate_limit_exceeded",
        "retry-after": "12",
        "x-ratelimit-remaining": "0",
      });
      expect(JSON.stringify(logs)).not.toContain("SECRET_PROMPT_FRAGMENT");
    } finally {
      upstream.stop();
    }
  });
});

describe("extractErrorMeta", () => {
  it("returns empty for 2xx", async () => {
    expect(await extractErrorMeta(Response.json({ ok: true }))).toEqual({});
  });

  it("reads Anthropic-style top-level type when error object is absent", async () => {
    const res = new Response(JSON.stringify({ type: "overloaded_error", message: "busy" }), {
      status: 529,
      headers: { "content-type": "application/json" },
    });
    expect(await extractErrorMeta(res)).toEqual({ errorType: "overloaded_error" });
  });
});
