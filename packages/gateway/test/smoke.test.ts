import { describe, expect, it } from "bun:test";
import { buildApp } from "../src/index.js";

describe("gateway smoke", () => {
  it("GET / returns 200 with the gateway banner", async () => {
    const app = buildApp();
    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("corehub gateway");
  });
});
