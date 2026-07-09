import { describe, expect, it } from "bun:test";
import { resolveModel } from "../src/ollama/models.js";
import { ollamaChatToOpenAi } from "../src/ollama/translate-request.js";
import type { OllamaChatRequest } from "../src/ollama/types.js";

describe("resolveModel", () => {
  it("maps the 'auto' pseudo-model to model=auto with no extra headers", () => {
    expect(resolveModel("auto")).toEqual({ model: "auto", headers: {} });
  });
  it("passes an unknown model name through unchanged", () => {
    expect(resolveModel("llama3:8b")).toEqual({ model: "llama3:8b", headers: {} });
  });
});

describe("ollamaChatToOpenAi", () => {
  it("passes plain user/assistant messages through and carries model as-is", () => {
    const req: OllamaChatRequest = {
      model: "auto",
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "hi" },
      ],
    };
    const out = ollamaChatToOpenAi(req);
    expect(out.model).toBe("auto");
    expect(out.messages).toEqual([
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
    ]);
  });

  it("stringifies assistant tool_call arguments (object → JSON string) for OpenAI", () => {
    const req: OllamaChatRequest = {
      model: "auto",
      messages: [
        { role: "user", content: "weather in Paris?" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "call_1", function: { name: "get_weather", arguments: { city: "Paris" } } },
          ],
        },
      ],
    };
    const out = ollamaChatToOpenAi(req);
    const assistant = out.messages[1] as {
      tool_calls: Array<{
        id: string;
        type: string;
        function: { name: string; arguments: string };
      }>;
    };
    expect(assistant.tool_calls[0]?.function.arguments).toBe('{"city":"Paris"}');
    expect(assistant.tool_calls[0]?.type).toBe("function");
  });

  it("maps a tool-result message's tool_name to the matching tool_call_id from the prior assistant turn", () => {
    const req: OllamaChatRequest = {
      model: "auto",
      messages: [
        { role: "user", content: "weather?" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "call_abc", function: { name: "get_weather", arguments: { city: "Paris" } } },
          ],
        },
        { role: "tool", tool_name: "get_weather", content: "22C" },
      ],
    };
    const out = ollamaChatToOpenAi(req);
    const toolMsg = out.messages[2] as { role: string; tool_call_id: string; content: string };
    expect(toolMsg.role).toBe("tool");
    expect(toolMsg.tool_call_id).toBe("call_abc");
    expect(toolMsg.content).toBe("22C");
  });

  it("translates options and think into OpenAI params", () => {
    const req: OllamaChatRequest = {
      model: "auto",
      messages: [{ role: "user", content: "hi" }],
      think: "max",
      options: { temperature: 0.2, top_p: 0.9, num_predict: 128, stop: ["END"], num_ctx: 4096 },
    };
    const out = ollamaChatToOpenAi(req);
    expect(out.temperature).toBe(0.2);
    expect(out.top_p).toBe(0.9);
    expect(out.max_tokens).toBe(128);
    expect(out.stop).toEqual(["END"]);
    expect(out.reasoning_effort).toBe("high"); // max → high
    expect("num_ctx" in out).toBe(false); // sem equivalente → dropado
  });

  it("forwards tools and requests usage in the stream", () => {
    const req: OllamaChatRequest = {
      model: "auto",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          type: "function",
          function: { name: "f", description: "d", parameters: { type: "object" } },
        },
      ],
    };
    const out = ollamaChatToOpenAi(req);
    expect(out.stream).toBe(true);
    expect(out.stream_options).toEqual({ include_usage: true });
    expect(out.tools).toHaveLength(1);
  });
});

