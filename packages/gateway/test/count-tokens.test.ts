import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { type AuthEnv, createAuthMiddleware } from "../src/auth.js";
import type { GatewayConfig } from "../src/config.js";
import { registerAnthropicRoutes } from "../src/routes/anthropic.js";

// headroomUrl aponta para uma porta inalcançável de propósito: a rota
// count_tokens deve responder LOCALMENTE, sem proxy pro headroom/manifest
// (manifest 6.13.3 devolve 404 na cadeia inteira).
function buildApp() {
  const config: GatewayConfig = {
    port: 0,
    headroomUrl: "http://127.0.0.1:1",
    manifestUrl: "http://unused:2099",
    trustedCidrs: [],
    defaultKey: "mnfst_default",
    corsOrigins: [],
    ollamaVersion: "0.31.1",
    ollamaDefaultKey: "mnfst_default",
  };
  const app = new Hono<AuthEnv>();
  app.use("*", createAuthMiddleware(config));
  registerAnthropicRoutes(app, config);
  return app;
}

async function countTokens(app: Hono<AuthEnv>, body: string): Promise<Response> {
  return app.request(
    "/v1/messages/count_tokens",
    {
      method: "POST",
      headers: {
        authorization: "Bearer mnfst_claude-code",
        "content-type": "application/json",
      },
      body,
    },
    { ip: "127.0.0.1" },
  );
}

type CountTokensResponse = { input_tokens: number };
type AnthropicError = { type: string; error: { type: string; message: string } };

