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
