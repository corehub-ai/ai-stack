import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { createAuthMiddleware, isForwardedHttps, isHostSide } from "../src/auth.js";
import type { ManifestKeyValidator } from "../src/manifest-key.js";
import { acceptAllKeys, rejectAllKeys, unavailableKeys } from "./support/key-validator.js";

type Env = {
  Bindings: { ip?: string };
  Variables: { injectedAuthHeader?: string; authValidate?: string };
};

function buildTestApp(opts: {
  defaultKey: string;
  trustedCidrs?: string[];
  trustedProxies?: string[];
  validateKey?: ManifestKeyValidator;
}) {
  const app = new Hono<Env>();
  app.use(
    "*",
    createAuthMiddleware({
      defaultKey: opts.defaultKey,
      trustedCidrs: opts.trustedCidrs ?? [],
      trustedProxies: opts.trustedProxies ?? [],
      validateKey: opts.validateKey ?? acceptAllKeys,
    }),
  );
  app.get("/probe", (c) =>
    c.json({
      injected: c.get("injectedAuthHeader") ?? null,
      authValidate: c.get("authValidate") ?? null,
    }),
  );
  return app;
}

describe("isHostSide / isForwardedHttps", () => {
  it("treats loopback and trusted CIDRs as host-side", () => {
    expect(isHostSide("127.0.0.1", [])).toBe(true);
    expect(isHostSide("::1", [])).toBe(true);
    expect(isHostSide("172.28.1.1", ["172.28.1.1/32"])).toBe(true);
    expect(isHostSide("172.28.1.7", ["172.28.1.0/24"])).toBe(true);
    expect(isHostSide("192.168.1.10", ["172.28.1.0/24"])).toBe(false);
  });

  it("reads X-Forwarded-Proto and Forwarded proto=", async () => {
    const app = new Hono<Env>();
    app.get("/xfp", (c) => c.json({ https: isForwardedHttps(c) }));

    const a = await app.request("/xfp", { headers: { "x-forwarded-proto": "https" } });
    expect(((await a.json()) as { https: boolean }).https).toBe(true);

    const b = await app.request("/xfp", { headers: { "x-forwarded-proto": "http" } });
    expect(((await b.json()) as { https: boolean }).https).toBe(false);

    const c = await app.request("/xfp", {
      headers: { forwarded: "for=1.2.3.4;proto=https;by=proxy" },
    });
    expect(((await c.json()) as { https: boolean }).https).toBe(true);
  });
});

describe("createAuthMiddleware", () => {
  it("allows a valid mnfst_ key from outside the host only with X-Forwarded-Proto: https", async () => {
    const app = buildTestApp({ defaultKey: "mnfst_default" });
    const denied = await app.request(
      "/probe",
      { headers: { authorization: "Bearer mnfst_whatever" } },
      { ip: "8.8.8.8" },
    );
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: { code: string } }).error.code).toBe(
      "gateway_https_required",
    );

    const ok = await app.request(
      "/probe",
      {
        headers: {
          authorization: "Bearer mnfst_whatever",
          "x-forwarded-proto": "https",
        },
      },
      { ip: "8.8.8.8" },
    );
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { authValidate: string }).authValidate).toBe("pass");
  });

  it("passes through a valid mnfst_ x-api-key from outside with HTTPS header", async () => {
    const app = buildTestApp({ defaultKey: "mnfst_default" });
    const res = await app.request(
      "/probe",
      { headers: { "x-api-key": "mnfst_whatever", "x-forwarded-proto": "https" } },
      { ip: "8.8.8.8" },
    );
    expect(res.status).toBe(200);
  });

  it("401s when Manifest rejects the key (after HTTPS check)", async () => {
    const app = buildTestApp({ defaultKey: "mnfst_default", validateKey: rejectAllKeys });
    const res = await app.request(
      "/probe",
      {
        headers: {
          authorization: "Bearer mnfst_rotacionada",
          "x-forwarded-proto": "https",
        },
      },
      { ip: "8.8.8.8" },
    );
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "gateway_auth_invalid_key",
    );
  });

  it("503s when Manifest is unreachable during key validation", async () => {
    const app = buildTestApp({ defaultKey: "mnfst_default", validateKey: unavailableKeys });
    const res = await app.request(
      "/probe",
      {
        headers: { authorization: "Bearer mnfst_whatever", "x-forwarded-proto": "https" },
      },
      { ip: "8.8.8.8" },
    );
    expect(res.status).toBe(503);
  });

  it("injects defaultKey for loopback without a key (HTTP ok)", async () => {
    const app = buildTestApp({ defaultKey: "mnfst_default" });
    const res = await app.request("/probe", {}, { ip: "127.0.0.1" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { injected: string | null; authValidate: string };
    expect(body.injected).toBe("Bearer mnfst_default");
    expect(body.authValidate).toBe("injected_host");
  });

  it("injects defaultKey for docker hairpin IP when listed in GATEWAY_TRUSTED_CIDRS", async () => {
    const app = buildTestApp({
      defaultKey: "mnfst_default",
      trustedCidrs: ["172.28.1.1/32"],
    });
    const res = await app.request("/probe", {}, { ip: "172.28.1.1" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { injected: string }).injected).toBe("Bearer mnfst_default");
  });

  it("treats non-mnfst credential on host-side as anonymous (inject)", async () => {
    const app = buildTestApp({ defaultKey: "mnfst_default" });
    const res = await app.request(
      "/probe",
      { headers: { authorization: "Bearer ghu_github_token" } },
      { ip: "127.0.0.1" },
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { injected: string }).injected).toBe("Bearer mnfst_default");
  });

  it("401s anonymous outside host even with HTTPS", async () => {
    const app = buildTestApp({ defaultKey: "mnfst_default" });
    const res = await app.request(
      "/probe",
      { headers: { "x-forwarded-proto": "https" } },
      { ip: "203.0.113.9" },
    );
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("gateway_auth");
  });

  it("403s outside host on plain HTTP even with a valid-looking key", async () => {
    const app = buildTestApp({ defaultKey: "mnfst_default" });
    const res = await app.request(
      "/probe",
      { headers: { authorization: "Bearer mnfst_whatever" } },
      { ip: "203.0.113.9" },
    );
    expect(res.status).toBe(403);
  });

  it("when TRUSTED_PROXIES is set, only those peers may assert HTTPS", async () => {
    const app = buildTestApp({
      defaultKey: "mnfst_default",
      trustedProxies: ["10.0.0.2/32"],
    });
    const spoof = await app.request(
      "/probe",
      {
        headers: {
          authorization: "Bearer mnfst_whatever",
          "x-forwarded-proto": "https",
        },
      },
      { ip: "203.0.113.9" },
    );
    expect(spoof.status).toBe(403);

    const viaProxy = await app.request(
      "/probe",
      {
        headers: {
          authorization: "Bearer mnfst_whatever",
          "x-forwarded-proto": "https",
        },
      },
      { ip: "10.0.0.2" },
    );
    expect(viaProxy.status).toBe(200);
  });

  it("normalizes Bun IPv4-mapped-IPv6 before matching", async () => {
    const app = buildTestApp({
      defaultKey: "mnfst_default",
      trustedCidrs: ["172.28.1.1/32"],
    });
    expect((await app.request("/probe", {}, { ip: "::ffff:127.0.0.1" })).status).toBe(200);
    expect((await app.request("/probe", {}, { ip: "::ffff:172.28.1.1" })).status).toBe(200);
    expect((await app.request("/probe", {}, { ip: "::ffff:192.168.1.5" })).status).toBe(403);
  });
});
