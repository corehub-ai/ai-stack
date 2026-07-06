import { describe, expect, it } from "bun:test";
import type { ClassifierConfig } from "../src/config.js";
import type { ClassifierLogger } from "../src/index.js";
import { buildApp } from "../src/index.js";

const CLASSIFIER_TIER = "tier-classifier-internal";
const silent: ClassifierLogger = () => {};

function baseConfig(manifestUrl: string): ClassifierConfig {
  return {
    port: 0,
    manifestUrl,
    manifestKey: "mnfst_test-classifier",
    tier: CLASSIFIER_TIER,
    timeoutMs: 300,
    coldLoadExtraMs: 1000,
    canonicalize: true,
    canonicalizeBypass: [],
  };
}

type SeenRequest = { path: string; tierHeader: string | null; body: string };

function startMockManifest(classificationLabel: string) {
  const seen: SeenRequest[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.text();
      const tierHeader = req.headers.get("x-manifest-tier");
      const path = new URL(req.url).pathname;
      seen.push({ path, tierHeader, body });
      if (tierHeader === CLASSIFIER_TIER) {
        return Response.json({
          type: "message",
          content: [{ type: "text", text: classificationLabel }],
        });
      }
      return Response.json({ ok: true, receivedTier: tierHeader });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, seen, stop: () => server.stop(true) };
}

