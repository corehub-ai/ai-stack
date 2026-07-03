import { describe, expect, test } from "bun:test";
import { checkEnvSecrets, summarize } from "../src/doctor.js";

describe("summarize", () => {
  test("ok when every check passes", () => {
    const s = summarize([
      { name: "a", ok: true, detail: "" },
      { name: "b", ok: true, detail: "" },
    ]);
    expect(s).toEqual({ ok: true, failed: 0 });
  });

  test("counts failures", () => {
    const s = summarize([
      { name: "a", ok: true, detail: "" },
      { name: "b", ok: false, detail: "boom" },
      { name: "c", ok: false, detail: "boom" },
    ]);
    expect(s).toEqual({ ok: false, failed: 2 });
  });
});

describe("checkEnvSecrets", () => {
  test("passes when all four infra secrets are set", () => {
    const r = checkEnvSecrets({
      BETTER_AUTH_SECRET: "x",
      MANIFEST_ENCRYPTION_KEY: "x",
      POSTGRES_PASSWORD: "x",
      WEBUI_SECRET_KEY: "x",
    });
    expect(r.ok).toBe(true);
  });

  test("fails and names the missing secret", () => {
    const r = checkEnvSecrets({
      BETTER_AUTH_SECRET: "x",
      MANIFEST_ENCRYPTION_KEY: "",
      POSTGRES_PASSWORD: "x",
      WEBUI_SECRET_KEY: "x",
    });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("MANIFEST_ENCRYPTION_KEY");
  });
});
