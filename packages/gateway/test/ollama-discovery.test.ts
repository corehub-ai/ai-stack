import { describe, expect, it } from "bun:test";
import { loadConfig } from "../src/config.js";
import { buildApp } from "../src/index.js";

function app() {
  return buildApp(loadConfig({ GATEWAY_OLLAMA_VERSION: "0.31.1" }));
}

describe("Ollama discovery surface", () => {
  it("GET / returns the Ollama banner", async () => {
    const res = await app().request("/");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("Ollama is running");
  });

  it("HEAD / returns 200", async () => {
    const res = await app().request("/", { method: "HEAD" });
    expect(res.status).toBe(200);
  });

  it("GET /api/version returns the configured version", async () => {
    const res = await app().request("/api/version");
    expect(res.status).toBe(200);
    expect((await res.json()) as { version: string }).toEqual({ version: "0.31.1" });
  });

  it("GET /api/tags lists the pseudo-models with Ollama-shaped entries", async () => {
    const res = await app().request("/api/tags");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      models: Array<{ name: string; model: string; details: unknown }>;
    };
    expect(body.models.some((m) => m.name === "auto")).toBe(true);
    const auto = body.models.find((m) => m.name === "auto");
    expect(auto?.model).toBe("auto");
    expect(auto?.details).toBeDefined();
  });

  it("POST /api/show returns capabilities and context_length for a known model", async () => {
    const res = await app().request("/api/show", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "auto" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      capabilities: string[];
      model_info: Record<string, number>;
    };
    expect(body.capabilities).toContain("completion");
    expect(body.model_info["general.context_length"]).toBeGreaterThan(0);
  });

  it("POST /api/show 404s for an unknown model", async () => {
    const res = await app().request("/api/show", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "nope:1b" }),
    });
    expect(res.status).toBe(404);
  });

  it("POST /api/embeddings returns 501 (embeddings out of scope)", async () => {
    const res = await app().request("/api/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "auto", input: "hi" }),
    });
    expect(res.status).toBe(501);
  });

  it("GET /api/ps returns an empty running-models list", async () => {
    const res = await app().request("/api/ps");
    expect(res.status).toBe(200);
    expect((await res.json()) as { models: unknown[] }).toEqual({ models: [] });
  });
});
