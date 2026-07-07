import { describe, expect, it } from "bun:test";
import { describeRequest, extractModelFromSse } from "../src/request-info.js";

describe("describeRequest", () => {
  it("reports size and content-free param presence/values, never message content", () => {
    const body = JSON.stringify({
      model: "auto",
      max_tokens: 8192,
      stream: true,
      temperature: 0.2,
      thinking: { type: "adaptive" },
      tools: [{ type: "function" }, { type: "function" }],
      messages: [
        { role: "system", content: "SEGREDO-DO-SISTEMA" },
        { role: "user", content: "SEGREDO-DO-USUARIO" },
      ],
    });
    const info = describeRequest(body);
    expect(info).toEqual({
      reqBytes: body.length,
      maxTokens: 8192,
      stream: true,
      tools: 2,
      messages: 2,
      hasThinking: true,
      hasTemperature: true,
    });
    // nunca vaza conteúdo de mensagem
    expect(JSON.stringify(info)).not.toContain("SEGREDO");
  });

  it("returns just reqBytes for a non-JSON body", () => {
    expect(describeRequest("nao é json {")).toEqual({ reqBytes: 12 });
  });

  it("omits params that are absent", () => {
    const body = JSON.stringify({ messages: [{ role: "user", content: "oi" }] });
    expect(describeRequest(body)).toEqual({ reqBytes: body.length, messages: 1 });
  });
});

describe("extractModelFromSse", () => {
  it("extracts model from an OpenAI-style SSE chunk", () => {
    const sse = 'data: {"id":"x","model":"glm-5.2","choices":[{"delta":{"content":"o"}}]}\n\n';
    expect(extractModelFromSse(sse)).toBe("glm-5.2");
  });

  it("extracts model from an Anthropic message_start SSE chunk", () => {
    const sse =
      'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-opus-4-8","role":"assistant"}}\n\n';
    expect(extractModelFromSse(sse)).toBe("claude-opus-4-8");
  });

  it("returns undefined when no data line has a parseable model yet (partial)", () => {
    expect(extractModelFromSse('data: {"id":"x","mod')).toBeUndefined();
    expect(extractModelFromSse("event: ping\n\n")).toBeUndefined();
    expect(extractModelFromSse("data: [DONE]\n\n")).toBeUndefined();
  });
});
