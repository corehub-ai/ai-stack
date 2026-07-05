// Parâmetros de sampling/thinking que o cliente manda mas que o manifest é dono
// de definir por tier/agente (achado 2026-07-05): `temperature` != 1 junto de
// um modelo Anthropic em thinking/adaptive faz a Anthropic devolver 400
// (`temperature may only be set to 1 when thinking is enabled`). Como o manifest
// resolve o modelo e seus params por tier, esses campos vindos do cliente são
// redundantes na melhor das hipóteses e quebram na pior -- removê-los antes do
// forward é seguro (quem aceita usa o default). Conjunto mínimo escolhido pelo
// usuário: só os que causam a classe de falha (2026-07-05).
const STRIP_KEYS = ["temperature", "top_p", "top_k", "thinking"];

/**
 * Remove os parâmetros de STRIP_KEYS do corpo JSON antes do forward ao manifest.
 * Fail-safe: corpo vazio, não-JSON, ou que não seja um objeto JSON é devolvido
 * intacto -- nunca lança, nunca corrompe uma request. Só reserializa se de fato
 * removeu alguma chave. `stripped` lista os nomes removidos (pro log), nunca os
 * valores.
 */
export function canonicalizeBody(bodyText: string): { body: string; stripped: string[] } {
  if (bodyText.length === 0) return { body: bodyText, stripped: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { body: bodyText, stripped: [] };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { body: bodyText, stripped: [] };
  }

  const obj = parsed as Record<string, unknown>;
  const stripped: string[] = [];
  for (const key of STRIP_KEYS) {
    if (Object.hasOwn(obj, key)) {
      delete obj[key];
      stripped.push(key);
    }
  }
  if (stripped.length === 0) return { body: bodyText, stripped: [] };
  return { body: JSON.stringify(obj), stripped };
}
