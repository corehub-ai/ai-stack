import { describe, expect, it } from "bun:test";
import { createManifestKeyValidator } from "../src/manifest-key.js";

describe("createManifestKeyValidator", () => {
  it("returns valid on Manifest 200 and caches the positive result", async () => {
    let calls = 0;
    const validate = createManifestKeyValidator({
      manifestUrl: "http://manifest.test",
      fetchImpl: async () => {
        calls += 1;
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      },
      positiveTtlMs: 60_000,
    });
    expect(await validate("mnfst_ok")).toBe("valid");
    expect(await validate("mnfst_ok")).toBe("valid");
    expect(calls).toBe(1);
  });

  it("returns invalid on Manifest 401 and caches briefly", async () => {
    let calls = 0;
    const validate = createManifestKeyValidator({
      manifestUrl: "http://manifest.test",
      fetchImpl: async () => {
        calls += 1;
        return new Response(JSON.stringify({ error: { code: "manifest_auth" } }), {
          status: 401,
        });
      },
      negativeTtlMs: 60_000,
    });
    expect(await validate("mnfst_bad")).toBe("invalid");
    expect(await validate("mnfst_bad")).toBe("invalid");
    expect(calls).toBe(1);
  });

  it("returns unavailable on network failure (not cached)", async () => {
    let calls = 0;
    const validate = createManifestKeyValidator({
      manifestUrl: "http://manifest.test",
      fetchImpl: async () => {
        calls += 1;
        throw new Error("ECONNREFUSED");
      },
    });
    expect(await validate("mnfst_x")).toBe("unavailable");
    expect(await validate("mnfst_x")).toBe("unavailable");
    expect(calls).toBe(2);
  });

  it("sends Authorization Bearer to GET /v1/models on the Manifest URL", async () => {
    const seen: string[] = [];
    const validate = createManifestKeyValidator({
      manifestUrl: "http://manifest:2099",
      fetchImpl: async (input, init) => {
        seen.push(input);
        seen.push(new Headers(init?.headers).get("authorization") ?? "");
        return new Response("{}", { status: 200 });
      },
    });
    await validate("mnfst_secret");
    expect(seen[0]).toBe("http://manifest:2099/v1/models");
    expect(seen[1]).toBe("Bearer mnfst_secret");
  });
});