describe("POST /v1/messages/count_tokens (respondido localmente)", () => {
  it("responds 200 with only input_tokens (number) for a simple text message", async () => {
    const app = buildApp();
    const res = await countTokens(
      app,
      JSON.stringify({
        model: "claude-sonnet-5",
        messages: [{ role: "user", content: "Oi, tudo bem? Preciso de ajuda com um bug." }],
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as CountTokensResponse;
    expect(Object.keys(body)).toEqual(["input_tokens"]);
    expect(typeof body.input_tokens).toBe("number");
    expect(Number.isInteger(body.input_tokens)).toBe(true);
    expect(body.input_tokens).toBeGreaterThan(0);
  });

  it("estimate grows with input size and slightly overestimates (>= chars/3.5)", async () => {
    const app = buildApp();
    const short = "a".repeat(350);
    const long = "a".repeat(3500);

    const resShort = await countTokens(
      app,
      JSON.stringify({ model: "claude-sonnet-5", messages: [{ role: "user", content: short }] }),
    );
    const resLong = await countTokens(
      app,
      JSON.stringify({ model: "claude-sonnet-5", messages: [{ role: "user", content: long }] }),
    );
    const shortTokens = ((await resShort.json()) as CountTokensResponse).input_tokens;
    const longTokens = ((await resLong.json()) as CountTokensResponse).input_tokens;

    expect(longTokens).toBeGreaterThan(shortTokens);
    // Conservador: nunca abaixo da heurística de 3.5 chars/token do headroom
    // (subestimar faria o Claude Code enviar prompts que estouram no provider).
    expect(longTokens).toBeGreaterThanOrEqual(Math.ceil(3500 / 3.5));
  });

  it("counts content blocks: text, tool_use input and tool_result content", async () => {
    const app = buildApp();
    const baseline = await countTokens(
      app,
      JSON.stringify({
        model: "claude-sonnet-5",
        messages: [{ role: "user", content: [{ type: "text", text: "run it" }] }],
      }),
    );
    const withTools = await countTokens(
      app,
      JSON.stringify({
        model: "claude-sonnet-5",
        messages: [
          { role: "user", content: [{ type: "text", text: "run it" }] },
          {
            role: "assistant",
            content: [
              { type: "text", text: "running the command now" },
              {
                type: "tool_use",
                id: "toolu_01",
                name: "bash",
                input: { command: "ls -la /home/user/project", description: "list files" },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_01",
                content: [{ type: "text", text: "file-a.ts\nfile-b.ts\n".repeat(50) }],
              },
            ],
          },
        ],
      }),
    );
    const baseTokens = ((await baseline.json()) as CountTokensResponse).input_tokens;
    const toolTokens = ((await withTools.json()) as CountTokensResponse).input_tokens;
    // O tool_result sozinho tem ~1000 chars; a diferença precisa refletir isso.
    expect(toolTokens).toBeGreaterThan(baseTokens + 200);
  });

  it("counts system as string and as blocks", async () => {
    const app = buildApp();
    const sys =
      "You are a helpful assistant specialized in Brazilian public procurement law.".repeat(10);
    const noSystem = await countTokens(
      app,
      JSON.stringify({ model: "claude-sonnet-5", messages: [{ role: "user", content: "hi" }] }),
    );
    const stringSystem = await countTokens(
      app,
      JSON.stringify({
        model: "claude-sonnet-5",
        system: sys,
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    const blockSystem = await countTokens(
      app,
      JSON.stringify({
        model: "claude-sonnet-5",
        system: [{ type: "text", text: sys, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    const none = ((await noSystem.json()) as CountTokensResponse).input_tokens;
    const asString = ((await stringSystem.json()) as CountTokensResponse).input_tokens;
    const asBlocks = ((await blockSystem.json()) as CountTokensResponse).input_tokens;
    expect(asString).toBeGreaterThan(none + 100);
    expect(asBlocks).toBeGreaterThan(none + 100);
  });

  it("counts tool definitions", async () => {
    const app = buildApp();
    const withoutTools = await countTokens(
      app,
      JSON.stringify({ model: "claude-sonnet-5", messages: [{ role: "user", content: "hi" }] }),
    );
    const withTools = await countTokens(
      app,
      JSON.stringify({
        model: "claude-sonnet-5",
        messages: [{ role: "user", content: "hi" }],
        tools: [
          {
            name: "bash",
            description: "Executes a bash command and returns its stdout and stderr. ".repeat(10),
            input_schema: {
              type: "object",
              properties: {
                command: { type: "string", description: "The shell command to execute" },
                timeout: { type: "number", description: "Timeout in milliseconds" },
              },
              required: ["command"],
            },
          },
        ],
      }),
    );
    const bare = ((await withoutTools.json()) as CountTokensResponse).input_tokens;
    const tooled = ((await withTools.json()) as CountTokensResponse).input_tokens;
    expect(tooled).toBeGreaterThan(bare + 100);
  });

  it("charges images/documents a fixed cost instead of counting base64 bytes as text", async () => {
    const app = buildApp();
    const base64 = "iVBORw0KGgoAAAANSUhEUg".repeat(10000); // ~220k chars de base64
    const res = await countTokens(
      app,
      JSON.stringify({
        model: "claude-sonnet-5",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "what is in this image?" },
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: base64 },
              },
            ],
          },
        ],
      }),
    );
    const tokens = ((await res.json()) as CountTokensResponse).input_tokens;
    // Contado como texto seria >60k tokens; custo fixo por bloco fica bem abaixo.
    expect(tokens).toBeLessThan(6000);
    expect(tokens).toBeGreaterThanOrEqual(1000);
  });

  it("weighs CJK text at ~1 token/char instead of chars/3.2", async () => {
    const app = buildApp();
    const ascii = "palavra ".repeat(125); // 1000 chars de prosa (sem run denso)
    const cjk = "中".repeat(1000);
    const resAscii = await countTokens(
      app,
      JSON.stringify({ model: "claude-sonnet-5", messages: [{ role: "user", content: ascii }] }),
    );
    const resCjk = await countTokens(
      app,
      JSON.stringify({ model: "claude-sonnet-5", messages: [{ role: "user", content: cjk }] }),
    );
    const asciiTokens = ((await resAscii.json()) as CountTokensResponse).input_tokens;
    const cjkTokens = ((await resCjk.json()) as CountTokensResponse).input_tokens;
    // Tokenizers Claude geram ~1-2 tokens por char CJK; chars/3.2 daria ~313.
    expect(cjkTokens).toBeGreaterThanOrEqual(1000);
    expect(cjkTokens).toBeGreaterThan(asciiTokens * 2.5);
  });

  it("weighs long base64/hex runs inside text blocks denser than prose", async () => {
    const app = buildApp();
    // Um blob base64 contíguo de ~110k chars (ex.: hash/artefato colado num
    // tool_result) — runs de [A-Za-z0-9+/=] com 64+ chars disparam o peso denso.
    const dense = "Zm9vYmFyYmF6cXV4".repeat(6875);
    const res = await countTokens(
      app,
      JSON.stringify({
        model: "claude-sonnet-5",
        messages: [
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "t1", content: dense }],
          },
        ],
      }),
    );
    const tokens = ((await res.json()) as CountTokensResponse).input_tokens;
    // A ~2.5 chars/token, 110k chars densos são ~44k tokens; chars/3.2 daria ~34k.
    expect(tokens).toBeGreaterThanOrEqual(Math.ceil(dense.length / 2.6));
  });

  it("scales document (PDF base64) cost by size instead of a fixed cost", async () => {
    const app = buildApp();
    const thirtyPagesBase64 = "A".repeat(30 * 67_000); // ~30 páginas (~50 KB/página)
    const res = await countTokens(
      app,
      JSON.stringify({
        model: "claude-sonnet-5",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "summarize this document" },
              {
                type: "document",
                source: {
                  type: "base64",
                  media_type: "application/pdf",
                  data: thirtyPagesBase64,
                },
              },
            ],
          },
        ],
      }),
    );
    const tokens = ((await res.json()) as CountTokensResponse).input_tokens;
    // ~1500-3000 tokens/página na API real: 30 páginas nunca são 2600 fixos.
    expect(tokens).toBeGreaterThanOrEqual(30 * 1500);
  });

  it("counts document with text source as full text", async () => {
    const app = buildApp();
    const textDoc = "Artigo 37 da Constituição Federal trata dos princípios. ".repeat(700);
    const res = await countTokens(
      app,
      JSON.stringify({
        model: "claude-sonnet-5",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "document",
                source: { type: "text", media_type: "text/plain", data: textDoc },
              },
            ],
          },
        ],
      }),
    );
    const tokens = ((await res.json()) as CountTokensResponse).input_tokens;
    expect(tokens).toBeGreaterThanOrEqual(Math.ceil(textDoc.length / 3.5));
  });

  it("returns 400 with Anthropic error shape for a non-JSON body", async () => {
    const app = buildApp();
    const res = await countTokens(app, "isto nao e json {");
    expect(res.status).toBe(400);
    const body = (await res.json()) as AnthropicError;
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("invalid_request_error");
    expect(typeof body.error.message).toBe("string");
  });

  it("returns 400 with Anthropic error shape when messages is missing or not an array", async () => {
    const app = buildApp();
    const missing = await countTokens(app, JSON.stringify({ model: "claude-sonnet-5" }));
    expect(missing.status).toBe(400);
    const missingBody = (await missing.json()) as AnthropicError;
    expect(missingBody.type).toBe("error");
    expect(missingBody.error.type).toBe("invalid_request_error");

    const wrongType = await countTokens(
      app,
      JSON.stringify({ model: "claude-sonnet-5", messages: "oops" }),
    );
    expect(wrongType.status).toBe(400);
  });

  it("still sits behind the auth middleware (401 without credential from untrusted ip)", async () => {
    const app = buildApp();
    const res = await app.request(
      "/v1/messages/count_tokens",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-5", messages: [] }),
      },
      { ip: "203.0.113.7" },
    );
    expect(res.status).toBe(401);
  });
});
