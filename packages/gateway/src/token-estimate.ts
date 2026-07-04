// Estimativa local de tokens para POST /v1/messages/count_tokens.
//
// Por que local: manifest 6.13.3 não implementa a rota (404 na cadeia
// gateway -> headroom -> manifest), e o headroom só faz passthrough. Sem uma
// resposta 200 aqui, o Claude Code cai em estimativa própria e trava a sessão
// com "Context limit reached".
//
// Heurística: chars/3.2 por token. O headroom 0.27.0 usa ~3.5 chars/token para
// modelos claude-*; usamos 3.2 (≈9% a mais) de propósito — o Claude Code usa a
// contagem para decidir quando compactar, então SUPERestimar é seguro e
// subestimar causa 400 "prompt is too long" no provider.
const CHARS_PER_TOKEN = 3.2;
const BASE_OVERHEAD_TOKENS = 8;
const PER_MESSAGE_OVERHEAD_TOKENS = 5;
const PER_BLOCK_OVERHEAD_TOKENS = 4;
// Imagem: custo fixo — a API faz downscale e o teto documentado é ~1600 tokens
// (~1.15 MP). Nunca conte os bytes do base64 de imagem como texto.
const IMAGE_BLOCK_TOKENS = 1600;
// Documento (PDF) NÃO tem teto: a API cobra ~1500-3000 tokens POR PÁGINA (até
// 600 páginas). Escalamos pelo tamanho do base64 (~50 KB/página ≈ 67k chars)
// no teto de 3000/página; custo fixo aqui subestimaria PDFs reais em 20-30x.
const DOCUMENT_MIN_TOKENS = 2600;
const DOCUMENT_TOKENS_PER_PAGE = 3000;
const DOCUMENT_BASE64_CHARS_PER_PAGE = 67_000;
// Runs longos de base64/hex (lockfiles com sha512, bundles, dumps) tokenizam
// a ~2.5-3 chars/token — bem mais denso que prosa. Peso extra para não comer
// a margem de segurança da heurística justamente nos blocos que dominam.
const DENSE_RUN = /[A-Za-z0-9+/=]{64,}/g;
const DENSE_RUN_EXTRA_PER_CHAR = CHARS_PER_TOKEN / 2.5 - 1;
const WEIGHTED_CHAR_PROBE = /[Ͱ-\u{10ffff}]/u;

export type EstimateResult = { ok: true; inputTokens: number } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * "Chars equivalentes" de um texto: penaliza scripts que tokenizam mais denso
 * que prosa latina. CJK/kana/hangul ≈ 1 token/char (peso CHARS_PER_TOKEN);
 * demais não-latinos (grego, cirílico, árabe, ...) ≈ 1.6 chars/token (peso 2);
 * runs longos base64/hex ≈ 2.5 chars/token. Sem isso, chars/3.2 subestima CJK
 * em 3-6x — e subestimar é o modo de falha perigoso (400 no provider).
 */
function weightedChars(text: string): number {
  let chars = text.length;
  if (WEIGHTED_CHAR_PROBE.test(text)) {
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code < 0x0370) continue;
      chars += code >= 0x2e80 ? CHARS_PER_TOKEN - 1 : 1;
    }
  }
  for (const run of text.match(DENSE_RUN) ?? []) {
    chars += run.length * DENSE_RUN_EXTRA_PER_CHAR;
  }
  return chars;
}

function safeJsonLength(value: unknown): number {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? 0 : weightedChars(json);
  } catch {
    return 0;
  }
}

/** Custo de um bloco document em "chars equivalentes", conforme a source. */
function documentChars(block: Record<string, unknown>): number {
  const source = isRecord(block.source) ? block.source : undefined;
  if (source) {
    // source.type "text": a API cobra o texto integral, conte como texto.
    if (source.type === "text" && typeof source.data === "string") {
      return weightedChars(source.data);
    }
    // source.type "content": blocos aninhados, conte recursivamente.
    if (source.type === "content") {
      return contentChars(source.content);
    }
    if (source.type === "base64" && typeof source.data === "string") {
      const pages = Math.max(1, Math.ceil(source.data.length / DOCUMENT_BASE64_CHARS_PER_PAGE));
      return pages * DOCUMENT_TOKENS_PER_PAGE * CHARS_PER_TOKEN;
    }
  }
  // url/desconhecido: sem como saber o tamanho localmente; piso documentado.
  return DOCUMENT_MIN_TOKENS * CHARS_PER_TOKEN;
}

/** Chars de um bloco de content Anthropic; mídia vira custo fixo em "chars equivalentes". */
function blockChars(block: unknown): number {
  if (typeof block === "string") return weightedChars(block);
  if (!isRecord(block)) return safeJsonLength(block);

  switch (block.type) {
    case "text":
      return typeof block.text === "string" ? weightedChars(block.text) : 0;
    case "thinking":
      return typeof block.thinking === "string" ? weightedChars(block.thinking) : 0;
    case "image":
      return IMAGE_BLOCK_TOKENS * CHARS_PER_TOKEN;
    case "document":
      return documentChars(block);
    case "tool_use":
      return (typeof block.name === "string" ? block.name.length : 0) + safeJsonLength(block.input);
    case "tool_result": {
      const inner = block.content;
      if (typeof inner === "string") return weightedChars(inner);
      if (Array.isArray(inner)) {
        return inner.reduce<number>((sum, item) => sum + blockChars(item), 0);
      }
      return safeJsonLength(inner);
    }
    default:
      // Bloco desconhecido (server_tool_use, redacted_thinking, ...): o JSON
      // inteiro superestima levemente, que é o lado seguro.
      return safeJsonLength(block);
  }
}

function contentChars(content: unknown): number {
  if (typeof content === "string") return weightedChars(content);
  if (Array.isArray(content)) {
    return content.reduce<number>((sum, block) => sum + blockChars(block), 0);
  }
  return safeJsonLength(content);
}

function contentBlockCount(content: unknown): number {
  return Array.isArray(content) ? content.length : 1;
}

/**
 * Estima input_tokens de um body de /v1/messages (system, messages, tools).
 * Retorna erro (para virar 400 invalid_request_error) se o shape básico
 * exigido pela API real estiver ausente.
 */
export function estimateInputTokens(body: unknown): EstimateResult {
  if (!isRecord(body)) {
    return { ok: false, error: "count_tokens: request body must be a JSON object" };
  }
  if (!Array.isArray(body.messages)) {
    return { ok: false, error: "count_tokens: messages: field required and must be an array" };
  }

  let chars = 0;
  let overheadTokens = BASE_OVERHEAD_TOKENS;

  if (body.system !== undefined) {
    chars += contentChars(body.system);
    overheadTokens += PER_BLOCK_OVERHEAD_TOKENS * contentBlockCount(body.system);
  }

  for (const message of body.messages) {
    overheadTokens += PER_MESSAGE_OVERHEAD_TOKENS;
    if (!isRecord(message)) {
      chars += safeJsonLength(message);
      continue;
    }
    chars += contentChars(message.content);
    overheadTokens += PER_BLOCK_OVERHEAD_TOKENS * contentBlockCount(message.content);
  }

  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      chars += safeJsonLength(tool);
      overheadTokens += PER_BLOCK_OVERHEAD_TOKENS;
    }
  }

  return { ok: true, inputTokens: Math.ceil(chars / CHARS_PER_TOKEN) + overheadTokens };
}
