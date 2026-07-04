import { describe, expect, it } from "bun:test";
import { extractLastUserMessage } from "../src/message-extract.js";

describe("extractLastUserMessage", () => {
  it("extracts a plain string content from the last user message", () => {
    const body = {
      messages: [
        { role: "user", content: "primeira pergunta" },
        { role: "assistant", content: "resposta" },
        { role: "user", content: "segunda pergunta, a que importa" },
      ],
    };
    expect(extractLastUserMessage(body)).toBe("segunda pergunta, a que importa");
  });

  it("joins text blocks when content is an array (Anthropic/OpenAI block shape)", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "primeiro bloco" },
            { type: "text", text: "segundo bloco" },
          ],
        },
      ],
    };
    expect(extractLastUserMessage(body)).toBe("primeiro bloco\nsegundo bloco");
  });

  it("ignores non-text blocks (e.g. image) when joining", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "olha essa imagem" },
            { type: "image", source: { type: "base64", data: "..." } },
          ],
        },
      ],
    };
    expect(extractLastUserMessage(body)).toBe("olha essa imagem");
  });

  it("returns null when there is no user message", () => {
    const body = { messages: [{ role: "assistant", content: "oi" }] };
    expect(extractLastUserMessage(body)).toBeNull();
  });

  it("returns null when messages is missing, not an array, or body isn't an object", () => {
    expect(extractLastUserMessage({})).toBeNull();
    expect(extractLastUserMessage({ messages: "oops" })).toBeNull();
    expect(extractLastUserMessage(null)).toBeNull();
    expect(extractLastUserMessage("not even an object")).toBeNull();
  });

  it("returns null when the last user message has empty/whitespace-only text", () => {
    const body = { messages: [{ role: "user", content: "   " }] };
    expect(extractLastUserMessage(body)).toBeNull();
  });

  it("skips null/undefined entries in content array instead of throwing", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [null, { type: "text", text: "hi" }, undefined],
        },
      ],
    };
    expect(extractLastUserMessage(body)).toBe("hi");
  });
});
