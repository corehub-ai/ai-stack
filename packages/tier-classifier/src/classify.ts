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

// AbortSignal.timeout() lança um DOMException com esse name exato ao expirar
// (confirmado empiricamente, Bun 1.3.x) -- distinto de erro de rede/status.
function isTimeoutError(err: unknown): boolean {
  return (
    typeof err === "object" && err !== null && (err as { name?: unknown }).name === "TimeoutError"
  );
}

async function attemptClassify(
  config: ClassifierConfig,
  userMessage: string,
  timeoutMs: number,
): Promise<string | null> {
  const res = await fetch(`${config.manifestUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.manifestKey}`,
      "x-manifest-tier": config.tier,
    },
    body: JSON.stringify({
      // Valor inerte: o manifest sempre reescreve `model` pelo tier (achado
      // 2026-07-04, ver memória manifest-gateway-gotchas).
      model: "tier-classifier",
      max_tokens: 8,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) return null;
  const json = await res.json();
  return parseTierLabel(extractText(json));
}

/**
 * Chama o agente dedicado `tier-classifier` no manifest (D6) para classificar
 * `userMessage`. Nunca lança -- qualquer falha (rede, timeout, status não-2xx,
 * label não reconhecido) vira `null`, para o chamador fazer fail-open (D5/D6).
 *
 * Se a 1a tentativa estourar especificamente o timeout -- sintoma de
 * cold-load do modelo local (achado 2026-07-05, ver [[ia-stack-goal]]) --
 * tenta 1 vez a mais com timeoutMs + coldLoadExtraMs. Qualquer outra falha
 * (status não-2xx, rede, label inválido) não tem retry: mais tempo não
 * resolveria um erro que já não é de demora.
 */
export async function classifyTier(
  config: ClassifierConfig,
  userMessage: string,
): Promise<string | null> {
  try {
    return await attemptClassify(config, userMessage, config.timeoutMs);
  } catch (err) {
    if (!isTimeoutError(err)) return null;
  }
  try {
    return await attemptClassify(config, userMessage, config.timeoutMs + config.coldLoadExtraMs);
  } catch {
    return null;
  }
}