describe("tier-classifier proxy", () => {
  it("passes through untouched when x-manifest-tier is already set (no classification call made)", async () => {
    const mock = startMockManifest("simple");
    try {
      const app = buildApp(baseConfig(mock.url), silent);
      const res = await app.request("/v1/messages", {
        method: "POST",
        headers: { "x-manifest-tier": "fable", "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "oi" }] }),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { receivedTier: string };
      expect(json.receivedTier).toBe("fable");
      expect(mock.seen).toHaveLength(1);
    } finally {
      mock.stop();
    }
  });

  it("classifies and sets x-manifest-tier when the request has none", async () => {
    const mock = startMockManifest("complex");
    try {
      const app = buildApp(baseConfig(mock.url), silent);
      const res = await app.request("/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "refatora o módulo de auth inteiro, com testes" }],
        }),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { receivedTier: string };
      expect(json.receivedTier).toBe("complex");
      expect(mock.seen).toHaveLength(2);
    } finally {
      mock.stop();
    }
  });

  it("logs a content-free decision line when classification succeeds", async () => {
    const mock = startMockManifest("complex");
    const logs: Record<string, unknown>[] = [];
    try {
      const app = buildApp(baseConfig(mock.url), (entry) => logs.push(entry));
      await app.request("/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "refatora tudo" }] }),
      });
      const decisions = logs.filter((l) => l.event === "tier-classifier.decision");
      expect(decisions).toHaveLength(1);
      expect(decisions[0]).toMatchObject({
        event: "tier-classifier.decision",
        tier: "complex",
        failOpen: false,
      });
      expect(typeof decisions[0]?.latencyMs).toBe("number");
      expect(decisions[0]?.reason).toBeUndefined();
    } finally {
      mock.stop();
    }
  });

  it("fails open (forwards without a tier header) when classification is unparseable", async () => {
    const mock = startMockManifest("não sei classificar isso");
    try {
      const app = buildApp(baseConfig(mock.url), silent);
      const res = await app.request("/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "oi" }] }),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { receivedTier: string | null };
      expect(json.receivedTier).toBeNull();
    } finally {
      mock.stop();
    }
  });

  it("logs failOpen with a reason when classification is unparseable", async () => {
    const mock = startMockManifest("não sei classificar isso");
    const logs: Record<string, unknown>[] = [];
    try {
      const app = buildApp(baseConfig(mock.url), (entry) => logs.push(entry));
      await app.request("/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "oi" }] }),
      });
      const decisions = logs.filter((l) => l.event === "tier-classifier.decision");
      expect(decisions).toHaveLength(1);
      expect(decisions[0]).toMatchObject({
        event: "tier-classifier.decision",
        tier: null,
        failOpen: true,
        reason: "classification-failed",
        failure: { kind: "invalid-label" },
      });
    } finally {
      mock.stop();
    }
  });

  it("returns 502 when the manifest is unreachable for the real forward", async () => {
    const app = buildApp(
      {
        port: 0,
        manifestUrl: "http://127.0.0.1:1",
        manifestKey: "mnfst_x",
        tier: CLASSIFIER_TIER,
        timeoutMs: 300,
        coldLoadExtraMs: 1000,
        canonicalize: true,
        canonicalizeBypass: [],
      },
      silent,
    );
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "oi" }] }),
    });
    expect(res.status).toBe(502);
  });

  it("GET /health checks manifest reachability (not the classification/proxy path)", async () => {
    const mock = startMockManifest("simple");
    try {
      const app = buildApp(baseConfig(mock.url), silent);
      const res = await app.request("/health");
      expect(res.status).toBe(200);
      const json = (await res.json()) as { status: string };
      expect(json.status).toBe("ok");
    } finally {
      mock.stop();
    }
  });

  it("GET /health reports degraded (503) when manifest is unreachable", async () => {
    const app = buildApp(
      {
        port: 0,
        manifestUrl: "http://127.0.0.1:1",
        manifestKey: "mnfst_x",
        tier: CLASSIFIER_TIER,
        timeoutMs: 300,
        coldLoadExtraMs: 1000,
        canonicalize: true,
        canonicalizeBypass: [],
      },
      silent,
    );
    const res = await app.request("/health");
    expect(res.status).toBe(503);
  });

  it("forwards GET /v1/models untouched (no body, no classification attempted)", async () => {
    const mock = startMockManifest("simple");
    try {
      const app = buildApp(baseConfig(mock.url), silent);
      const res = await app.request("/v1/models");
      expect(res.status).toBe(200);
      expect(mock.seen).toHaveLength(1);
      expect(mock.seen[0]?.tierHeader).toBeNull();
    } finally {
      mock.stop();
    }
  });

  it("strips stale content-encoding/content-length when upstream sent a gzip body (Bun's fetch decompresses it)", async () => {
    const payload = {
      ok: true,
      receivedTier: "fable",
      note: "corpo grande o suficiente para valer a pena comprimir",
    };
    const compressed = Bun.gzipSync(Buffer.from(JSON.stringify(payload)));
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(compressed, {
          headers: {
            "content-type": "application/json",
            "content-encoding": "gzip",
            "content-length": String(compressed.byteLength),
          },
        });
      },
    });
    try {
      const app = buildApp(baseConfig(`http://127.0.0.1:${server.port}`), silent);
      const res = await app.request("/v1/messages", {
        method: "POST",
        headers: { "x-manifest-tier": "fable", "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "oi" }] }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-encoding")).toBeNull();
      expect(res.headers.get("content-length")).not.toBe(String(compressed.byteLength));
      const json = await res.json();
      expect(json).toEqual(payload);
    } finally {
      server.stop(true);
    }
  });

  it("logs a tier-classifier.forward entry with the model the manifest returned (reveals fallback swaps)", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ model: "glm-5.2", choices: [{ message: { content: "ok" } }] }),
    });
    const logs: Record<string, unknown>[] = [];
    try {
      const app = buildApp(baseConfig(`http://127.0.0.1:${server.port}`), (e) => logs.push(e));
      // x-manifest-tier já setado -> sem classificação, só o forward
      const res = await app.request("/v1/messages", {
        method: "POST",
        headers: { "x-manifest-tier": "reasoning", "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "oi" }] }),
      });
      expect(res.status).toBe(200);
      const forwards = logs.filter((l) => l.event === "tier-classifier.forward");
      expect(forwards).toHaveLength(1);
      expect(forwards[0]).toMatchObject({
        event: "tier-classifier.forward",
        path: "/v1/messages",
        status: 200,
        responseModel: "glm-5.2",
      });
    } finally {
      server.stop(true);
    }
  });

  it("logs status + a manifestError snippet when the manifest forward returns non-2xx", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(JSON.stringify({ error: { message: "prompt is too long" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
    });
    const logs: Record<string, unknown>[] = [];
    try {
      const app = buildApp(baseConfig(`http://127.0.0.1:${server.port}`), (e) => logs.push(e));
      const res = await app.request("/v1/messages", {
        method: "POST",
        headers: { "x-manifest-tier": "reasoning", "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "oi" }] }),
      });
      expect(res.status).toBe(400);
      const forwards = logs.filter((l) => l.event === "tier-classifier.forward");
      expect(forwards[0]).toMatchObject({ status: 400 });
      expect(String(forwards[0]?.manifestError)).toContain("prompt is too long");
    } finally {
      server.stop(true);
    }
  });

  it("passes streaming (text/event-stream) responses through untouched and logs streaming:true", async () => {
    const sse = 'data: {"model":"claude-opus-4-8"}\n\ndata: [DONE]\n\n';
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
    });
    const logs: Record<string, unknown>[] = [];
    try {
      const app = buildApp(baseConfig(`http://127.0.0.1:${server.port}`), (e) => logs.push(e));
      const res = await app.request("/v1/messages", {
        method: "POST",
        headers: { "x-manifest-tier": "reasoning", "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "oi" }] }),
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(sse);
      const forwards = logs.filter((l) => l.event === "tier-classifier.forward");
      expect(forwards[0]).toMatchObject({ streaming: true, status: 200 });
      // não bufferiza streaming -> não extrai responseModel
      expect(forwards[0]?.responseModel).toBeUndefined();
    } finally {
      server.stop(true);
    }
  });

  it("strips temperature/top_p/top_k/thinking from the forwarded body and logs the stripped keys", async () => {
    let seenBody = "";
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        seenBody = await req.text();
        return Response.json({ ok: true });
      },
    });
    const logs: Record<string, unknown>[] = [];
    try {
      const app = buildApp(baseConfig(`http://127.0.0.1:${server.port}`), (e) => logs.push(e));
      const res = await app.request("/v1/messages", {
        method: "POST",
        headers: { "x-manifest-tier": "reasoning", "content-type": "application/json" },
        body: JSON.stringify({
          model: "auto",
          messages: [{ role: "user", content: "oi" }],
          temperature: 0.2,
          top_p: 0.9,
          top_k: 40,
          thinking: { type: "enabled" },
          max_tokens: 64,
        }),
      });
      expect(res.status).toBe(200);
      const forwarded = JSON.parse(seenBody) as Record<string, unknown>;
      expect(forwarded.temperature).toBeUndefined();
      expect(forwarded.top_p).toBeUndefined();
      expect(forwarded.top_k).toBeUndefined();
      expect(forwarded.thinking).toBeUndefined();
      // estrutural preservado
      expect(forwarded.max_tokens).toBe(64);
      expect(forwarded.messages).toEqual([{ role: "user", content: "oi" }]);
      const forwards = logs.filter((l) => l.event === "tier-classifier.forward");
      expect((forwards[0]?.stripped as string[]).sort()).toEqual([
        "temperature",
        "thinking",
        "top_k",
        "top_p",
      ]);
    } finally {
      server.stop(true);
    }
  });

  it("does not strip anything when canonicalize is disabled", async () => {
    let seenBody = "";
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        seenBody = await req.text();
        return Response.json({ ok: true });
      },
    });
    const logs: Record<string, unknown>[] = [];
    try {
      const config = { ...baseConfig(`http://127.0.0.1:${server.port}`), canonicalize: false };
      const app = buildApp(config, (e) => logs.push(e));
      await app.request("/v1/messages", {
        method: "POST",
        headers: { "x-manifest-tier": "reasoning", "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "oi" }], temperature: 0.2 }),
      });
      const forwarded = JSON.parse(seenBody) as Record<string, unknown>;
      expect(forwarded.temperature).toBe(0.2);
      const forwards = logs.filter((l) => l.event === "tier-classifier.forward");
      expect(forwards[0]?.stripped).toBeUndefined();
    } finally {
      server.stop(true);
    }
  });

  it("bypasses canonicalization for a request whose credential (Bearer) is in the bypass list", async () => {
    let seenBody = "";
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        seenBody = await req.text();
        return Response.json({ ok: true });
      },
    });
    const logs: Record<string, unknown>[] = [];
    try {
      const config = {
        ...baseConfig(`http://127.0.0.1:${server.port}`),
        canonicalizeBypass: ["mnfst_bypass"],
      };
      const app = buildApp(config, (e) => logs.push(e));
      await app.request("/v1/messages", {
        method: "POST",
        headers: {
          "x-manifest-tier": "reasoning",
          "content-type": "application/json",
          authorization: "Bearer mnfst_bypass",
        },
        body: JSON.stringify({ messages: [{ role: "user", content: "oi" }], temperature: 0.2 }),
      });
      // temperature preservado -- a canonização foi pulada
      expect((JSON.parse(seenBody) as Record<string, unknown>).temperature).toBe(0.2);
      const forwards = logs.filter((l) => l.event === "tier-classifier.forward");
      expect(forwards[0]).toMatchObject({ canonicalizeBypassed: true });
      expect(forwards[0]?.stripped).toBeUndefined();
    } finally {
      server.stop(true);
    }
  });

  it("bypasses canonicalization when the bypass credential arrives via x-api-key", async () => {
    let seenBody = "";
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        seenBody = await req.text();
        return Response.json({ ok: true });
      },
    });
    try {
      const config = {
        ...baseConfig(`http://127.0.0.1:${server.port}`),
        canonicalizeBypass: ["mnfst_bypass"],
      };
      const app = buildApp(config, silent);
      await app.request("/v1/messages", {
        method: "POST",
        headers: {
          "x-manifest-tier": "reasoning",
          "content-type": "application/json",
          "x-api-key": "mnfst_bypass",
        },
        body: JSON.stringify({ messages: [{ role: "user", content: "oi" }], temperature: 0.2 }),
      });
      expect((JSON.parse(seenBody) as Record<string, unknown>).temperature).toBe(0.2);
    } finally {
      server.stop(true);
    }
  });

  it("still canonicalizes a request whose credential is NOT in the bypass list", async () => {
    let seenBody = "";
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        seenBody = await req.text();
        return Response.json({ ok: true });
      },
    });
    try {
      const config = {
        ...baseConfig(`http://127.0.0.1:${server.port}`),
        canonicalizeBypass: ["mnfst_bypass"],
      };
      const app = buildApp(config, silent);
      await app.request("/v1/messages", {
        method: "POST",
        headers: {
          "x-manifest-tier": "reasoning",
          "content-type": "application/json",
          authorization: "Bearer mnfst_other",
        },
        body: JSON.stringify({ messages: [{ role: "user", content: "oi" }], temperature: 0.2 }),
      });
      expect((JSON.parse(seenBody) as Record<string, unknown>).temperature).toBeUndefined();
    } finally {
      server.stop(true);
    }
  });
});
