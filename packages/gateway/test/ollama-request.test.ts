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
