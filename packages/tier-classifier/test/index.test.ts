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
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        event: "tier-classifier.decision",
        tier: "complex",
        failOpen: false,
      });
      expect(typeof logs[0]?.latencyMs).toBe("number");
      expect(logs[0]?.reason).toBeUndefined();
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
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        event: "tier-classifier.decision",
        tier: null,
        failOpen: true,
        reason: "classification-failed",
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
});
