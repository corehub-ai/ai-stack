import { SECRET_KEYS } from "./env.js";

export type CheckResult = { name: string; ok: boolean; detail: string };

export function summarize(results: CheckResult[]): { ok: boolean; failed: number } {
  const failed = results.filter((r) => !r.ok).length;
  return { ok: failed === 0, failed };
}

export function checkEnvSecrets(env: Record<string, string>): CheckResult {
  const missing = SECRET_KEYS.filter((key) => (env[key] ?? "") === "");
  return {
    name: ".env: segredos de infra preenchidos",
    ok: missing.length === 0,
    detail: missing.length === 0 ? "" : `faltam: ${missing.join(", ")}`,
  };
}

async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  return await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
}

// GET /health is unauthenticated and aggregates gateway + headroom + manifest.
export async function probeHealth(base: string): Promise<CheckResult> {
  const name = "gateway /health (gateway+headroom+manifest)";
  try {
    const res = await fetchWithTimeout(`${base}/health`, {}, 4000);
    const body = (await res.json()) as { status?: string; headroom?: string; manifest?: string };
    if (res.status === 200 && body.status === "ok") {
      return { name, ok: true, detail: "" };
    }
    return {
      name,
      ok: false,
      detail: `status ${res.status} headroom=${body.headroom ?? "?"} manifest=${body.manifest ?? "?"}`,
    };
  } catch (err) {
    return { name, ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

// End-to-end: a real completion through gateway → headroom → manifest → provider.
export async function probeChat(base: string, key: string): Promise<CheckResult> {
  const name = "POST /v1/chat/completions (ponta-a-ponta)";
  if (key === "") {
    return {
      name,
      ok: false,
      detail: "sem MANIFEST_KEY_OPENCODE no .env (crie os agentes no dashboard)",
    };
  }
  try {
    // Nonce no prompt: headroom cacheia por texto do prompt (achado F1/F2) --
    // um prompt fixo faria esse check reportar sucesso pra sempre a partir da
    // primeira resposta cacheada, mesmo depois da chave ser revogada.
    const nonce = crypto.randomUUID();
    const res = await fetchWithTimeout(
      `${base}/v1/chat/completions`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: "auto",
          max_tokens: 16,
          messages: [{ role: "user", content: `corehub-doctor-ping-${nonce}` }],
        }),
      },
      30000,
    );
    if (!res.ok) {
      return { name, ok: false, detail: `http ${res.status}` };
    }
    const body = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
    const content = body.choices?.[0]?.message?.content;
    return {
      name,
      ok: typeof content === "string",
      detail: typeof content === "string" ? "" : "resposta sem choices[0].message.content",
    };
  } catch (err) {
    return { name, ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
