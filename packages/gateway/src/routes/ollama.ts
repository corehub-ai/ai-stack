import type { Context, Hono } from "hono";
import type { AuthEnv } from "../auth.js";
import type { GatewayConfig } from "../config.js";
import { buildShow, buildTags, resolveModel } from "../ollama/models.js";
import {
  translateChatNonStream,
  translateChatStream,
  translateGenerateNonStream,
  translateGenerateStream,
} from "../ollama/translate-chat.js";
import { ollamaChatToOpenAi } from "../ollama/translate-request.js";
import type {
  OllamaChatChunk,
  OllamaChatRequest,
  OllamaGenerateChunk,
  OllamaGenerateRequest,
  OpenAiChatRequest,
  TranslateCtx,
} from "../ollama/types.js";
import { proxyHeaders } from "../proxy-headers.js";

const EMBEDDINGS_501 = {
  error: {
    message:
      "Embeddings are out of scope for this gateway (spec D8). Point embedding clients at a dedicated embeddings backend.",
    type: "not_implemented",
    code: "embeddings_unsupported",
  },
};

export function registerOllamaRoutes(app: Hono<AuthEnv>, config: GatewayConfig): void {
  // Banner que os clientes Ollama usam pra detectar o servidor.
  app.on(["GET", "HEAD"], "/", (c) => c.text("Ollama is running"));

  app.get("/api/version", (c) => c.json({ version: config.ollamaVersion }));

  app.get("/api/tags", (c) => c.json(buildTags()));

  app.post("/api/show", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { model?: string };
    const show = body.model ? buildShow(body.model) : null;
    if (!show) return c.json({ error: `model '${body.model ?? ""}' not found` }, 404);
    return c.json(show);
  });

  // Embeddings fora de escopo (spec D8).
  app.post("/api/embed", (c) => c.json(EMBEDDINGS_501, 501));
  app.post("/api/embeddings", (c) => c.json(EMBEDDINGS_501, 501));
  app.post("/v1/embeddings", (c) => c.json(EMBEDDINGS_501, 501));

  // Stubs de gerência de modelo (o gateway não gerencia pesos).
  app.get("/api/ps", (c) => c.json({ models: [] }));
  app.post("/api/pull", (c) =>
    c.body('{"status":"success"}\n', 200, { "content-type": "application/x-ndjson" }),
  );
  app.post("/api/push", (c) =>
    c.body('{"status":"success"}\n', 200, { "content-type": "application/x-ndjson" }),
  );
  app.post("/api/create", (c) =>
    c.body('{"status":"success"}\n', 200, { "content-type": "application/x-ndjson" }),
  );
  app.post("/api/copy", (c) => c.body("", 200));
  app.delete("/api/delete", (c) => c.body("", 200));
  // blobs: o gateway não guarda pesos — HEAD sempre "não tenho", POST aceita e descarta.
  app.on("HEAD", "/api/blobs/:digest", (c) => c.body("", 404));
  app.post("/api/blobs/:digest", (c) => c.body("", 201));

  // Inferência (traduz + encaminha pela cadeia). Auth aplicada no buildApp.
  app.post("/api/chat", (c) => handleOllamaInference(c, config, "chat"));
  app.post("/api/generate", (c) => handleOllamaInference(c, config, "generate"));
}

// ── helpers de inferência ────────────────────────────────────────────────

const NS_PER_MS = 1_000_000;

async function* readSseLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        yield buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf("\n");
      }
    }
    if (buffer.length > 0) yield buffer;
  } finally {
    reader.releaseLock();
  }
}

function makeCtx(model: string, startMs: number): TranslateCtx {
  const totalNs = Math.max(1, Math.round((performance.now() - startMs) * NS_PER_MS));
  const loadNs = Math.min(totalNs, Math.round(50 * NS_PER_MS));
  return {
    model,
    createdAt: new Date().toISOString(),
    durations: {
      total_duration: totalNs,
      load_duration: loadNs,
      prompt_eval_duration: 0,
      eval_duration: Math.max(1, totalNs - loadNs),
    },
    promptEvalCount: 0,
    evalCount: 0,
  };
}

type Mode = "chat" | "generate";

async function handleOllamaInference(
  c: Context<AuthEnv>,
  config: GatewayConfig,
  mode: Mode,
): Promise<Response> {
  const startMs = performance.now();
  const raw = (await c.req.json().catch(() => null)) as
    | (OllamaChatRequest & OllamaGenerateRequest)
    | null;
  if (!raw || typeof raw.model !== "string") {
    return c.json({ error: "invalid request body" }, 400);
  }

  const stream = raw.stream !== false; // Ollama faz stream por padrão
  const resolved = resolveModel(raw.model);

  let openAiBody: OpenAiChatRequest;
  if (mode === "generate") {
    const messages: OllamaChatRequest["messages"] = [];
    if (typeof raw.system === "string" && raw.system.length > 0) {
      messages.push({ role: "system", content: raw.system });
    }
    messages.push({ role: "user", content: raw.prompt ?? "" });
    openAiBody = ollamaChatToOpenAi({
      model: raw.model,
      messages,
      stream,
      ...(raw.think !== undefined ? { think: raw.think } : {}),
      ...(raw.options ? { options: raw.options } : {}),
    });
  } else {
    openAiBody = ollamaChatToOpenAi({ ...raw, stream });
  }
  openAiBody.model = resolved.model;
  if (stream) openAiBody.stream_options = { include_usage: true };

  const headers: Record<string, string> = { ...proxyHeaders(c), ...resolved.headers };
  headers["content-type"] = "application/json";
  delete headers["content-length"];

  const upstream = await fetch(`${config.headroomUrl}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(openAiBody),
  });

  // Erro antes do 1º chunk → repassa status + corpo de erro (semântica Ollama).
  if (!upstream.ok) {
    const errText = await upstream.text();
    return c.json({ error: errText || `upstream ${upstream.status}` }, upstream.status as 400);
  }

  if (!stream) {
    const json = (await upstream.json()) as Record<string, unknown>;
    const ctx = makeCtx(resolved.model, startMs);
    const out =
      mode === "generate"
        ? translateGenerateNonStream(json, ctx)
        : translateChatNonStream(json, ctx);
    return c.json(out);
  }

  const body = upstream.body;
  if (!body) return c.json({ error: "empty upstream stream" }, 502);

  const ndjson = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const ctx = makeCtx(resolved.model, startMs);
      try {
        const lines = readSseLines(body);
        const gen =
          mode === "generate"
            ? translateGenerateStream(lines, ctx)
            : translateChatStream(lines, ctx);
        for await (const chunk of gen as AsyncGenerator<OllamaChatChunk | OllamaGenerateChunk>) {
          controller.enqueue(encoder.encode(`${JSON.stringify(chunk)}\n`));
        }
      } catch (err) {
        // Falha no meio do stream → linha de erro NDJSON (semântica Ollama).
        const msg = err instanceof Error ? err.message : String(err);
        controller.enqueue(encoder.encode(`${JSON.stringify({ error: msg })}\n`));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(ndjson, {
    status: 200,
    headers: { "content-type": "application/x-ndjson" },
  });
}
