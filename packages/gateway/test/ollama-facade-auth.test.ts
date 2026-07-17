import { describe, expect, it } from "bun:test";
import { loadConfig } from "../src/config.js";
import { buildApp } from "../src/index.js";
import { acceptAllKeys } from "./support/key-validator.js";

const NONSTREAM_BODY = {
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 1783058585,
  model: "auto",
  choices: [{ index: 0, message: { role: "assistant", content: "oi" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

function startCapturingUpstream() {
  const seenAuthorizations: Array<string | null> = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      seenAuthorizations.push(req.headers.get("authorization"));
      return Response.json(NONSTREAM_BODY);
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    seenAuthorizations,
    stop: () => server.stop(true),
  };
}

function chatRequest(app: ReturnType<typeof buildApp>, headers: Record<string, string> = {}) {
  return app.request(
    "/api/chat",
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "oi" }] }),
    },
    { ip: "127.0.0.1" },
  );
}

function appFor(env: Record<string, string>) {
  return buildApp(loadConfig(env), undefined, { validateKey: acceptAllKeys });
}

describe("Ollama facade auth (GATEWAY_OLLAMA_DEFAULT_KEY)", () => {
  it("injects the ollama-facade default key for an anonymous/trusted caller on /api/chat", async () => {
    const upstream = startCapturingUpstream();
    try {
      const app = appFor({
        HEADROOM_URL: upstream.url,
        GATEWAY_DEFAULT_KEY: "mnfst_lan_anon",
        GATEWAY_OLLAMA_DEFAULT_KEY: "mnfst_ollama_facade",
      });
      const res = await chatRequest(app);
      expect(res.status).toBe(200);
      expect(upstream.seenAuthorizations).toEqual(["Bearer mnfst_ollama_facade"]);
    } finally {
      upstream.stop();
    }
  });

  it("falls back to GATEWAY_DEFAULT_KEY on /api/chat when GATEWAY_OLLAMA_DEFAULT_KEY is unset", async () => {
    const upstream = startCapturingUpstream();
    try {
      const app = appFor({ HEADROOM_URL: upstream.url, GATEWAY_DEFAULT_KEY: "mnfst_lan_anon" });
      const res = await chatRequest(app);
      expect(res.status).toBe(200);
      expect(upstream.seenAuthorizations).toEqual(["Bearer mnfst_lan_anon"]);
    } finally {
      upstream.stop();
    }
  });

  it("preserves a caller's own credential on /api/chat -- ollamaDefaultKey is never used", async () => {
    const upstream = startCapturingUpstream();
    try {
      const app = appFor({
        HEADROOM_URL: upstream.url,
        GATEWAY_DEFAULT_KEY: "mnfst_lan_anon",
        GATEWAY_OLLAMA_DEFAULT_KEY: "mnfst_ollama_facade",
      });
      const res = await chatRequest(app, { authorization: "Bearer mnfst_own_credential" });
      expect(res.status).toBe(200);
      expect(upstream.seenAuthorizations).toEqual(["Bearer mnfst_own_credential"]);
    } finally {
      upstream.stop();
    }
  });

  it("still uses GATEWAY_DEFAULT_KEY (not ollamaDefaultKey) for /v1/chat/completions", async () => {
    const upstream = startCapturingUpstream();
    try {
      const app = appFor({
        HEADROOM_URL: upstream.url,
        GATEWAY_DEFAULT_KEY: "mnfst_lan_anon",
        GATEWAY_OLLAMA_DEFAULT_KEY: "mnfst_ollama_facade",
      });
      const res = await app.request(
        "/v1/chat/completions",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "oi" }] }),
        },
        { ip: "127.0.0.1" },
      );
      expect(res.status).toBe(200);
      expect(upstream.seenAuthorizations).toEqual(["Bearer mnfst_lan_anon"]);
    } finally {
      upstream.stop();
    }
  });
});
