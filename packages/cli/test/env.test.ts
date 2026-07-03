import { describe, expect, test } from "bun:test";
import { generateSecret, parseEnvFile, renderInitialEnv, SECRET_KEYS } from "../src/env.js";

const EXAMPLE = `# comentário
BETTER_AUTH_SECRET=
MANIFEST_ENCRYPTION_KEY=
POSTGRES_PASSWORD=
MANIFEST_PUBLIC_URL=http://localhost:2099
COMPOSE_PROFILES=local-models
WEBUI_SECRET_KEY=
MANIFEST_KEY_OPENCODE=
`;

describe("renderInitialEnv", () => {
  test("fills every empty secret with a generated value", () => {
    let n = 0;
    const out = renderInitialEnv(EXAMPLE, () => `secret${n++}`);
    const env = parseEnvFile(out);
    for (const key of SECRET_KEYS) {
      expect(env[key]).toMatch(/^secret\d$/);
    }
  });

  test("leaves non-secret and pre-filled lines verbatim", () => {
    const out = renderInitialEnv(EXAMPLE, () => "x");
    const env = parseEnvFile(out);
    expect(env.MANIFEST_PUBLIC_URL).toBe("http://localhost:2099");
    expect(env.COMPOSE_PROFILES).toBe("local-models");
  });

  test("never fabricates agent keys", () => {
    const out = renderInitialEnv(EXAMPLE, () => "x");
    const env = parseEnvFile(out);
    expect(env.MANIFEST_KEY_OPENCODE).toBe("");
  });

  test("preserves comments", () => {
    const out = renderInitialEnv(EXAMPLE, () => "x");
    expect(out).toContain("# comentário");
  });

  test("fills secrets on a CRLF file and preserves the CRLF endings", () => {
    const crlf = EXAMPLE.replace(/\n/g, "\r\n");
    let n = 0;
    const out = renderInitialEnv(crlf, () => `s${n++}`);
    expect(out).toContain("\r\n");
    const env = parseEnvFile(out);
    for (const key of SECRET_KEYS) {
      expect(env[key]).toMatch(/^s\d$/);
    }
    expect(env.MANIFEST_KEY_OPENCODE).toBe("");
  });
});

describe("generateSecret", () => {
  test("returns 64 hex chars", () => {
    expect(generateSecret()).toMatch(/^[0-9a-f]{64}$/);
  });

  test("is not constant", () => {
    expect(generateSecret()).not.toBe(generateSecret());
  });
});

describe("parseEnvFile", () => {
  test("ignores comments and blanks, keeps KEY=VALUE", () => {
    const env = parseEnvFile("# c\n\nA=1\nB=two words\n");
    expect(env).toEqual({ A: "1", B: "two words" });
  });
});
