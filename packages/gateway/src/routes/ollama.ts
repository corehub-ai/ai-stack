import type { Hono } from "hono";
import type { AuthEnv } from "../auth.js";
import type { GatewayConfig } from "../config.js";
import { buildShow, buildTags } from "../ollama/models.js";

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
}
