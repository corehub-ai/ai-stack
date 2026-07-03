export type GatewayConfig = {
  port: number;
  headroomUrl: string;
  manifestUrl: string;
  trustedCidrs: string[];
  defaultKey: string;
  corsOrigins: string[];
  ollamaVersion: string;
};

function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): GatewayConfig {
  return {
    port: Number(env.GATEWAY_PORT ?? "11434"),
    headroomUrl: stripTrailingSlash(env.HEADROOM_URL ?? "http://headroom:8787"),
    manifestUrl: stripTrailingSlash(env.MANIFEST_URL ?? "http://manifest:2099"),
    trustedCidrs: splitList(env.GATEWAY_TRUSTED_CIDRS),
    defaultKey: env.GATEWAY_DEFAULT_KEY ?? "",
    corsOrigins: splitList(env.GATEWAY_CORS_ORIGINS),
    ollamaVersion: env.GATEWAY_OLLAMA_VERSION ?? "0.31.1",
  };
}
