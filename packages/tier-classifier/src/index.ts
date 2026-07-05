import { Hono } from "hono";
import { classifyTier } from "./classify.js";
import type { ClassifierConfig } from "./config.js";
import { loadConfig } from "./config.js";
import { extractLastUserMessage } from "./message-extract.js";

const TIER_HEADER = "x-manifest-tier";

export type ClassifierLogger = (entry: Record<string, unknown>) => void;

const defaultLogger: ClassifierLogger = (entry) => console.log(JSON.stringify(entry));

// Extrai o `model` de uma resposta JSON do manifest (OpenAI e Anthropic shapes
// têm ambos um `model` no topo). É o sinal que revela o fallback silencioso do
// manifest -- undefined se o corpo não for JSON ou não tiver `model`.
function extractResponseModel(text: string): string | undefined {
  try {
    const json: unknown = JSON.parse(text);
    if (
      typeof json === "object" &&
      json !== null &&
      typeof (json as { model?: unknown }).model === "string"
    ) {
      return (json as { model: string }).model;
    }
  } catch {
    // corpo não-JSON (ex.: erro em texto puro) -- sem model a extrair
  }
  return undefined;
}

async function checkManifest(manifestUrl: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(`${manifestUrl}/api/v1/health`, { signal: AbortSignal.timeout(3000) });
    return { ok: res.ok, detail: res.ok ? "ok" : `http ${res.status}` };
  } catch (err) {
    return { ok: false, detail: `error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function buildApp(config: ClassifierConfig, logger: ClassifierLogger = defaultLogger): Hono {
  const app = new Hono();

  app.get("/health", async (c) => {
    const manifest = await checkManifest(config.manifestUrl);
    return c.json(
      {
        status: manifest.ok ? "ok" : "degraded",
        "tier-classifier": "ok",
        manifest: manifest.detail,
      },
      manifest.ok ? 200 : 503,
    );
  });

  // Repassa qualquer outro path/método -- classifica antes se x-manifest-tier
  // não vier setado (D5/D6). Lê o corpo uma vez (texto) para poder tanto
  // extrair a mensagem quanto repassar o mesmo body adiante.
  app.all("*", async (c) => {
    const bodyText = await c.req.text();
    const headers: Record<string, string> = { ...c.req.header() };
    delete headers.host;
    delete headers["content-length"];

    if (headers[TIER_HEADER] === undefined) {
      const startedAt = performance.now();
      let parsedBody: unknown = null;
      try {
        parsedBody = bodyText.length > 0 ? JSON.parse(bodyText) : null;
      } catch {
        parsedBody = null;
      }
      const userMessage = extractLastUserMessage(parsedBody);
      const result = userMessage !== null ? await classifyTier(config, userMessage) : null;
      const tier = result?.tier ?? null;
      if (tier !== null) headers[TIER_HEADER] = tier;

      // Observabilidade content-free (spec §5): sem isso, uma chave/tier mal
      // configurada faz TODA classificação cair em fail-open silenciosamente,
      // sem nenhum sinal em log ou no /health (achado da revisão final,
      // 2026-07-04). `failure` detalha o motivo do fail-open (achado
      // 2026-07-05): http-error (com status+corpo do manifest), timeout,
      // network-error ou invalid-label -- distingue agente mal configurado
      // de cold-load de modelo cuspindo lixo.
      logger({
        event: "tier-classifier.decision",
        tier,
        latencyMs: Math.round(performance.now() - startedAt),
        failOpen: tier === null,
        ...(tier === null
          ? {
              reason: userMessage === null ? "no-user-message" : "classification-failed",
              ...(result?.failure ? { failure: result.failure } : {}),
            }
          : {}),
      });
    }

    const url = new URL(c.req.url);
    const forwardStartedAt = performance.now();
    let upstream: Response;
    try {
      upstream = await fetch(`${config.manifestUrl}${url.pathname}${url.search}`, {
        method: c.req.method,
        headers,
        body: bodyText.length > 0 ? bodyText : undefined,
      });
    } catch (err) {
      logger({
        event: "tier-classifier.forward",
        method: c.req.method,
        path: url.pathname,
        status: 502,
        latencyMs: Math.round(performance.now() - forwardStartedAt),
        error: `unreachable: ${err instanceof Error ? err.message : String(err)}`,
      });
      return c.json(
        {
          error: {
            message: "tier-classifier: upstream (manifest) unreachable",
            type: "upstream_error",
          },
        },
        502,
      );
    }
    // Bun's fetch() decompressa o body automaticamente (gzip/br/deflate) mas
    // preserva content-encoding/content-length originais em upstream.headers.
    // Repassar esses headers junto do body já descomprimido faz o cliente
    // downstream (headroom) tentar decodificar JSON puro como se fosse gzip.
    const responseHeaders = new Headers(upstream.headers);
    responseHeaders.delete("content-encoding");
    responseHeaders.delete("content-length");

    const forwardLog: Record<string, unknown> = {
      event: "tier-classifier.forward",
      method: c.req.method,
      path: url.pathname,
      status: upstream.status,
      latencyMs: Math.round(performance.now() - forwardStartedAt),
    };

    // Resposta streaming (SSE): não dá pra ler o corpo sem quebrar o stream --
    // loga só status/latência e repassa intacto. Limitação: o modelo real numa
    // resposta streaming (e portanto o fallback do manifest) não é observável
    // aqui; use uma request não-streaming pra ver o responseModel.
    if ((upstream.headers.get("content-type") ?? "").includes("text/event-stream")) {
      forwardLog.streaming = true;
      logger(forwardLog);
      return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
    }

    // Não-streaming: bufferiza (corpo limitado) pra registrar o `model` que o
    // manifest devolveu -- revela o fallback silencioso (pediu opus, veio
    // glm-5.2) que o manifest mascara como 200 (achado 2026-07-05) -- e, em
    // erro não-mascarado, um trecho do corpo do manifest.
    const responseText = await upstream.text();
    const responseModel = extractResponseModel(responseText);
    if (responseModel !== undefined) forwardLog.responseModel = responseModel;
    if (!upstream.ok) forwardLog.manifestError = responseText.slice(0, 500);
    logger(forwardLog);
    return new Response(responseText, { status: upstream.status, headers: responseHeaders });
  });

  return app;
}

if (import.meta.main) {
  const config = loadConfig();
  const app = buildApp(config);

  Bun.serve({
    port: config.port,
    // Mesmo achado do gateway (2026-07-04, packages/gateway/src/index.ts):
    // default do Bun mata conexão ociosa em 10s, cortando streams de LLM no
    // meio. Este serviço também repassa respostas de LLM -- mesmo risco.
    idleTimeout: 255,
    fetch(req) {
      return app.fetch(req);
    },
  });

  console.log(`tier-classifier listening on :${config.port} (manifest=${config.manifestUrl})`);
}
