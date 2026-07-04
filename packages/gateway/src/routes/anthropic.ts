import type { Context, Hono } from "hono";
import { proxy } from "hono/proxy";
import type { AuthEnv } from "../auth.js";
import type { GatewayConfig } from "../config.js";
import { proxyHeaders } from "../proxy-headers.js";
import { estimateInputTokens } from "../token-estimate.js";

function invalidRequest(c: Context<AuthEnv>, message: string): Response {
  return c.json({ type: "error", error: { type: "invalid_request_error", message } }, 400);
}

export function registerAnthropicRoutes(app: Hono<AuthEnv>, config: GatewayConfig): void {
  app.post("/v1/messages", (c) =>
    proxy(`${config.headroomUrl}/v1/messages`, {
      ...c.req,
      headers: proxyHeaders(c),
    }),
  );

  // Respondido localmente: manifest 6.13.3 não tem a rota (404 na cadeia
  // inteira via headroom), e sem um 200 aqui o Claude Code degrada para
  // estimativa própria e trava com "Context limit reached". Ver
  // src/token-estimate.ts para a heurística (conservadora: superestima).
  app.post("/v1/messages/count_tokens", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return invalidRequest(c, "count_tokens: request body must be valid JSON");
    }
    const result = estimateInputTokens(body);
    if (!result.ok) {
      return invalidRequest(c, result.error);
    }
    return c.json({ input_tokens: result.inputTokens });
  });
}
