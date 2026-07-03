import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { createAuthMiddleware } from "../src/auth.js";

type Env = { Bindings: { ip?: string }; Variables: { injectedAuthHeader?: string } };

function buildTestApp(opts: { trustedCidrs: string[]; defaultKey: string }) {
  const app = new Hono<Env>();
  app.use("*", createAuthMiddleware(opts));
  app.get("/probe", (c) => c.json({ injected: c.get("injectedAuthHeader") ?? null }));
  return app;
}

describe("createAuthMiddleware", () => {
  it("passes through when Authorization is present, regardless of IP", async () => {
    const app = buildTestApp({ trustedCidrs: [], defaultKey: "mnfst_default" });
    const res = await app.request(
      "/probe",
      { headers: { authorization: "Bearer mnfst_whatever" } },
      { ip: "8.8.8.8" },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { injected: string | null };
    expect(body.injected).toBeNull();
  });

  it("passes through when x-api-key is present", async () => {
    const app = buildTestApp({ trustedCidrs: [], defaultKey: "mnfst_default" });
    const res = await app.request(
      "/probe",
      { headers: { "x-api-key": "sk-whatever" } },
      { ip: "8.8.8.8" },
    );
    expect(res.status).toBe(200);
  });

  it("injects the default key for an untrusted-but-loopback caller with no credential", async () => {
    const app = buildTestApp({ trustedCidrs: [], defaultKey: "mnfst_default" });
    const res = await app.request("/probe", {}, { ip: "127.0.0.1" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { injected: string | null };
    expect(body.injected).toBe("Bearer mnfst_default");
  });

  it("injects the default key for a caller inside GATEWAY_TRUSTED_CIDRS", async () => {
    const app = buildTestApp({ trustedCidrs: ["172.28.1.0/24"], defaultKey: "mnfst_default" });
    const res = await app.request("/probe", {}, { ip: "172.28.1.7" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { injected: string | null };
    expect(body.injected).toBe("Bearer mnfst_default");
  });

  it("rejects a credential-less caller outside every trusted CIDR with 401", async () => {
    const app = buildTestApp({ trustedCidrs: ["172.28.1.0/24"], defaultKey: "mnfst_default" });
    const res = await app.request("/probe", {}, { ip: "203.0.113.9" });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { type: string; code: string } };
    expect(body.error.type).toBe("auth_error");
    expect(body.error.code).toBe("gateway_auth");
  });
});
