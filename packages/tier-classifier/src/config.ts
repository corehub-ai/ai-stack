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

// Number("abc") vira NaN sem avisar -- Bun.serve({port: NaN}) falha na subida
// e AbortSignal.timeout(NaN) quebra toda chamada de classificação (achado do
// coderabbit, 2026-07-04). Cai no default em vez de propagar NaN silencioso.
function parseNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): ClassifierConfig {
  return {
    port: parseNumber(env.CLASSIFIER_PORT, 8788),
    manifestUrl: stripTrailingSlash(env.MANIFEST_URL ?? "http://manifest:2099"),
    manifestKey: env.CLASSIFIER_MANIFEST_KEY ?? "",
    tier: env.CLASSIFIER_TIER ?? "default",
    timeoutMs: parseNumber(env.CLASSIFIER_TIMEOUT_MS, 800),
  };
}
