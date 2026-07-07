// Caracterização content-free da request, pro log de diagnóstico. NUNCA inclui
// conteúdo de mensagem -- só tamanho e presença/valor de parâmetros, pra
// correlacionar falha (ex.: fallback do opus) com tamanho/tools/params sem
// vazar prompt. Achado 2026-07-06: reprodução sintética não pega a falha real;
// instrumentar o caminho real é o caminho.
export function describeRequest(bodyText: string): Record<string, unknown> {
  const info: Record<string, unknown> = { reqBytes: bodyText.length };
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return info;
  }
  if (typeof parsed !== "object" || parsed === null) return info;
  const b = parsed as Record<string, unknown>;
  if (typeof b.max_tokens === "number") info.maxTokens = b.max_tokens;
  if (typeof b.stream === "boolean") info.stream = b.stream;
  if (Array.isArray(b.tools)) info.tools = b.tools.length;
  if (Array.isArray(b.messages)) info.messages = b.messages.length;
  if (b.thinking !== undefined) info.hasThinking = true;
  if (b.temperature !== undefined) info.hasTemperature = true;
  return info;
}

// Extrai o `model` das primeiras linhas de uma resposta SSE. Cobre os dois
// shapes: OpenAI (`data: {..., "model": "..."}`) e Anthropic (`data:
// {"type":"message_start","message":{"model":"..."}}`). undefined se nenhuma
// linha data: parseável tiver model ainda. Revela o fallback do manifest
// (pediu opus, veio glm-5.2) em streaming, onde antes éramos cegos.
export function extractModelFromSse(text: string): string | undefined {
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "" || payload === "[DONE]") continue;
    let j: unknown;
    try {
      j = JSON.parse(payload);
    } catch {
      continue; // linha data: ainda parcial -- espera o próximo chunk
    }
    if (typeof j !== "object" || j === null) continue;
    const top = (j as { model?: unknown }).model;
    if (typeof top === "string") return top;
    const msg = (j as { message?: { model?: unknown } }).message;
    if (msg !== undefined && typeof msg.model === "string") return msg.model;
  }
  return undefined;
}
