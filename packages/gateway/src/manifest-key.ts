import { createHash } from "node:crypto";

export type KeyValidation = "valid" | "invalid" | "unavailable";

export type ManifestKeyValidator = (credential: string) => Promise<KeyValidation>;

export type ManifestKeyValidatorOptions = {
  manifestUrl: string;
  /** Override de fetch (testes). */
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  /** TTL do cache de chaves válidas (ms). Default 60s. */
  positiveTtlMs?: number;
  /** TTL do cache de chaves inválidas (ms). Default 5s. */
  negativeTtlMs?: number;
  /** Timeout do probe (ms). Default 3000. */
  timeoutMs?: number;
};

type CacheEntry = { result: KeyValidation; expiresAt: number };

/**
 * Valida uma chave `mnfst_*` contra o Manifest com `GET /v1/models` (sem custo
 * de LLM). Não há endpoint dedicado de verify na imagem Manifest 6.x — o proxy
 * autenticado é a fonte de verdade (M005 = chave desconhecida).
 *
 * Sempre fala direto com `manifestUrl` (nunca via headroom): headroom já
 * mascarou 401 como 200 em cenários anteriores.
 */
export function createManifestKeyValidator(
  opts: ManifestKeyValidatorOptions,
): ManifestKeyValidator {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const positiveTtlMs = opts.positiveTtlMs ?? 60_000;
  const negativeTtlMs = opts.negativeTtlMs ?? 5_000;
  const timeoutMs = opts.timeoutMs ?? 3_000;
  const cache = new Map<string, CacheEntry>();

  return async (credential: string): Promise<KeyValidation> => {
    const fp = fingerprint(credential);
    const now = Date.now();
    const hit = cache.get(fp);
    if (hit !== undefined && hit.expiresAt > now) return hit.result;

    let result: KeyValidation;
    try {
      const res = await fetchImpl(`${opts.manifestUrl}/v1/models`, {
        method: "GET",
        headers: { authorization: `Bearer ${credential}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 200) result = "valid";
      else if (res.status === 401) result = "invalid";
      else result = "unavailable";
    } catch {
      result = "unavailable";
    }

    const ttl = result === "valid" ? positiveTtlMs : result === "invalid" ? negativeTtlMs : 0;
    if (ttl > 0) cache.set(fp, { result, expiresAt: now + ttl });
    else cache.delete(fp);

    return result;
  };
}

function fingerprint(credential: string): string {
  return createHash("sha256").update(credential).digest("hex");
}
