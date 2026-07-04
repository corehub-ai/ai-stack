# Tier Classifier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `packages/tier-classifier`, a new TypeScript/Bun/Hono service inserted between `headroom` and `manifest` that classifies inference requests missing an explicit `x-manifest-tier` header into `simple`/`complex`/`reasoning`, so prompt-complexity routing survives the manifest's deprecation of its own "rule-based routing" (sunset 2026-09-01) without touching headroom or manifest source.

**Architecture:** A thin reverse proxy (mirroring `packages/gateway`'s conventions) sits at `http://tier-classifier:8788`. `headroom`'s `OPENAI_TARGET_API_URL`/`ANTHROPIC_TARGET_API_URL` point here instead of at `manifest` directly (docker-compose env change only). For each request: if `x-manifest-tier` is already set, forward untouched; otherwise, extract the last user message, ask a dedicated `tier-classifier` manifest agent (its own API key + tier, resolved via the manifest dashboard like every other agent) to classify it, set the header with the result, and forward. Any failure (timeout, network error, unparseable label) fails open — forward with no header, letting manifest's existing default routing apply.

**Tech Stack:** TypeScript, Bun, Hono — same as `packages/gateway`. `bun:test` for tests, Biome for lint/format, `tsc --build` for typecheck (all driven from the repo root, same as every other package).

## Global Constraints

- No code changes to `headroom` or `manifest` — only docker-compose env vars and one manifest-dashboard agent (spec D1, D3).
- `tier-classifier` sits between `headroom` and `manifest`, never between `gateway` and `headroom` (spec D3).
- The classification sub-call goes directly to `MANIFEST_URL` — never through any headroom-like hop (spec D7). This service only ever knows about one upstream (`MANIFEST_URL`), so there is no config that could accidentally create that loop.
- If the inbound request already carries `x-manifest-tier`, forward it unmodified — never call the classifier for it (spec D5).
- Valid classification labels are exactly `simple`, `complex`, `reasoning`. `fable` is never set automatically — manual-only (spec D2/§5 of the design spec).
- Any classification failure (timeout, network error, non-2xx, unparseable label) must fail open: forward the original request with no `x-manifest-tier` header, never block or 5xx the real request because classification failed (spec D6... the classification failing must not fail the *real* request; if the *real* forward itself fails, that's a normal upstream error, not something to swallow).
- Config is 4 env vars only: `MANIFEST_URL`, `CLASSIFIER_MANIFEST_KEY`, `CLASSIFIER_TIER`, `CLASSIFIER_TIMEOUT_MS` (plus `CLASSIFIER_PORT` for the service's own listen port, following `GATEWAY_PORT`'s precedent) — no provider/model/base-URL config inside this service (spec D6).
- TDD throughout: failing test before implementation, one behavior at a time, frequent commits.

---

### Task 1: Scaffold `packages/tier-classifier` + config loader

**Files:**
- Create: `packages/tier-classifier/package.json`
- Create: `packages/tier-classifier/tsconfig.json`
- Create: `packages/tier-classifier/.dockerignore`
- Create: `packages/tier-classifier/src/config.ts`
- Test: `packages/tier-classifier/test/config.test.ts`
- Modify: `tsconfig.json` (repo root)
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: `export type ClassifierConfig = { port: number; manifestUrl: string; manifestKey: string; tier: string; timeoutMs: number }` and `export function loadConfig(env?: Record<string, string | undefined>): ClassifierConfig` from `packages/tier-classifier/src/config.ts` — every later task imports `ClassifierConfig` from here.

- [ ] **Step 1: Create the package manifest**

```json
{
  "name": "@ia-stack/tier-classifier",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "bun run --watch src/index.ts",
    "start": "bun run src/index.ts",
    "test": "bun test"
  },
  "dependencies": {
    "hono": "4.12.27"
  },
  "devDependencies": {
    "bun-types": "1.3.14"
  }
}
```

Write this to `packages/tier-classifier/package.json`.

- [ ] **Step 2: Create the package tsconfig**

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "composite": true,
    "declaration": true,
    "rootDir": ".",
    "outDir": "dist",
    "types": ["bun-types"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

Write this to `packages/tier-classifier/tsconfig.json`.

- [ ] **Step 3: Create `.dockerignore`**

```
node_modules
dist
*.tsbuildinfo
test
```

Write this to `packages/tier-classifier/.dockerignore`.

- [ ] **Step 4: Register the new package in the root tsconfig**

In `tsconfig.json` (repo root), the `references` array currently reads:

```json
  "references": [{ "path": "packages/gateway" }, { "path": "packages/cli" }]
```

Change it to:

```json
  "references": [
    { "path": "packages/gateway" },
    { "path": "packages/cli" },
    { "path": "packages/tier-classifier" }
  ]
```

Without this, `bun run typecheck` (which runs `tsc --build`) never looks at the new package.

- [ ] **Step 5: Add the new package to CI**

In `.github/workflows/ci.yml`, the `gateway-checks` job currently ends with:

```yaml
      - run: bun test packages/gateway/test
      - run: bun test packages/cli/test
```

Add a third line:

```yaml
      - run: bun test packages/gateway/test
      - run: bun test packages/cli/test
      - run: bun test packages/tier-classifier/test
```

- [ ] **Step 6: Run `bun install` to link the new workspace member**

Run: `bun install` (from repo root)
Expected: updates `bun.lock` to include `packages/tier-classifier`; exits 0.

- [ ] **Step 7: Write the failing config test**

Create `packages/tier-classifier/test/config.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("applies documented defaults when env is empty", () => {
    const config = loadConfig({});
    expect(config.port).toBe(8788);
    expect(config.manifestUrl).toBe("http://manifest:2099");
    expect(config.manifestKey).toBe("");
    expect(config.tier).toBe("default");
    expect(config.timeoutMs).toBe(800);
  });

  it("reads every value from env vars", () => {
    const config = loadConfig({
      CLASSIFIER_PORT: "9999",
      MANIFEST_URL: "http://manifest:2099/",
      CLASSIFIER_MANIFEST_KEY: "mnfst_tier-classifier",
      CLASSIFIER_TIER: "classify",
      CLASSIFIER_TIMEOUT_MS: "500",
    });
    expect(config.port).toBe(9999);
    expect(config.manifestKey).toBe("mnfst_tier-classifier");
    expect(config.tier).toBe("classify");
    expect(config.timeoutMs).toBe(500);
  });

  it("strips a trailing slash from MANIFEST_URL", () => {
    const config = loadConfig({ MANIFEST_URL: "http://manifest:2099/" });
    expect(config.manifestUrl).toBe("http://manifest:2099");
  });
});
```

- [ ] **Step 8: Run the test to verify it fails**

Run: `bun test packages/tier-classifier/test`
Expected: FAIL — `Cannot find module '../src/config.js'` (file doesn't exist yet).

- [ ] **Step 9: Implement `loadConfig`**

Create `packages/tier-classifier/src/config.ts`:

```typescript
export type ClassifierConfig = {
  port: number;
  manifestUrl: string;
  manifestKey: string;
  tier: string;
  timeoutMs: number;
};

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): ClassifierConfig {
  return {
    port: Number(env.CLASSIFIER_PORT ?? "8788"),
    manifestUrl: stripTrailingSlash(env.MANIFEST_URL ?? "http://manifest:2099"),
    manifestKey: env.CLASSIFIER_MANIFEST_KEY ?? "",
    tier: env.CLASSIFIER_TIER ?? "default",
    timeoutMs: Number(env.CLASSIFIER_TIMEOUT_MS ?? "800"),
  };
}
```

- [ ] **Step 10: Run the test to verify it passes**

Run: `bun test packages/tier-classifier/test`
Expected: 3 pass, 0 fail.

- [ ] **Step 11: Typecheck and lint the whole repo**

Run: `bun run typecheck && bun run lint`
Expected: both exit 0 (typecheck now includes the new package via Step 4; lint covers it automatically via Biome's `**` glob).

- [ ] **Step 12: Commit**

```bash
git add packages/tier-classifier/package.json packages/tier-classifier/tsconfig.json \
  packages/tier-classifier/.dockerignore packages/tier-classifier/src/config.ts \
  packages/tier-classifier/test/config.test.ts tsconfig.json .github/workflows/ci.yml bun.lock
git commit -m "feat(tier-classifier): scaffold package + config loader"
```

---

### Task 2: Extract the last user message from a request body

**Files:**
- Create: `packages/tier-classifier/src/message-extract.ts`
- Test: `packages/tier-classifier/test/message-extract.test.ts`

**Interfaces:**
- Consumes: nothing from prior tasks (pure function, no dependency on `config.ts`).
- Produces: `export function extractLastUserMessage(body: unknown): string | null` — Task 4 calls this to get the text to classify.

**Context:** OpenAI chat-completions bodies and Anthropic messages bodies both use the same shape for the field that matters here: `messages: Array<{ role: string, content: string | Array<{ type: string, text?: string, ... }> }>`. One function handles both — no need to special-case by surface.

- [ ] **Step 1: Write the failing tests**

Create `packages/tier-classifier/test/message-extract.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { extractLastUserMessage } from "../src/message-extract.js";

describe("extractLastUserMessage", () => {
  it("extracts a plain string content from the last user message", () => {
    const body = {
      messages: [
        { role: "user", content: "primeira pergunta" },
        { role: "assistant", content: "resposta" },
        { role: "user", content: "segunda pergunta, a que importa" },
      ],
    };
    expect(extractLastUserMessage(body)).toBe("segunda pergunta, a que importa");
  });

  it("joins text blocks when content is an array (Anthropic/OpenAI block shape)", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "primeiro bloco" },
            { type: "text", text: "segundo bloco" },
          ],
        },
      ],
    };
    expect(extractLastUserMessage(body)).toBe("primeiro bloco\nsegundo bloco");
  });

  it("ignores non-text blocks (e.g. image) when joining", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "olha essa imagem" },
            { type: "image", source: { type: "base64", data: "..." } },
          ],
        },
      ],
    };
    expect(extractLastUserMessage(body)).toBe("olha essa imagem");
  });

  it("returns null when there is no user message", () => {
    const body = { messages: [{ role: "assistant", content: "oi" }] };
    expect(extractLastUserMessage(body)).toBeNull();
  });

  it("returns null when messages is missing, not an array, or body isn't an object", () => {
    expect(extractLastUserMessage({})).toBeNull();
    expect(extractLastUserMessage({ messages: "oops" })).toBeNull();
    expect(extractLastUserMessage(null)).toBeNull();
    expect(extractLastUserMessage("not even an object")).toBeNull();
  });

  it("returns null when the last user message has empty/whitespace-only text", () => {
    const body = { messages: [{ role: "user", content: "   " }] };
    expect(extractLastUserMessage(body)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/tier-classifier/test/message-extract.test.ts`
Expected: FAIL — `Cannot find module '../src/message-extract.js'`.

- [ ] **Step 3: Implement `extractLastUserMessage`**

Create `packages/tier-classifier/src/message-extract.ts`:

```typescript
type ContentBlock = { type?: string; text?: string };
type Message = { role?: string; content?: string | ContentBlock[] };
type ClassifiableBody = { messages?: Message[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text as string)
      .join("\n");
  }
  return "";
}

/**
 * Última mensagem do usuário em um body de /v1/messages (Anthropic) ou
 * /v1/chat/completions (OpenAI) -- as duas usam o mesmo shape de `messages`.
 * Retorna null se não houver mensagem de usuário com texto não-vazio.
 */
export function extractLastUserMessage(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const messages = (body as ClassifiableBody).messages;
  if (!Array.isArray(messages)) return null;

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (isRecord(message) && message.role === "user") {
      const text = messageText(message as Message).trim();
      return text.length > 0 ? text : null;
    }
  }
  return null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/tier-classifier/test/message-extract.test.ts`
Expected: 6 pass, 0 fail.

- [ ] **Step 5: Typecheck and lint**

Run: `bun run typecheck && bun run lint`
Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/tier-classifier/src/message-extract.ts packages/tier-classifier/test/message-extract.test.ts
git commit -m "feat(tier-classifier): extract last user message from request body"
```

---

### Task 3: Manifest classification client

**Files:**
- Create: `packages/tier-classifier/src/classify.ts`
- Test: `packages/tier-classifier/test/classify.test.ts`

**Interfaces:**
- Consumes: `ClassifierConfig` from `../src/config.js` (Task 1).
- Produces: `export async function classifyTier(config: ClassifierConfig, userMessage: string): Promise<string | null>` — Task 4 calls this; returns one of `"simple" | "complex" | "reasoning"`, or `null` on any failure (network error, timeout, non-2xx, unparseable label).

**Context:** Calls `POST {config.manifestUrl}/v1/messages` with `x-manifest-tier: {config.tier}` and `Authorization: Bearer {config.manifestKey}` — this routes to whatever model the `tier-classifier` manifest agent has configured for that tier (spec D6). `config.manifestUrl` is the same URL used for the real forwarded request in Task 4 — this call never goes anywhere else (satisfies D7 structurally, since this service has no other upstream URL configured).

- [ ] **Step 1: Write the failing tests**

Create `packages/tier-classifier/test/classify.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { classifyTier } from "../src/classify.js";
import type { ClassifierConfig } from "../src/config.js";

function baseConfig(manifestUrl: string): ClassifierConfig {
  return {
    port: 0,
    manifestUrl,
    manifestKey: "mnfst_test-classifier",
    tier: "default",
    timeoutMs: 300,
  };
}

function anthropicTextResponse(text: string): Response {
  return Response.json({
    id: "msg_test",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text }],
  });
}

describe("classifyTier", () => {
  it("returns the parsed label on a clean response", async () => {
    const server = Bun.serve({ port: 0, fetch: () => anthropicTextResponse("complex") });
    try {
      const tier = await classifyTier(
        baseConfig(`http://127.0.0.1:${server.port}`),
        "refatora esse módulo inteiro",
      );
      expect(tier).toBe("complex");
    } finally {
      server.stop(true);
    }
  });

  it("trims punctuation/case noise around the label", async () => {
    const server = Bun.serve({ port: 0, fetch: () => anthropicTextResponse("  Reasoning.\n") });
    try {
      const tier = await classifyTier(baseConfig(`http://127.0.0.1:${server.port}`), "pensa nas opções");
      expect(tier).toBe("reasoning");
    } finally {
      server.stop(true);
    }
  });

  it("sends the configured tier header and manifest key", async () => {
    let seenAuth: string | null = null;
    let seenTier: string | null = null;
    const server = Bun.serve({
      port: 0,
      fetch: (req) => {
        seenAuth = req.headers.get("authorization");
        seenTier = req.headers.get("x-manifest-tier");
        return anthropicTextResponse("simple");
      },
    });
    try {
      await classifyTier(
        { ...baseConfig(`http://127.0.0.1:${server.port}`), manifestKey: "mnfst_abc", tier: "classify" },
        "oi",
      );
      expect(seenAuth).toBe("Bearer mnfst_abc");
      expect(seenTier).toBe("classify");
    } finally {
      server.stop(true);
    }
  });

  it("returns null when the response label is not simple/complex/reasoning", async () => {
    const server = Bun.serve({ port: 0, fetch: () => anthropicTextResponse("maybe idk") });
    try {
      const tier = await classifyTier(baseConfig(`http://127.0.0.1:${server.port}`), "oi");
      expect(tier).toBeNull();
    } finally {
      server.stop(true);
    }
  });

  it("returns null when manifest responds with a non-2xx status", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("nope", { status: 500 }) });
    try {
      const tier = await classifyTier(baseConfig(`http://127.0.0.1:${server.port}`), "oi");
      expect(tier).toBeNull();
    } finally {
      server.stop(true);
    }
  });

  it("returns null (fail-open) when manifest doesn't respond within timeoutMs", async () => {
    const server = Bun.serve({
      port: 0,
      async fetch() {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return anthropicTextResponse("simple");
      },
    });
    try {
      const config = { ...baseConfig(`http://127.0.0.1:${server.port}`), timeoutMs: 50 };
      const tier = await classifyTier(config, "oi");
      expect(tier).toBeNull();
    } finally {
      server.stop(true);
    }
  });

  it("returns null when the manifest URL is unreachable", async () => {
    const tier = await classifyTier(baseConfig("http://127.0.0.1:1"), "oi");
    expect(tier).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/tier-classifier/test/classify.test.ts`
Expected: FAIL — `Cannot find module '../src/classify.js'`.

- [ ] **Step 3: Implement `classifyTier`**

Create `packages/tier-classifier/src/classify.ts`:

```typescript
import type { ClassifierConfig } from "./config.js";

const VALID_TIERS = new Set(["simple", "complex", "reasoning"]);

const SYSTEM_PROMPT = `Classifique a próxima mensagem do usuário em exatamente uma palavra: simple, complex ou reasoning.
- simple: perguntas diretas, tarefas pequenas e bem definidas.
- complex: implementação de código de maior porte, múltiplos arquivos, refatoração.
- reasoning: planejamento, análise e pensamento profundo -- NÃO implementação de código.
Responda só com a palavra escolhida, nada mais.`;

function parseTierLabel(raw: string): string | null {
  const match = raw.trim().toLowerCase().match(/^[a-z]+/);
  const label = match?.[0];
  return label !== undefined && VALID_TIERS.has(label) ? label : null;
}

function isTextBlock(block: unknown): block is { type: "text"; text: string } {
  return (
    typeof block === "object" &&
    block !== null &&
    (block as { type?: unknown }).type === "text" &&
    typeof (block as { text?: unknown }).text === "string"
  );
}

function extractText(body: unknown): string {
  if (typeof body !== "object" || body === null) return "";
  const content = (body as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(isTextBlock)
    .map((block) => block.text)
    .join("");
}

/**
 * Chama o agente dedicado `tier-classifier` no manifest (D6) para classificar
 * `userMessage`. Nunca lança -- qualquer falha (rede, timeout, status não-2xx,
 * label não reconhecido) vira `null`, para o chamador fazer fail-open (D5/D6).
 */
export async function classifyTier(
  config: ClassifierConfig,
  userMessage: string,
): Promise<string | null> {
  try {
    const res = await fetch(`${config.manifestUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.manifestKey}`,
        "x-manifest-tier": config.tier,
      },
      body: JSON.stringify({
        // Valor inerte: o manifest sempre reescreve `model` pelo tier (achado
        // 2026-07-04, ver docs/superpowers/specs/2026-07-04-tier-classifier-design.md D1).
        model: "tier-classifier",
        max_tokens: 8,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMessage }],
      }),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    if (!res.ok) return null;
    const json = await res.json();
    return parseTierLabel(extractText(json));
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/tier-classifier/test/classify.test.ts`
Expected: 7 pass, 0 fail.

- [ ] **Step 5: Typecheck and lint**

Run: `bun run typecheck && bun run lint`
Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/tier-classifier/src/classify.ts packages/tier-classifier/test/classify.test.ts
git commit -m "feat(tier-classifier): manifest classification client (fail-open)"
```

---

### Task 4: Proxy + classification wiring (`buildApp`, `Bun.serve` entrypoint)

**Files:**
- Create: `packages/tier-classifier/src/index.ts`
- Test: `packages/tier-classifier/test/index.test.ts`

**Interfaces:**
- Consumes: `ClassifierConfig`/`loadConfig` (Task 1), `extractLastUserMessage` (Task 2), `classifyTier` (Task 3).
- Produces: `export function buildApp(config: ClassifierConfig): Hono` — this is the full request-handling surface; nothing later depends on internals beyond this export.

**Context:** `GET /health` checks manifest reachability (same pattern and endpoint as `packages/gateway/src/routes/health.ts`'s `checkUrl` helper, `/api/v1/health`). Every other path/method is proxied: if `x-manifest-tier` is present, forward untouched; otherwise classify, set the header on success, and always forward (spec D5/D6). The classification call and the real forward both hit `config.manifestUrl` — the only upstream this service knows about (D7).

- [ ] **Step 1: Write the failing tests**

Create `packages/tier-classifier/test/index.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import type { ClassifierConfig } from "../src/config.js";
import { buildApp } from "../src/index.js";

const CLASSIFIER_TIER = "tier-classifier-internal";

function baseConfig(manifestUrl: string): ClassifierConfig {
  return {
    port: 0,
    manifestUrl,
    manifestKey: "mnfst_test-classifier",
    tier: CLASSIFIER_TIER,
    timeoutMs: 300,
  };
}

type SeenRequest = { path: string; tierHeader: string | null; body: string };

function startMockManifest(classificationLabel: string) {
  const seen: SeenRequest[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.text();
      const tierHeader = req.headers.get("x-manifest-tier");
      const path = new URL(req.url).pathname;
      seen.push({ path, tierHeader, body });
      if (tierHeader === CLASSIFIER_TIER) {
        return Response.json({ type: "message", content: [{ type: "text", text: classificationLabel }] });
      }
      return Response.json({ ok: true, receivedTier: tierHeader });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, seen, stop: () => server.stop(true) };
}

describe("tier-classifier proxy", () => {
  it("passes through untouched when x-manifest-tier is already set (no classification call made)", async () => {
    const mock = startMockManifest("simple");
    try {
      const app = buildApp(baseConfig(mock.url));
      const res = await app.request("/v1/messages", {
        method: "POST",
        headers: { "x-manifest-tier": "fable", "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "oi" }] }),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { receivedTier: string };
      expect(json.receivedTier).toBe("fable");
      expect(mock.seen).toHaveLength(1);
    } finally {
      mock.stop();
    }
  });

  it("classifies and sets x-manifest-tier when the request has none", async () => {
    const mock = startMockManifest("complex");
    try {
      const app = buildApp(baseConfig(mock.url));
      const res = await app.request("/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "refatora o módulo de auth inteiro, com testes" }],
        }),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { receivedTier: string };
      expect(json.receivedTier).toBe("complex");
      expect(mock.seen).toHaveLength(2);
    } finally {
      mock.stop();
    }
  });

  it("fails open (forwards without a tier header) when classification is unparseable", async () => {
    const mock = startMockManifest("não sei classificar isso");
    try {
      const app = buildApp(baseConfig(mock.url));
      const res = await app.request("/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "oi" }] }),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { receivedTier: string | null };
      expect(json.receivedTier).toBeNull();
    } finally {
      mock.stop();
    }
  });

  it("returns 502 when the manifest is unreachable for the real forward", async () => {
    const app = buildApp({
      port: 0,
      manifestUrl: "http://127.0.0.1:1",
      manifestKey: "mnfst_x",
      tier: CLASSIFIER_TIER,
      timeoutMs: 300,
    });
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "oi" }] }),
    });
    expect(res.status).toBe(502);
  });

  it("GET /health checks manifest reachability (not the classification/proxy path)", async () => {
    const mock = startMockManifest("simple");
    try {
      const app = buildApp(baseConfig(mock.url));
      const res = await app.request("/health");
      expect(res.status).toBe(200);
      const json = (await res.json()) as { status: string };
      expect(json.status).toBe("ok");
    } finally {
      mock.stop();
    }
  });

  it("GET /health reports degraded (503) when manifest is unreachable", async () => {
    const app = buildApp({
      port: 0,
      manifestUrl: "http://127.0.0.1:1",
      manifestKey: "mnfst_x",
      tier: CLASSIFIER_TIER,
      timeoutMs: 300,
    });
    const res = await app.request("/health");
    expect(res.status).toBe(503);
  });

  it("forwards GET /v1/models untouched (no body, no classification attempted)", async () => {
    const mock = startMockManifest("simple");
    try {
      const app = buildApp(baseConfig(mock.url));
      const res = await app.request("/v1/models");
      expect(res.status).toBe(200);
      expect(mock.seen).toHaveLength(1);
      expect(mock.seen[0]?.tierHeader).toBeNull();
    } finally {
      mock.stop();
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/tier-classifier/test/index.test.ts`
Expected: FAIL — `Cannot find module '../src/index.js'`.

- [ ] **Step 3: Implement `buildApp` and the `Bun.serve` entrypoint**

Create `packages/tier-classifier/src/index.ts`:

```typescript
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
      { status: manifest.ok ? "ok" : "degraded", "tier-classifier": "ok", manifest: manifest.detail },
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
        { error: { message: "tier-classifier: upstream (manifest) unreachable", type: "upstream_error" } },
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/tier-classifier/test/index.test.ts`
Expected: 7 pass, 0 fail.

- [ ] **Step 5: Run the full package test suite, typecheck, and lint**

Run: `bun test packages/tier-classifier/test && bun run typecheck && bun run lint`
Expected: all green — every test file created in Tasks 1-4 passes (config, message-extract, classify, index), typecheck and lint both exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/tier-classifier/src/index.ts packages/tier-classifier/test/index.test.ts
git commit -m "feat(tier-classifier): proxy + classification wiring, health check"
```

---

### Task 5: Dockerfile for `tier-classifier` + fix the gateway Dockerfile regression

**Files:**
- Create: `packages/tier-classifier/Dockerfile`
- Modify: `packages/gateway/Dockerfile`

**Interfaces:** None (build-only artifacts, no runtime imports).

**Context:** `bun.lock` covers the whole workspace. `packages/gateway/Dockerfile` already learned this lesson once (commit `36f9102`, F4: adding `packages/cli` broke `--frozen-lockfile` until its `package.json` was copied in too). Adding `packages/tier-classifier` as a third sibling workspace member reintroduces the exact same failure mode for `packages/gateway/Dockerfile` unless it also copies `packages/tier-classifier/package.json`.

- [ ] **Step 1: Create the `tier-classifier` Dockerfile**

```dockerfile
FROM oven/bun:1.3.14-alpine

WORKDIR /repo

COPY package.json tsconfig.json bun.lock ./
COPY packages/tier-classifier/package.json packages/tier-classifier/package.json
# bun.lock cobre o workspace inteiro: sem os package.json dos outros membros
# do workspace, --frozen-lockfile falha com "lockfile had changes" (mesmo
# achado do packages/gateway/Dockerfile, commit 36f9102).
COPY packages/gateway/package.json packages/gateway/package.json
COPY packages/cli/package.json packages/cli/package.json
RUN bun install --frozen-lockfile

COPY packages/tier-classifier packages/tier-classifier

WORKDIR /repo/packages/tier-classifier
EXPOSE 8788
CMD ["bun", "run", "src/index.ts"]
```

Write this to `packages/tier-classifier/Dockerfile`.

- [ ] **Step 2: Fix `packages/gateway/Dockerfile` for the new workspace member**

Read the current content first (`packages/gateway/Dockerfile`), then change:

```dockerfile
COPY package.json tsconfig.json bun.lock ./
COPY packages/gateway/package.json packages/gateway/package.json
# bun.lock cobre o workspace inteiro: sem o package.json do cli o
# --frozen-lockfile falha com "lockfile had changes" (desde a F4).
COPY packages/cli/package.json packages/cli/package.json
RUN bun install --frozen-lockfile
```

to:

```dockerfile
COPY package.json tsconfig.json bun.lock ./
COPY packages/gateway/package.json packages/gateway/package.json
# bun.lock cobre o workspace inteiro: sem os package.json dos outros membros
# do workspace o --frozen-lockfile falha com "lockfile had changes" (desde a
# F4, e de novo ao adicionar o tier-classifier).
COPY packages/cli/package.json packages/cli/package.json
COPY packages/tier-classifier/package.json packages/tier-classifier/package.json
RUN bun install --frozen-lockfile
```

- [ ] **Step 3: Verify both images build**

Run: `docker build -f packages/tier-classifier/Dockerfile -t tier-classifier-test .`
Expected: exits 0.

Run: `docker build -f packages/gateway/Dockerfile -t gateway-test .`
Expected: exits 0 (confirms the regression fix — this would fail with "lockfile had changes" without Step 2).

- [ ] **Step 4: Commit**

```bash
git add packages/tier-classifier/Dockerfile packages/gateway/Dockerfile
git commit -m "build(tier-classifier): add Dockerfile; fix gateway Dockerfile for the new workspace member"
```

---

### Task 6: Wire `tier-classifier` into docker-compose

**Files:**
- Modify: `deploy/compose/docker-compose.yml`
- Modify: `deploy/compose/.env.example`

**Interfaces:** None (deployment config only).

**Context:** `headroom`'s `OPENAI_TARGET_API_URL`/`ANTHROPIC_TARGET_API_URL` currently point at `http://manifest:2099` — repoint them at the new service. `headroom`'s `depends_on` moves from `manifest` to `tier-classifier` (which itself depends on `manifest`), so startup ordering stays correct: postgres → manifest → tier-classifier → headroom → gateway.

- [ ] **Step 1: Add the `tier-classifier` service block**

In `deploy/compose/docker-compose.yml`, add a new service (placed after the `manifest` block, before `postgres`, to keep the file's existing ordering of "dependency-ish" services together — exact placement doesn't affect compose behavior):

```yaml
  tier-classifier:
    build:
      context: ../..
      dockerfile: packages/tier-classifier/Dockerfile
    restart: unless-stopped
    environment:
      - CLASSIFIER_PORT=8788
      - MANIFEST_URL=http://manifest:2099
      - CLASSIFIER_MANIFEST_KEY=${MANIFEST_KEY_TIER_CLASSIFIER}
      - CLASSIFIER_TIER=${CLASSIFIER_TIER:-default}
      - CLASSIFIER_TIMEOUT_MS=${CLASSIFIER_TIMEOUT_MS:-800}
    depends_on:
      manifest:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "bun", "-e", "fetch('http://127.0.0.1:8788/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 10s
      timeout: 5s
      retries: 12
      start_period: 15s
```

Not published to the host (no `ports:` mapping) — same posture as `headroom` since F2: reachable only via the compose network.

- [ ] **Step 2: Repoint `headroom`'s target URLs and dependency**

In the `headroom` service block, change:

```yaml
    environment:
      - HEADROOM_HOST=0.0.0.0
      - OPENAI_TARGET_API_URL=http://manifest:2099
      - ANTHROPIC_TARGET_API_URL=http://manifest:2099
      - HEADROOM_TELEMETRY=off
      - HEADROOM_UPDATE_CHECK=off
    volumes:
      - headroom_workspace:/home/nonroot/.headroom
    depends_on:
      manifest:
        condition: service_healthy
```

to:

```yaml
    environment:
      - HEADROOM_HOST=0.0.0.0
      - OPENAI_TARGET_API_URL=http://tier-classifier:8788
      - ANTHROPIC_TARGET_API_URL=http://tier-classifier:8788
      - HEADROOM_TELEMETRY=off
      - HEADROOM_UPDATE_CHECK=off
    volumes:
      - headroom_workspace:/home/nonroot/.headroom
    depends_on:
      tier-classifier:
        condition: service_healthy
```

- [ ] **Step 3: Add the new env var to `.env.example`**

In `deploy/compose/.env.example`, the agent-keys section currently reads:

```
# ── Chaves de agente do manifest (criadas no dashboard — Task 2) ───────
MANIFEST_KEY_OPENCODE=
MANIFEST_KEY_CLAUDE_CODE=
MANIFEST_KEY_COPILOT=
MANIFEST_KEY_OPENWEBUI=
MANIFEST_KEY_LAN_ANON=
```

Add a line at the end:

```
# ── Chaves de agente do manifest (criadas no dashboard — Task 2) ───────
MANIFEST_KEY_OPENCODE=
MANIFEST_KEY_CLAUDE_CODE=
MANIFEST_KEY_COPILOT=
MANIFEST_KEY_OPENWEBUI=
MANIFEST_KEY_LAN_ANON=
# Agente dedicado só pra chamada de classificação do tier-classifier (spec
# docs/superpowers/specs/2026-07-04-tier-classifier-design.md D6) — criar no
# dashboard do manifest e configurar sua tier default apontando pro Ollama local.
MANIFEST_KEY_TIER_CLASSIFIER=
```

- [ ] **Step 4: Validate the compose file**

Run:
```bash
cp deploy/compose/.env.example deploy/compose/.env.ci-check
sed -i 's/^BETTER_AUTH_SECRET=$/BETTER_AUTH_SECRET=ci-dummy/' deploy/compose/.env.ci-check
sed -i 's/^MANIFEST_ENCRYPTION_KEY=$/MANIFEST_ENCRYPTION_KEY=ci-dummy/' deploy/compose/.env.ci-check
sed -i 's/^POSTGRES_PASSWORD=$/POSTGRES_PASSWORD=ci-dummy/' deploy/compose/.env.ci-check
docker compose -f deploy/compose/docker-compose.yml --env-file deploy/compose/.env.ci-check --profile local-models config -q
rm deploy/compose/.env.ci-check
```
Expected: `config -q` exits 0 with no output (same check `ci.yml`'s `compose-validate` job runs).

- [ ] **Step 5: Commit**

```bash
git add deploy/compose/docker-compose.yml deploy/compose/.env.example
git commit -m "feat(compose): wire tier-classifier between headroom and manifest"
```

**Note for whoever deploys this (not part of this plan's automated steps — needs the live manifest dashboard):** create the `tier-classifier` agent in the manifest dashboard (`http://localhost:2099`), copy its API key into `deploy/compose/.env` as `MANIFEST_KEY_TIER_CLASSIFIER`, point its default tier at the local Ollama model, then `docker compose -f deploy/compose/docker-compose.yml --env-file deploy/compose/.env up -d --build`.

---

## Self-Review Notes

- **Spec coverage:** D1 (objective) → Tasks 1-4. D2 (alternatives discarded) → nothing to implement, informational. D3 (placement) → Task 6 Step 2. D4 (2 shapes) → Task 2. D5 (passthrough) → Task 4. D6 (dedicated agent, config) → Tasks 1, 3, 6. D7 (no loop) → Task 3/4 (single `MANIFEST_URL`, tested). D8 (Ollama default) → operational note at the end of Task 6, not code (it's a dashboard setting, nothing to implement). §5 labels → Task 3. §6 tests → Tasks 1-4. §7 risks → fail-open covered in Task 3/4; Dockerfile regression covered in Task 5.
- **Placeholder scan:** none found — every step has complete, runnable code.
- **Type consistency:** `ClassifierConfig` defined once in Task 1, imported by name in Tasks 3 and 4 with identical fields (`port`, `manifestUrl`, `manifestKey`, `tier`, `timeoutMs`) throughout. `extractLastUserMessage`/`classifyTier`/`buildApp`/`loadConfig` names match between producing and consuming tasks.
