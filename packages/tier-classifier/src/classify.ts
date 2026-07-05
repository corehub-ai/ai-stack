import type { ClassifierConfig } from "./config.js";

const VALID_TIERS = new Set(["simple", "complex", "reasoning"]);

const SYSTEM_PROMPT = `Classifique a próxima mensagem do usuário em exatamente uma palavra: simple, complex ou reasoning.
- simple: perguntas diretas, tarefas pequenas e bem definidas.
- complex: implementação de código de maior porte, múltiplos arquivos, refatoração.
- reasoning: planejamento, análise e pensamento profundo -- NÃO implementação de código.
Responda só com a palavra escolhida, nada mais.`;

// Por que a classificação falhou -- content-free, pro chamador logar (achado
// 2026-07-05: `tier: null` sozinho não distingue "manifest devolveu erro" de
// "modelo demorou" de "modelo respondeu algo fora do vocabulário"; sem essa
// distinção, uma chave/agente mal configurado é indistinguível de cold-load).
export type ClassifyFailure =
  | { kind: "http-error"; status: number; bodySnippet: string }
  | { kind: "timeout" }
  | { kind: "network-error"; detail: string }
  | { kind: "invalid-label"; raw: string };

export type ClassifyResult = {
  tier: string | null;
  failure?: ClassifyFailure;
};

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

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function attemptClassify(
  config: ClassifierConfig,
  userMessage: string,
  timeoutMs: number,
): Promise<ClassifyResult> {
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
  if (!res.ok) {
    let bodySnippet = "";
    try {
      bodySnippet = (await res.text()).slice(0, 500);
    } catch {
      // corpo ilegível -- o status sozinho já é o sinal
    }
    return { tier: null, failure: { kind: "http-error", status: res.status, bodySnippet } };
  }
  const json = await res.json();
  const raw = extractText(json);
  const tier = parseTierLabel(raw);
  if (tier === null) {
    return { tier: null, failure: { kind: "invalid-label", raw: raw.slice(0, 200) } };
  }
  return { tier };
}

/**
 * Chama o agente dedicado `tier-classifier` no manifest (D6) para classificar
 * `userMessage`. Nunca lança -- qualquer falha (rede, timeout, status não-2xx,
 * label não reconhecido) vira `{ tier: null, failure }`, para o chamador fazer
 * fail-open (D5/D6) e logar o motivo.
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
): Promise<ClassifyResult> {
  try {
    return await attemptClassify(config, userMessage, config.timeoutMs);
  } catch (err) {
    if (!isTimeoutError(err)) {
      return { tier: null, failure: { kind: "network-error", detail: errMessage(err) } };
    }
    // timeout na 1a tentativa = sintoma de cold-load -> retry com budget estendido
  }
  try {
    return await attemptClassify(config, userMessage, config.timeoutMs + config.coldLoadExtraMs);
  } catch (err) {
    return {
      tier: null,
      failure: isTimeoutError(err)
        ? { kind: "timeout" }
        : { kind: "network-error", detail: errMessage(err) },
    };
  }
}
