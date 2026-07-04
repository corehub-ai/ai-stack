export type ClassifierConfig = {
  port: number;
  manifestUrl: string;
  manifestKey: string;
  tier: string;
  timeoutMs: number;
};

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): ClassifierConfig {
  return {
    port: Number(env.CLASSIFIER_PORT ?? "8788"),
    manifestUrl: stripTrailingSlash(env.MANIFEST_URL ?? "http://manifest:2099"),
    manifestKey: env.CLASSIFIER_MANIFEST_KEY ?? "",
    tier: env.CLASSIFIER_TIER ?? "default",
    timeoutMs: Number(env.CLASSIFIER_TIMEOUT_MS ?? "800"),
  };
}