// Providers estritos (deepseek, opencode-go) rejeitam id vazio/duplicado e
// tool_call sem resposta -- reproduzido ao vivo 2026-07-09 (fallback silencioso
// do manifest mascarava como 200). A tradução precisa garantir ids válidos,
// únicos e todos respondidos.
describe("ollamaChatToOpenAi tool_call id hygiene", () => {
  type OutAssistant = {
    role: string;
    tool_calls: Array<{ id: string; function: { name: string } }>;
  };
  type OutTool = { role: string; tool_call_id: string; content: string };

  it("synthesizes unique valid ids for empty tool_call ids and pairs same-name responses FIFO", () => {
    const req: OllamaChatRequest = {
      model: "auto",
      messages: [
        { role: "user", content: "weather Paris and London?" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "", function: { name: "get_weather", arguments: { city: "Paris" } } },
            { id: "", function: { name: "get_weather", arguments: { city: "London" } } },
          ],
        },
        { role: "tool", tool_name: "get_weather", content: "Paris 22C" },
        { role: "tool", tool_name: "get_weather", content: "London 15C" },
      ],
    };
    const out = ollamaChatToOpenAi(req);
    const assistant = out.messages[1] as OutAssistant;
    const [c0, c1] = assistant.tool_calls;
    expect(c0?.id).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(c1?.id).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(c0?.id).not.toBe(c1?.id);
    // FIFO: 1a resposta -> 1o call, 2a -> 2o (ordem é a semântica Ollama)
    expect((out.messages[2] as OutTool).tool_call_id).toBe(c0?.id ?? "");
    expect((out.messages[3] as OutTool).tool_call_id).toBe(c1?.id ?? "");
  });

  it("deduplicates a client id repeated within the same assistant message", () => {
    const req: OllamaChatRequest = {
      model: "auto",
      messages: [
        { role: "user", content: "read two files" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "call_x", function: { name: "read_file", arguments: { path: "a" } } },
            { id: "call_x", function: { name: "read_file", arguments: { path: "b" } } },
          ],
        },
        { role: "tool", tool_name: "read_file", content: "conteudo a" },
        { role: "tool", tool_name: "read_file", content: "conteudo b" },
      ],
    };
    const out = ollamaChatToOpenAi(req);
    const assistant = out.messages[1] as OutAssistant;
    const [c0, c1] = assistant.tool_calls;
    expect(c0?.id).toBe("call_x"); // primeiro uso mantém o id do cliente
    expect(c1?.id).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(c1?.id).not.toBe("call_x");
    expect((out.messages[2] as OutTool).tool_call_id).toBe("call_x");
    expect((out.messages[3] as OutTool).tool_call_id).toBe(c1?.id ?? "");
  });

  it("synthesizes a stub tool response for an unanswered tool_call before the next non-tool message", () => {
    const req: OllamaChatRequest = {
      model: "auto",
      messages: [
        { role: "user", content: "weather in Paris?" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "", function: { name: "get_weather", arguments: { city: "Paris" } } }],
        },
        { role: "user", content: "never mind, just say hi" },
      ],
    };
    const out = ollamaChatToOpenAi(req);
    expect(out.messages).toHaveLength(4); // user, assistant, stub, user
    const assistant = out.messages[1] as OutAssistant;
    const stub = out.messages[2] as OutTool;
    expect(stub.role).toBe("tool");
    expect(stub.tool_call_id).toBe(assistant.tool_calls[0]?.id ?? "");
    expect(stub.content.length).toBeGreaterThan(0);
    expect((out.messages[3] as { role: string }).role).toBe("user");
  });

  it("synthesizes stubs for unanswered tool_calls at the end of the history", () => {
    const req: OllamaChatRequest = {
      model: "auto",
      messages: [
        { role: "user", content: "weather in Paris?" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ function: { name: "get_weather", arguments: { city: "Paris" } } }],
        },
      ],
    };
    const out = ollamaChatToOpenAi(req);
    expect(out.messages).toHaveLength(3); // user, assistant, stub
    const assistant = out.messages[1] as OutAssistant;
    const stub = out.messages[2] as OutTool;
    expect(stub.role).toBe("tool");
    expect(stub.tool_call_id).toBe(assistant.tool_calls[0]?.id ?? "");
  });

  it("pairs a tool message lacking tool_name with the oldest pending call", () => {
    const req: OllamaChatRequest = {
      model: "auto",
      messages: [
        { role: "user", content: "weather?" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ function: { name: "get_weather", arguments: { city: "Paris" } } }],
        },
        { role: "tool", content: "22C" },
      ],
    };
    const out = ollamaChatToOpenAi(req);
    const assistant = out.messages[1] as OutAssistant;
    const toolMsg = out.messages[2] as OutTool;
    expect(toolMsg.tool_call_id).toBe(assistant.tool_calls[0]?.id ?? "");
  });
});

// deepseek também rejeita DECLARAÇÃO de tool com schema nulo ("null is not of
// type object" / "got 'type: null'") -- harness ollama-js declara tools sem
// parâmetros assim (reproduzido ao vivo 2026-07-09). parameters AUSENTE ele
// aceita; só o presente-mas-nulo precisa de normalização.
describe("ollamaChatToOpenAi tool schema hygiene", () => {
  type OutTools = Array<{ type: string; function: { name: string; parameters?: unknown } }>;
  const MESSAGES: OllamaChatRequest["messages"] = [{ role: "user", content: "hi" }];

  it("normalizes parameters with null type/properties into a valid object schema", () => {
    const req: OllamaChatRequest = {
      model: "auto",
      messages: MESSAGES,
      tools: [
        {
          type: "function",
          function: {
            name: "terminal_last_command",
            description: "d",
            parameters: { type: null, properties: null },
          },
        },
      ],
    };
    const tools = ollamaChatToOpenAi(req).tools as OutTools;
    expect(tools[0]?.function.parameters).toEqual({ type: "object", properties: {} });
  });

  it("replaces a literal null parameters with a minimal object schema", () => {
    const req: OllamaChatRequest = {
      model: "auto",
      messages: MESSAGES,
      tools: [
        {
          type: "function",
          function: { name: "f", description: "d", parameters: null },
        },
      ],
    };
    const tools = ollamaChatToOpenAi(req).tools as OutTools;
    expect(tools[0]?.function.parameters).toEqual({ type: "object", properties: {} });
  });

  it("patches a null type but preserves the rest of the schema", () => {
    const req: OllamaChatRequest = {
      model: "auto",
      messages: MESSAGES,
      tools: [
        {
          type: "function",
          function: {
            name: "f",
            description: "d",
            parameters: {
              type: null,
              properties: { city: { type: "string" } },
              required: ["city"],
            },
          },
        },
      ],
    };
    const tools = ollamaChatToOpenAi(req).tools as OutTools;
    expect(tools[0]?.function.parameters).toEqual({
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    });
  });

  it("leaves absent parameters absent and valid schemas untouched", () => {
    const valid = {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    };
    const req: OllamaChatRequest = {
      model: "auto",
      messages: MESSAGES,
      tools: [
        { type: "function", function: { name: "no_args", description: "d" } },
        {
          type: "function",
          function: { name: "get_weather", description: "d", parameters: valid },
        },
      ],
    };
    const tools = ollamaChatToOpenAi(req).tools as OutTools;
    expect("parameters" in (tools[0]?.function ?? {})).toBe(false);
    expect(tools[1]?.function.parameters).toEqual(valid);
  });
});
