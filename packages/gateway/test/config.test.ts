import { describe, expect, it } from "bun:test";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("applies documented defaults when env is empty", () => {
    const config = loadConfig({});
    expect(config.port).toBe(11434);
    expect(config.headroomUrl).toBe("http://headroom:8787");
    expect(config.manifestUrl).toBe("http://manifest:2099");
    expect(config.trustedCidrs).toEqual([]);
    expect(config.defaultKey).toBe("");
    expect(config.corsOrigins).toEqual([]);
    expect(config.ollamaVersion).toBe("0.31.1");
  });

  it("reads and trims comma-separated lists", () => {
    const config = loadConfig({
      GATEWAY_TRUSTED_CIDRS: " 172.28.1.0/24 , 127.0.0.1/32",
      GATEWAY_CORS_ORIGINS: "http://localhost:3000,http://openwebui:3000",
    });
    expect(config.trustedCidrs).toEqual(["172.28.1.0/24", "127.0.0.1/32"]);
    expect(config.corsOrigins).toEqual(["http://localhost:3000", "http://openwebui:3000"]);
  });

  it("strips a trailing slash from the target URLs", () => {
    const config = loadConfig({ HEADROOM_URL: "http://headroom:8787/" });
    expect(config.headroomUrl).toBe("http://headroom:8787");
  });
});
