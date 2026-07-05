import { describe, expect, it } from "bun:test";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("applies documented defaults when env is empty", () => {
    const config = loadConfig({});
    expect(config.port).toBe(8788);
    expect(config.manifestUrl).toBe("http://manifest:2099");
    expect(config.manifestKey).toBe("");
    expect(config.tier).toBe("default");
    expect(config.timeoutMs).toBe(1500);
    expect(config.coldLoadExtraMs).toBe(15000);
    expect(config.canonicalize).toBe(true);
  });

  it("reads every value from env vars", () => {
    const config = loadConfig({
      CLASSIFIER_PORT: "9999",
      MANIFEST_URL: "http://manifest:2099/",
      CLASSIFIER_MANIFEST_KEY: "mnfst_tier-classifier",
      CLASSIFIER_TIER: "classify",
      CLASSIFIER_TIMEOUT_MS: "500",
      CLASSIFIER_COLD_LOAD_EXTRA_MS: "20000",
      CLASSIFIER_CANONICALIZE: "false",
    });
    expect(config.port).toBe(9999);
    expect(config.manifestKey).toBe("mnfst_tier-classifier");
    expect(config.tier).toBe("classify");
    expect(config.timeoutMs).toBe(500);
    expect(config.coldLoadExtraMs).toBe(20000);
    expect(config.canonicalize).toBe(false);
  });

  it("treats CLASSIFIER_CANONICALIZE=0/off as false and anything else as the default (true)", () => {
    expect(loadConfig({ CLASSIFIER_CANONICALIZE: "0" }).canonicalize).toBe(false);
    expect(loadConfig({ CLASSIFIER_CANONICALIZE: "off" }).canonicalize).toBe(false);
    expect(loadConfig({ CLASSIFIER_CANONICALIZE: "true" }).canonicalize).toBe(true);
    expect(loadConfig({ CLASSIFIER_CANONICALIZE: "garbage" }).canonicalize).toBe(true);
  });

  it("strips a trailing slash from MANIFEST_URL", () => {
    const config = loadConfig({ MANIFEST_URL: "http://manifest:2099/" });
    expect(config.manifestUrl).toBe("http://manifest:2099");
  });

  it("falls back to the default instead of NaN when a numeric env var is non-numeric", () => {
    const config = loadConfig({
      CLASSIFIER_PORT: "abc",
      CLASSIFIER_TIMEOUT_MS: "not-a-number",
      CLASSIFIER_COLD_LOAD_EXTRA_MS: "also-not-a-number",
    });
    expect(config.port).toBe(8788);
    expect(config.timeoutMs).toBe(1500);
    expect(config.coldLoadExtraMs).toBe(15000);
  });
});
