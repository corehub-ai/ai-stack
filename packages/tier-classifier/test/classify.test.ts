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
      const tier = await classifyTier(
        baseConfig(`http://127.0.0.1:${server.port}`),
        "refatora esse módulo inteiro",
      );
      expect(tier).toBe("complex");
    } finally {
      server.stop(true);
    }
  });

  it("trims punctuation/case noise around the label", async () => {
    const server = Bun.serve({ port: 0, fetch: () => anthropicTextResponse("  Reasoning.\n") });
    try {
      const tier = await classifyTier(
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

  it("returns null when the response label is not simple/complex/reasoning", async () => {
    const server = Bun.serve({ port: 0, fetch: () => anthropicTextResponse("maybe idk") });
    try {
      const tier = await classifyTier(baseConfig(`http://127.0.0.1:${server.port}`), "oi");
      expect(tier).toBeNull();
    } finally {
      server.stop(true);
    }
  });

  it("returns null when manifest responds with a non-2xx status", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("nope", { status: 500 }) });
    try {
      const tier = await classifyTier(baseConfig(`http://127.0.0.1:${server.port}`), "oi");
      expect(tier).toBeNull();
    } finally {
      server.stop(true);
    }
  });

  it("returns null (fail-open) when manifest doesn't respond within timeoutMs", async () => {
    const server = Bun.serve({
      port: 0,
      async fetch() {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return anthropicTextResponse("simple");
      },
    });
    try {
      const config = { ...baseConfig(`http://127.0.0.1:${server.port}`), timeoutMs: 50 };
      const tier = await classifyTier(config, "oi");
      expect(tier).toBeNull();
    } finally {
      server.stop(true);
    }
  });

  it("returns null when the manifest URL is unreachable", async () => {
    const tier = await classifyTier(baseConfig("http://127.0.0.1:1"), "oi");
    expect(tier).toBeNull();
  });
});
