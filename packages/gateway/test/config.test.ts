import { describe, expect, it } from "bun:test";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("applies documented defaults when env is empty", () => {
    const config = loadConfig({});
    expect(config.port).toBe(11434);
    expect(config.headroomUrl).toBe("http://headroom:8787");
    expect(config.manifestUrl).toBe("http://manifest:2099");
    expect(config.trustedCidrs).toEqual([]);
    expect(config.trustedProxies).toEqual([]);
    expect(config.defaultKey).toBe("");
    expect(config.corsOrigins).toEqual([]);
    expect(config.ollamaVersion).toBe("0.31.1");
    expect(config.ollamaDefaultKey).toBe("");
  });

  it("uses GATEWAY_OLLAMA_DEFAULT_KEY for ollamaDefaultKey when set", () => {
    const config = loadConfig({
      GATEWAY_DEFAULT_KEY: "mnfst_lan_anon",
      GATEWAY_OLLAMA_DEFAULT_KEY: "mnfst_ollama_facade",
    });
    expect(config.ollamaDefaultKey).toBe("mnfst_ollama_facade");
  });

  it("falls back to GATEWAY_DEFAULT_KEY when GATEWAY_OLLAMA_DEFAULT_KEY is unset", () => {
    const config = loadConfig({ GATEWAY_DEFAULT_KEY: "mnfst_lan_anon" });
    expect(config.ollamaDefaultKey).toBe("mnfst_lan_anon");
  });

  it("falls back to GATEWAY_DEFAULT_KEY when GATEWAY_OLLAMA_DEFAULT_KEY is empty (compose always defines the var)", () => {
    const config = loadConfig({
      GATEWAY_DEFAULT_KEY: "mnfst_lan_anon",
      GATEWAY_OLLAMA_DEFAULT_KEY: "",
    });
    expect(config.ollamaDefaultKey).toBe("mnfst_lan_anon");
  });

  it("reads and trims comma-separated lists", () => {
    const config = loadConfig({
      GATEWAY_TRUSTED_CIDRS: " 172.28.1.0/24 , 127.0.0.1/32",
      GATEWAY_TRUSTED_PROXIES: " 10.0.0.2/32 , 10.0.0.3/32 ",
      GATEWAY_CORS_ORIGINS: "http://localhost:3000,http://openwebui:3000",
    });
    expect(config.trustedCidrs).toEqual(["172.28.1.0/24", "127.0.0.1/32"]);
    expect(config.trustedProxies).toEqual(["10.0.0.2/32", "10.0.0.3/32"]);
    expect(config.corsOrigins).toEqual(["http://localhost:3000", "http://openwebui:3000"]);
  });

  it("strips a trailing slash from the target URLs", () => {
    const config = loadConfig({ HEADROOM_URL: "http://headroom:8787/" });
    expect(config.headroomUrl).toBe("http://headroom:8787");
  });
});
