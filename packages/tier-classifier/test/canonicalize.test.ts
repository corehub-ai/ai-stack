import { describe, expect, it } from "bun:test";
import { canonicalizeBody } from "../src/canonicalize.js";

describe("canonicalizeBody", () => {
  it("strips temperature/top_p/top_k/thinking and reports which keys it removed", () => {
    const input = JSON.stringify({
      model: "auto",
      messages: [{ role: "user", content: "oi" }],
      temperature: 0.2,
      top_p: 0.9,
      top_k: 40,
      thinking: { type: "enabled", budget_tokens: 1024 },
      max_tokens: 512,
    });
    const { body, stripped } = canonicalizeBody(input);
    const parsed = JSON.parse(body) as Record<string, unknown>;
    expect(stripped.sort()).toEqual(["temperature", "thinking", "top_k", "top_p"]);
    expect(parsed.temperature).toBeUndefined();
    expect(parsed.top_p).toBeUndefined();
    expect(parsed.top_k).toBeUndefined();
    expect(parsed.thinking).toBeUndefined();
    // estrutural preservado
    expect(parsed.model).toBe("auto");
    expect(parsed.max_tokens).toBe(512);
    expect(parsed.messages).toEqual([{ role: "user", content: "oi" }]);
  });

  it("returns the original body untouched (stripped empty) when no denylisted key is present", () => {
    const input = JSON.stringify({ model: "auto", messages: [], max_tokens: 8, stream: true });
    const { body, stripped } = canonicalizeBody(input);
    expect(stripped).toEqual([]);
    expect(body).toBe(input);
  });

  it("only reports keys that were actually present", () => {
    const input = JSON.stringify({ messages: [], temperature: 0 });
    const { stripped } = canonicalizeBody(input);
    expect(stripped).toEqual(["temperature"]);
  });

  it("passes a non-JSON body through untouched (fail-safe)", () => {
    const { body, stripped } = canonicalizeBody("not json at all {");
    expect(body).toBe("not json at all {");
    expect(stripped).toEqual([]);
  });

  it("passes a non-object JSON body (array/number) through untouched", () => {
    expect(canonicalizeBody("[1,2,3]")).toEqual({ body: "[1,2,3]", stripped: [] });
    expect(canonicalizeBody("42")).toEqual({ body: "42", stripped: [] });
  });

  it("passes an empty body through untouched", () => {
    expect(canonicalizeBody("")).toEqual({ body: "", stripped: [] });
  });

  it("removes a temperature that is explicitly null (key present) too", () => {
    // `key in obj` / hasOwn é sobre presença da chave, não sobre o valor --
    // uma temperature: null enviada pelo cliente também some.
    const { stripped } = canonicalizeBody(JSON.stringify({ messages: [], temperature: null }));
    expect(stripped).toEqual(["temperature"]);
  });
});
