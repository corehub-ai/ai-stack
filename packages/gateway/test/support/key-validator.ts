import type { ManifestKeyValidator } from "../../src/manifest-key.js";

/** Stub que aceita qualquer chave (testes de rota/proxy sem Manifest real). */
export const acceptAllKeys: ManifestKeyValidator = async () => "valid";

/** Stub que rejeita qualquer chave. */
export const rejectAllKeys: ManifestKeyValidator = async () => "invalid";

/** Stub que simula Manifest fora do ar. */
export const unavailableKeys: ManifestKeyValidator = async () => "unavailable";

/** Opções de auth padrão para testes de rota (host-side implícito via IP nos requests). */
export function testAuthOpts(
  defaultKey: string,
  validateKey: ManifestKeyValidator = acceptAllKeys,
) {
  return {
    defaultKey,
    trustedCidrs: [] as string[],
    trustedProxies: [] as string[],
    validateKey,
  };
}
