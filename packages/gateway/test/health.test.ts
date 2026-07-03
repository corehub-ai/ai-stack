import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import type { AuthEnv } from "../src/auth.js";
import type { GatewayConfig } from "../src/config.js";
import { registerHealthRoute } from "../src/routes/health.js";

function baseConfig(overrides: Partial<GatewayConfig>): GatewayConfig {
  return {
    port: 0,
    headroomUrl: "http://127.0.0.1:1",
    manifestUrl: "http://127.0.0.1:1",
    trustedCidrs: [],
    defaultKey: "",
    corsOrigins: [],
    ollamaVersion: "0.31.1",
    ...overrides,
  };
}

describe("GET /health", () => {
  it("returns 200 status ok when both hops respond ok", async () => {
    const headroom = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const manifest = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    try {
      const app = new Hono<AuthEnv>();
      registerHealthRoute(
        app,
        baseConfig({
          headroomUrl: `http://127.0.0.1:${headroom.port}`,
          manifestUrl: `http://127.0.0.1:${manifest.port}`,
        }),
      );
      const res = await app.request("/health");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; gateway: string };
      expect(body.status).toBe("ok");
      expect(body.gateway).toBe("ok");
    } finally {
      headroom.stop(true);
      manifest.stop(true);
    }
  });

  it("returns 503 status degraded when a hop is unreachable", async () => {
    const manifest = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    try {
      const app = new Hono<AuthEnv>();
      registerHealthRoute(
        app,
        baseConfig({
          headroomUrl: "http://127.0.0.1:1",
          manifestUrl: `http://127.0.0.1:${manifest.port}`,
        }),
      );
      const res = await app.request("/health");
      expect(res.status).toBe(503);
      const body = (await res.json()) as { status: string };
      expect(body.status).toBe("degraded");
    } finally {
      manifest.stop(true);
    }
  });
});
