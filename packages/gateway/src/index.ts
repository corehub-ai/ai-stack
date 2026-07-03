import { Hono } from "hono";

export function buildApp() {
  const app = new Hono();
  app.get("/", (c) => c.text("corehub gateway"));
  return app;
}

if (import.meta.main) {
  const app = buildApp();
  const port = Number(process.env.GATEWAY_PORT ?? "11434");
  Bun.serve({ port, fetch: app.fetch });
  console.log(`corehub gateway listening on :${port}`);
}
