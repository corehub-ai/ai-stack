// Decodifica uma linha de stream SSE OpenAI.
// "data: {...}"  → objeto parseado
// "data: [DONE]" → "DONE"
// "" / comentário / linha não-data → null
export function parseSseData(line: string): "DONE" | Record<string, unknown> | null {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith("data:")) return null;
  const payload = trimmed.slice("data:".length).trim();
  if (payload.length === 0) return null;
  if (payload === "[DONE]") return "DONE";
  try {
    return JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return null;
  }
}
