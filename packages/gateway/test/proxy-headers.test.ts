import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import type { AuthEnv } from "../src/auth.js";
import { proxyHeaders } from "../src/proxy-headers.js";

describe("proxyHeaders", () => {
  it("forwards the client's own Authorization header untouched when present", async () => {
    const app = new Hono<AuthEnv>();
    app.get("/probe", (c) => c.json(proxyHeaders(c)));
    const res = await app.request(
      "/probe",
      { headers: { authorization: "Bearer mnfst_client-owned" } },
      { ip: "203.0.113.9" },
    );
    const body = (await res.json()) as Record<string, string>;
    expect(body.authorization).toBe("Bearer mnfst_client-owned");
  });

  it("forwards the client's own x-api-key header untouched when present", async () => {
    const app = new Hono<AuthEnv>();
    app.get("/probe", (c) => c.json(proxyHeaders(c)));
    const res = await app.request(
      "/probe",
      { headers: { "x-api-key": "sk-client-owned" } },
      { ip: "203.0.113.9" },
    );
    const body = (await res.json()) as Record<string, string>;
    expect(body["x-api-key"]).toBe("sk-client-owned");
    expect(body.authorization).toBeUndefined();
  });

  it("uses the gateway-injected key, never a client-supplied one, when the middleware set it", async () => {
    const app = new Hono<AuthEnv>();
    app.use("*", async (c, next) => {
      c.set("injectedAuthHeader", "Bearer mnfst_lan_anon");
      await next();
    });
    app.get("/probe", (c) => c.json(proxyHeaders(c)));
    // A client can't have reached this branch with a real credential (the
    // auth middleware only injects when none was present), but even if a
    // header sneaks in some other way, injection must always win.
    const res = await app.request(
      "/probe",
      { headers: { "x-api-key": "sk-should-be-ignored" } },
      { ip: "127.0.0.1" },
    );
    const body = (await res.json()) as Record<string, string>;
    expect(body.authorization).toBe("Bearer mnfst_lan_anon");
  });

  it("never leaves the host header in the outgoing set", async () => {
    const app = new Hono<AuthEnv>();
    app.get("/probe", (c) => c.json(proxyHeaders(c)));
    const res = await app.request(
      "/probe",
      { headers: { host: "gateway.internal" } },
      { ip: "127.0.0.1" },
    );
    const body = (await res.json()) as Record<string, string>;
    expect(body.host).toBeUndefined();
  });
});
