import type { ClassifierConfig } from "./config.js";

const VALID_TIERS = new Set(["simple", "complex", "reasoning"]);

const SYSTEM_PROMPT = `Classifique a próxima mensagem do usuário em exatamente uma palavra: simple, complex ou reasoning.
- simple: perguntas diretas, tarefas pequenas e bem definidas.
- complex: implementação de código de maior porte, múltiplos arquivos, refatoração.
- reasoning: planejamento, análise e pensamento profundo -- NÃO implementação de código.
Responda só com a palavra escolhida, nada mais.`;

function parseTierLabel(raw: string): string | null {
  const match = raw
    .trim()
    .toLowerCase()
    .match(/^[a-z]+/);
  const label = match?.[0];
  return label !== undefined && VALID_TIERS.has(label) ? label : null;
}

function isTextBlock(block: unknown): block is { type: "text"; text: string } {
  return (
    typeof block === "object" &&
    block !== null &&
    (block as { type?: unknown }).type === "text" &&
    typeof (block as { text?: unknown }).text === "string"
  );
}

function extractText(body: unknown): string {
  if (typeof body !== "object" || body === null) return "";
  const content = (body as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(isTextBlock)
    .map((block) => block.text)
    .join("");
}

/**
 * Chama o agente dedicado `tier-classifier` no manifest (D6) para classificar
 * `userMessage`. Nunca lança -- qualquer falha (rede, timeout, status não-2xx,
 * label não reconhecido) vira `null`, para o chamador fazer fail-open (D5/D6).
 */
export async function classifyTier(
  config: ClassifierConfig,
  userMessage: string,
): Promise<string | null> {
  try {
    const res = await fetch(`${config.manifestUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.manifestKey}`,
        "x-manifest-tier": config.tier,
      },
      body: JSON.stringify({
        // Valor inerte: o manifest sempre reescreve `model` pelo tier (achado
        // 2026-07-04, ver docs/superpowers/specs/2026-07-04-tier-classifier-design.md D1).
        model: "tier-classifier",
        max_tokens: 8,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMessage }],
      }),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    if (!res.ok) return null;
    const json = await res.json();
    return parseTierLabel(extractText(json));
  } catch {
    return null;
  }
}
