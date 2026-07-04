import { Hono } from "hono";
import { classifyTier } from "./classify.js";
import type { ClassifierConfig } from "./config.js";
import { loadConfig } from "./config.js";
import { extractLastUserMessage } from "./message-extract.js";

const TIER_HEADER = "x-manifest-tier";

async function checkManifest(manifestUrl: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(`${manifestUrl}/api/v1/health`, { signal: AbortSignal.timeout(3000) });
    return { ok: res.ok, detail: res.ok ? "ok" : `http ${res.status}` };
  } catch (err) {
    return { ok: false, detail: `error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function buildApp(config: ClassifierConfig): Hono {
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
      let parsedBody: unknown = null;
      try {
        parsedBody = bodyText.length > 0 ? JSON.parse(bodyText) : null;
      } catch {
        parsedBody = null;
      }
      const userMessage = extractLastUserMessage(parsedBody);
      if (userMessage !== null) {
        const tier = await classifyTier(config, userMessage);
        if (tier !== null) headers[TIER_HEADER] = tier;
      }
    }

    const url = new URL(c.req.url);
    let upstream: Response;
    try {
      upstream = await fetch(`${config.manifestUrl}${url.pathname}${url.search}`, {
        method: c.req.method,
        headers,
        body: bodyText.length > 0 ? bodyText : undefined,
      });
    } catch {
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
    return new Response(upstream.body, { status: upstream.status, headers: upstream.headers });
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
