import { describe, expect, it } from "bun:test";
import { loadConfig } from "../src/config.js";
import { buildApp } from "../src/index.js";

describe("gateway smoke", () => {
  it("GET /health responds (even if degraded, since there's no real upstream in this test)", async () => {
    const app = buildApp(loadConfig({}));
    const res = await app.request("/health");
    expect([200, 503]).toContain(res.status);
  });
});
