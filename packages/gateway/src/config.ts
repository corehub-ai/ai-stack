export type GatewayConfig = {
  port: number;
  headroomUrl: string;
  manifestUrl: string;
  trustedCidrs: string[];
  defaultKey: string;
  corsOrigins: string[];
  ollamaVersion: string;
  ollamaDefaultKey: string;
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

// docker-compose sempre define GATEWAY_OLLAMA_DEFAULT_KEY (mesmo vazio, via
// ${MANIFEST_KEY_OLLAMA_FACADE:-}), então "unset" e "" precisam cair no mesmo
// fallback -- diferente de um simples `??`, que só pega undefined.
function firstNonEmpty(...values: Array<string | undefined>): string {
  for (const value of values) {
    if (value !== undefined && value.length > 0) return value;
  }
  return "";
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
    ollamaDefaultKey: firstNonEmpty(env.GATEWAY_OLLAMA_DEFAULT_KEY, env.GATEWAY_DEFAULT_KEY),
  };
}
