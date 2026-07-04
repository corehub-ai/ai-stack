type ContentBlock = { type?: string; text?: string };
type Message = { role?: string; content?: string | ContentBlock[] };
type ClassifiableBody = { messages?: Message[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .filter((block) => isRecord(block) && block.type === "text" && typeof block.text === "string")
      .map((block) => (block as ContentBlock).text as string)
      .join("\n");
  }
  return "";
}

/**
 * Última mensagem do usuário em um body de /v1/messages (Anthropic) ou
 * /v1/chat/completions (OpenAI) -- as duas usam o mesmo shape de `messages`.
 * Retorna null se não houver mensagem de usuário com texto não-vazio.
 */
export function extractLastUserMessage(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const messages = (body as ClassifiableBody).messages;
  if (!Array.isArray(messages)) return null;

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (isRecord(message) && message.role === "user") {
      const text = messageText(message as Message).trim();
      return text.length > 0 ? text : null;
    }
  }
  return null;
}
