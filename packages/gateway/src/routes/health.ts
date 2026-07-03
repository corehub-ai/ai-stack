import type { Hono } from "hono";
import type { AuthEnv } from "../auth.js";
import type { GatewayConfig } from "../config.js";

async function checkUrl(url: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return { ok: res.ok, detail: res.ok ? "ok" : `http ${res.status}` };
  } catch (err) {
    return { ok: false, detail: `error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function registerHealthRoute(app: Hono<AuthEnv>, config: GatewayConfig): void {
  app.get("/health", async (c) => {
    const [headroom, manifest] = await Promise.all([
      checkUrl(`${config.headroomUrl}/readyz`),
      checkUrl(`${config.manifestUrl}/api/v1/health`),
    ]);
    const allOk = headroom.ok && manifest.ok;
    return c.json(
      {
        status: allOk ? "ok" : "degraded",
        gateway: "ok",
        headroom: headroom.detail,
        manifest: manifest.detail,
      },
      allOk ? 200 : 503,
    );
  });
}
