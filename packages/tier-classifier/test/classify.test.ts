import { describe, expect, it } from "bun:test";
import { classifyTier } from "../src/classify.js";
import type { ClassifierConfig } from "../src/config.js";

function baseConfig(manifestUrl: string): ClassifierConfig {
  return {
    port: 0,
    manifestUrl,
    manifestKey: "mnfst_test-classifier",
    tier: "default",
    timeoutMs: 300,
    coldLoadExtraMs: 1000,
    canonicalize: true,
    canonicalizeBypass: [],
  };
}

function anthropicTextResponse(text: string): Response {
  return Response.json({
    id: "msg_test",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text }],
  });
}

describe("classifyTier", () => {
  it("returns the parsed label on a clean response", async () => {
    const server = Bun.serve({ port: 0, fetch: () => anthropicTextResponse("complex") });
    try {
      const { tier, failure } = await classifyTier(
        baseConfig(`http://127.0.0.1:${server.port}`),
        "refatora esse módulo inteiro",
      );
      expect(tier).toBe("complex");
      expect(failure).toBeUndefined();
    } finally {
      server.stop(true);
    }
  });

  it("trims punctuation/case noise around the label", async () => {
    const server = Bun.serve({ port: 0, fetch: () => anthropicTextResponse("  Reasoning.\n") });
    try {
      const { tier } = await classifyTier(
        baseConfig(`http://127.0.0.1:${server.port}`),
        "pensa nas opções",
      );
      expect(tier).toBe("reasoning");
    } finally {
      server.stop(true);
    }
  });

  it("sends the configured tier header and manifest key", async () => {
    let seenAuth: string | null = null;
    let seenTier: string | null = null;
    const server = Bun.serve({
      port: 0,
      fetch: (req) => {
        seenAuth = req.headers.get("authorization");
        seenTier = req.headers.get("x-manifest-tier");
        return anthropicTextResponse("simple");
      },
    });
    try {
      await classifyTier(
        {
          ...baseConfig(`http://127.0.0.1:${server.port}`),
          manifestKey: "mnfst_abc",
          tier: "classify",
        },
        "oi",
      );
      expect(seenAuth as unknown as string).toBe("Bearer mnfst_abc");
      expect(seenTier as unknown as string).toBe("classify");
    } finally {
      server.stop(true);
    }
  });

  it("returns a invalid-label failure when the response label is not simple/complex/reasoning", async () => {
    const server = Bun.serve({ port: 0, fetch: () => anthropicTextResponse("maybe idk") });
    try {
      const { tier, failure } = await classifyTier(
        baseConfig(`http://127.0.0.1:${server.port}`),
        "oi",
      );
      expect(tier).toBeNull();
      expect(failure).toEqual({ kind: "invalid-label", raw: "maybe idk" });
    } finally {
      server.stop(true);
    }
  });

  it("returns an http-error failure (with status + body snippet) on a non-2xx status", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response("upstream boom", { status: 500 }),
    });
    try {
      const { tier, failure } = await classifyTier(
        baseConfig(`http://127.0.0.1:${server.port}`),
        "oi",
      );
      expect(tier).toBeNull();
      expect(failure).toEqual({ kind: "http-error", status: 500, bodySnippet: "upstream boom" });
    } finally {
      server.stop(true);
    }
  });

  it("retries once with timeoutMs + coldLoadExtraMs when the first attempt times out (cold-load), and returns the label if the retry succeeds", async () => {
    const server = Bun.serve({
      port: 0,
      async fetch() {
        // Mais que timeoutMs (100ms) sozinho, mas dentro de timeoutMs +
        // coldLoadExtraMs (100 + 300 = 400ms) -- simula um cold-load real.
        await new Promise((resolve) => setTimeout(resolve, 200));
        return anthropicTextResponse("complex");
      },
    });
    try {
      const config = {
        ...baseConfig(`http://127.0.0.1:${server.port}`),
        timeoutMs: 100,
        coldLoadExtraMs: 300,
      };
      const { tier } = await classifyTier(config, "refatora esse módulo inteiro");
      expect(tier).toBe("complex");
    } finally {
      server.stop(true);
    }
  });

  it("returns a timeout failure (fail-open) when even the retry times out", async () => {
    const server = Bun.serve({
      port: 0,
      async fetch() {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return anthropicTextResponse("simple");
      },
    });
    try {
      const config = {
        ...baseConfig(`http://127.0.0.1:${server.port}`),
        timeoutMs: 50,
        coldLoadExtraMs: 100,
      };
      const { tier, failure } = await classifyTier(config, "oi");
      expect(tier).toBeNull();
      expect(failure).toEqual({ kind: "timeout" });
    } finally {
      server.stop(true);
    }
  });

  it("does not retry on a non-timeout failure (e.g. non-2xx status) -- returns fast", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("nope", { status: 500 }) });
    try {
      const config = {
        ...baseConfig(`http://127.0.0.1:${server.port}`),
        timeoutMs: 100,
        coldLoadExtraMs: 5000,
      };
      const start = Date.now();
      const { tier } = await classifyTier(config, "oi");
      expect(tier).toBeNull();
      // Se tivesse tentado de novo com timeoutMs + coldLoadExtraMs, levaria
      // bem mais que isso -- prova que o retry só acontece em timeout.
      expect(Date.now() - start).toBeLessThan(1000);
    } finally {
      server.stop(true);
    }
  });

  it("returns a network-error failure when the manifest URL is unreachable", async () => {
    const { tier, failure } = await classifyTier(baseConfig("http://127.0.0.1:1"), "oi");
    expect(tier).toBeNull();
    expect(failure?.kind).toBe("network-error");
  });

  it("skips null/non-object entries in the response content array instead of throwing", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json({
          id: "msg_test",
          type: "message",
          role: "assistant",
          content: [null, { type: "text", text: "simple" }, 42],
        }),
    });
    try {
      const { tier } = await classifyTier(baseConfig(`http://127.0.0.1:${server.port}`), "oi");
      expect(tier).toBe("simple");
    } finally {
      server.stop(true);
    }
  });
});
