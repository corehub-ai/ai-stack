export type PseudoModel = {
  /** modelo real mandado ao manifest (ou "auto" pra roteamento) */
  model: string;
  /** headers extras (ex.: seleção de tier) — vazio por enquanto */
  headers: Record<string, string>;
  /** metadata pra /api/show */
  contextLength: number;
  capabilities: string[];
};

// F3: só "auto". Estrutura pronta pra corehub-fast/deep (header x-manifest-tier)
// quando os tiers existirem no manifest (spec §4.3).
export const PSEUDO_MODELS: Record<string, PseudoModel> = {
  auto: {
    model: "auto",
    headers: {},
    contextLength: 200000,
    capabilities: ["completion", "tools"],
  },
};

export function resolveModel(name: string): { model: string; headers: Record<string, string> } {
  const pseudo = PSEUDO_MODELS[name];
  if (pseudo) return { model: pseudo.model, headers: pseudo.headers };
  // Nome desconhecido passa direto (cliente pode pedir um id real se o manifest expuser).
  return { model: name, headers: {} };
}

// Data fixa e determinística pros campos que o Ollama real preencheria com
// metadata do arquivo GGUF — clientes só precisam de name/model/details.
const SYNTHETIC_MODIFIED_AT = "2026-07-03T00:00:00Z";
// digest de 64 hex e size não-zero de propósito: o `ollama` CLI faz
// digest[:12] no `list` e dá panic com string vazia (verificado ao vivo).
const SYNTHETIC_DIGEST = "0".repeat(64);
const SYNTHETIC_SIZE = 1;

export function buildTags(): { models: unknown[] } {
  const models = Object.entries(PSEUDO_MODELS).map(([name, meta]) => ({
    name,
    model: name,
    modified_at: SYNTHETIC_MODIFIED_AT,
    size: SYNTHETIC_SIZE,
    digest: SYNTHETIC_DIGEST,
    details: {
      parent_model: "",
      format: "gguf",
      family: "corehub",
      families: ["corehub"],
      parameter_size: "",
      quantization_level: "",
      context_length: meta.contextLength,
    },
    capabilities: meta.capabilities,
  }));
  return { models };
}

export function buildShow(model: string): Record<string, unknown> | null {
  const meta = PSEUDO_MODELS[model];
  if (!meta) return null;
  return {
    capabilities: meta.capabilities,
    details: {
      parent_model: "",
      format: "gguf",
      family: "corehub",
      families: ["corehub"],
      parameter_size: "",
      quantization_level: "",
    },
    model_info: {
      "general.architecture": "corehub",
      // ambas as chaves: clientes olham ora "general.context_length",
      // ora "<arch>.context_length" (formato real do Ollama)
      "general.context_length": meta.contextLength,
      "corehub.context_length": meta.contextLength,
    },
    modified_at: SYNTHETIC_MODIFIED_AT,
  };
}
