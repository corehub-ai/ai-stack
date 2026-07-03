# F2 — Gateway v1 (passthrough OpenAI+Anthropic) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir `packages/gateway` (Bun + Hono, TypeScript) — o primeiro código próprio do stack — expondo as superfícies OpenAI e Anthropic em `:11434` com auth LAN, e conectar as 3 ferramentas-alvo (opencode, Claude Code, Copilot BYOK) através dele.

**Architecture:** O gateway é um reverse-proxy fino: recebe em `:11434`, decide auth (§4.4 do spec), encaminha para `headroom:8787` (agora só interno — perde a porta host que tinha na F1) via `hono/proxy`, que por sua vez fala com `manifest:2099`. Nenhuma tradução de payload ainda — isso é a F3 (façade Ollama). `/health` agrega os 3 hops.

**Tech Stack:** Bun + Hono 4, TypeScript estrito, Biome, `bun test`. Monorepo com Bun workspaces (`packages/gateway`; `packages/cli` vem na F4).

## Global Constraints

- Spec de referência: `docs/superpowers/specs/2026-07-02-ia-stack-design.md` §4 (gateway), §5 (conexão das ferramentas), §8 (testes). Plano anterior: `docs/superpowers/plans/2026-07-02-f1-cadeia-compose.md` (F1, já executado — cadeia headroom→manifest rodando local).
- Escopo da F2 é só **passthrough**: `/v1/chat/completions`, `/v1/responses`, `/v1/models`, `/v1/messages`, `/v1/messages/count_tokens`, `/health`. Nada de `/api/*` (superfície Ollama) — isso é F3.
- Versões pinadas (checadas 2026-07-03 nos registries reais, não supostas): `hono@4.12.27`, `@biomejs/biome@2.5.2`, `typescript@6.0.3`, imagem Docker `oven/bun:1.3.14-alpine`. `package.json` usa versões exatas (sem `^`/`~`), mesma política das imagens do compose.
- **Fato verificado que corrige o spec (D5 parcialmente obsoleto):** `HEADROOM_PROXY_TOKEN`/`X-Headroom-Proxy-Token` **não existe** no headroom `0.27.0-code-nonroot` (grep no pacote Python inteiro, sem nenhuma ocorrência real — só falsos-positivos tipo `proxy_tokens` de contagem de tokens). O hop gateway→headroom **não tem** shared-secret; a segurança vem de headroom não ter porta publicada no host (só rede interna do compose) — mesmo padrão que já usávamos para o Postgres na F1.
- Fato verificado: `HEADROOM_PROXY_TRUSTED_GATEWAY_CIDRS` **existe** mas é sobre o headroom confiar em `X-Forwarded-*` para logging/atribuição — não afeta auth. Fora do escopo da F2 (não há requisito que dependa disso).
- Fato verificado: manifest 6.12.0 expõe `/v1/models` (GET), `/v1/chat/completions` (POST), `/v1/responses` (POST), `/v1/messages` (POST) — **sem** `/v1/messages/count_tokens`. Claude Code tolera a ausência (estima local); o gateway encaminha `count_tokens` mesmo assim e deixa o 404 passar — não é um gap bloqueante.
- Fato verificado (headroom `0.27.0-code-nonroot`, grep no source): `/v1/responses` é uma rota real do handler OpenAI do headroom, testada ponta-a-ponta nesta sessão (200 OK via headroom com corpo `object:"response"` correto).
- Fato verificado (agente `claude-code-guide`, docs oficiais): Claude Code usa `ANTHROPIC_BASE_URL` + (`ANTHROPIC_AUTH_TOKEN` → header `Authorization: Bearer` **ou** `ANTHROPIC_API_KEY` → header `x-api-key`); precisa forward verbatim de `anthropic-version` e `anthropic-beta`; exige streaming SSE real (não pode bufferizar); escopo por projeto via `.claude/settings.local.json` (auto-gitignorado).
- Fato verificado (WebSearch, changelog GitHub/VS Code 2026-05-28, v1.122): Copilot Chat "Custom Endpoint" BYOK está **estável**, funciona sem login GitHub, aceita `apiType: "chat-completions" | "responses" | "messages"` — confirma que o F2 pode conectar Copilot sem esperar a façade Ollama (F3), como o spec já previa.
- Rede do compose fixada com subnet conhecida (`172.28.1.0/24`) — necessário porque `GATEWAY_TRUSTED_CIDRS` (auth §4.4) precisa de um valor determinístico, não da subnet aleatória que o Docker atribuiria por padrão.
- Auth LAN (spec §4.4): request com `Authorization`/`x-api-key` → passa intacto. Sem credencial → só de loopback ou `GATEWAY_TRUSTED_CIDRS`; nesses casos o gateway injeta `GATEWAY_DEFAULT_KEY` (= `MANIFEST_KEY_LAN_ANON`). Fora disso → 401 com corpo `{"error":{"message","type":"auth_error","code":"gateway_auth"}}`.
- Commits frequentes, mensagens em pt-BR estilo conventional (`feat:`, `fix:`, `ci:`), rodapé `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.
- Fixtures reais já capturadas da cadeia F1 viva em `/tmp/f2_fixtures/` (2026-07-03) — usadas nos testes de contrato das Tasks 3 e 4.
- **Fora do escopo desta fase** (itens do spec §4 que não bloqueiam o critério de aceite da F2 — ficam para depois, sem gap silencioso): pseudo-modelos ⇄ tiers (§4.3, `gateway.config.jsonc` com `corehub-fast`/`corehub-deep`) — só `auto` é usado por enquanto, igual à F1; log estruturado por request (§4.5) — os headers `X-Manifest-*` já chegam ao cliente de graça (o passthrough via `hono/proxy` preserva os headers da resposta sem código extra), só falta agregação/log próprio; fixtures dedicadas para o chunk de usage com `choices:[]`, `424` de fallback esgotado e SSE forçado sem `stream:true` (§8) — são quirks que importam pro *tradutor* da F3, não pro passthrough burro da F2, que encaminha qualquer status/byte sem interpretar.

---

### Task 1: Scaffold do monorepo Bun + pacote `gateway`

**Files:**
- Create: `package.json` (raiz, workspaces)
- Create: `tsconfig.json` (raiz, estrito)
- Create: `biome.json`
- Create: `packages/gateway/package.json`
- Create: `packages/gateway/tsconfig.json`
- Create: `packages/gateway/src/index.ts`
- Create: `packages/gateway/test/smoke.test.ts`
- Modify: `.gitignore` (adicionar `*.tsbuildinfo`)

**Interfaces:**
- Produces: `bun install` funcional na raiz; `bun run --cwd packages/gateway test` roda `bun test`; app Hono mínimo respondendo `GET /` com texto `"corehub gateway"`.

- [ ] **Step 1: Verificar bun instalado**

Run: `bun --version`
Expected: uma versão `1.x` impressa (ambiente já tem `1.3.6`; imagem Docker será `1.3.14` — compatível, mesma major).

- [ ] **Step 2: Criar `package.json` raiz**

```json
{
  "name": "ia-stack",
  "private": true,
  "workspaces": ["packages/*"],
  "scripts": {
    "typecheck": "tsc --build --pretty",
    "lint": "biome check .",
    "lint:fix": "biome check --write .",
    "test": "bun test"
  },
  "devDependencies": {
    "@biomejs/biome": "2.5.2",
    "typescript": "6.0.3"
  }
}
```

- [ ] **Step 3: Criar `tsconfig.json` raiz**

Raiz é só a base compartilhada + orquestrador do `tsc --build` (não é um "projeto" buildável ela mesma — `composite`/`types` ficam no `tsconfig.json` do pacote, senão `tsc --build` tenta compilar a raiz como projeto e quebra com `TS6304`/`TS2688`, achado empiricamente ao rodar o Step 11 pela primeira vez):

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "files": [],
  "references": [{ "path": "packages/gateway" }]
}
```

- [ ] **Step 4: Criar `biome.json`**

O schema 2.x moveu `organizeImports` pra dentro de `assist.actions.source`, e `linter.rules.recommended` virou `linter.rules.preset` (achado empiricamente: `bunx biome migrate --write` reescreve sozinho, mas o resultado do migrate usa `"preset": "none"` por padrão — trocar pra `"recommended"` manualmente, senão nenhuma regra roda):

```json
{
  "$schema": "https://biomejs.dev/schemas/2.5.2/schema.json",
  "vcs": { "enabled": true, "clientKind": "git", "useIgnoreFile": true },
  "assist": { "actions": { "source": { "organizeImports": "on" } } },
  "linter": { "enabled": true, "rules": { "preset": "recommended" } },
  "formatter": { "enabled": true, "indentStyle": "space", "indentWidth": 2, "lineWidth": 100 }
}
```

Na Task 4, quando a fixture `messages-nonstream.body.json` entrar, o Biome vai querer reformatar esses bytes capturados ao vivo (perde o "exatamente como veio da cadeia real") — adicionar `"files": { "includes": ["**", "!**/test/fixtures"] }` ao `biome.json` nessa hora (ou já deixar aqui, adiantado).

- [ ] **Step 5: Criar `packages/gateway/package.json`**

```json
{
  "name": "@ia-stack/gateway",
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

- [ ] **Step 6: Criar `packages/gateway/tsconfig.json`**

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

- [ ] **Step 7: Criar `packages/gateway/src/index.ts` (mínimo)**

```typescript
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
```

- [ ] **Step 8: Criar `packages/gateway/test/smoke.test.ts`**

```typescript
import { describe, expect, it } from "bun:test";
import { buildApp } from "../src/index.js";

describe("gateway smoke", () => {
  it("GET / returns 200 with the gateway banner", async () => {
    const app = buildApp();
    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("corehub gateway");
  });
});
```

- [ ] **Step 9: Instalar dependências**

Run: `cd /home/fkmatsuda/workspace/corehub.ia/ia-stack && bun install`
Expected: `bun.lock` criado/atualizado na raiz, `node_modules` populado, exit 0.

- [ ] **Step 10: Rodar o teste de fumaça**

Run: `bun test packages/gateway/test/smoke.test.ts`
Expected: `1 pass`, exit 0.

- [ ] **Step 11: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: ambos exit 0. Se `tsc --build` deixar `.js`/`.d.ts` soltos dentro de `src/`/`test/` (em vez de só em `dist/`) por causa de uma config quebrada numa tentativa anterior, apagar esses arquivos soltos antes do lint (`dist/` já é ignorado pelo `.gitignore`, mas arquivos soltos fora dele não são e o Biome vai reclamar deles).

- [ ] **Step 12: Adicionar `*.tsbuildinfo` ao `.gitignore` e commitar**

```bash
git add package.json tsconfig.json biome.json bun.lock .gitignore \
  packages/gateway/package.json packages/gateway/tsconfig.json \
  packages/gateway/src/index.ts packages/gateway/test/smoke.test.ts
git commit -m "$(cat <<'EOF'
feat(f2): scaffold do monorepo bun + pacote gateway (hono minimo + smoke test)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Config + CIDR + auth LAN (spec §4.4)

**Files:**
- Create: `packages/gateway/src/config.ts`
- Create: `packages/gateway/src/cidr.ts`
- Create: `packages/gateway/src/auth.ts`
- Create: `packages/gateway/test/cidr.test.ts`
- Create: `packages/gateway/test/auth.test.ts`

**Interfaces:**
- Consumes: nada (funções puras + Hono `Context`).
- Produces: `loadConfig(env?): GatewayConfig` (campos: `port`, `headroomUrl`, `manifestUrl`, `trustedCidrs: string[]`, `defaultKey`, `corsOrigins: string[]`); `ipInCidr(ip, cidr): boolean`, `ipInAnyCidr(ip, cidrs): boolean`; `createAuthMiddleware(opts: {trustedCidrs, defaultKey})` — middleware Hono que, quando permite request sem credencial, faz `c.set("injectedAuthHeader", "Bearer <defaultKey>")` para as rotas da Task 3/4 lerem via `c.get("injectedAuthHeader")`.

- [ ] **Step 1: Escrever teste de `ipInCidr`/`ipInAnyCidr`**

```typescript
// packages/gateway/test/cidr.test.ts
import { describe, expect, it } from "bun:test";
import { ipInAnyCidr, ipInCidr } from "../src/cidr.js";

describe("ipInCidr", () => {
  it("matches an address inside a /24", () => {
    expect(ipInCidr("172.28.1.42", "172.28.1.0/24")).toBe(true);
  });
  it("rejects an address outside the /24", () => {
    expect(ipInCidr("172.28.2.1", "172.28.1.0/24")).toBe(false);
  });
  it("treats a bare IP (no prefix) as /32", () => {
    expect(ipInCidr("10.0.0.5", "10.0.0.5")).toBe(true);
    expect(ipInCidr("10.0.0.6", "10.0.0.5")).toBe(false);
  });
  it("0.0.0.0/0 matches everything", () => {
    expect(ipInCidr("8.8.8.8", "0.0.0.0/0")).toBe(true);
  });
  it("rejects malformed input instead of throwing", () => {
    expect(ipInCidr("not-an-ip", "10.0.0.0/8")).toBe(false);
    expect(ipInCidr("10.0.0.1", "not-a-cidr/8")).toBe(false);
  });
});

describe("ipInAnyCidr", () => {
  it("matches if any CIDR in the list matches", () => {
    expect(ipInAnyCidr("192.168.1.5", ["10.0.0.0/8", "192.168.1.0/24"])).toBe(true);
  });
  it("returns false for an empty list", () => {
    expect(ipInAnyCidr("192.168.1.5", [])).toBe(false);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun test packages/gateway/test/cidr.test.ts`
Expected: FAIL — `Cannot find module '../src/cidr.js'`.

- [ ] **Step 3: Implementar `packages/gateway/src/cidr.ts`**

```typescript
function ipToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    result = (result << 8) | n;
  }
  return result >>> 0;
}

export function ipInCidr(ip: string, cidr: string): boolean {
  const slashIndex = cidr.indexOf("/");
  const rangeIp = slashIndex === -1 ? cidr : cidr.slice(0, slashIndex);
  const prefix = slashIndex === -1 ? 32 : Number(cidr.slice(slashIndex + 1));
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;

  const ipInt = ipToInt(ip);
  const rangeInt = ipToInt(rangeIp);
  if (ipInt === null || rangeInt === null) return false;
  if (prefix === 0) return true;

  const mask = prefix === 32 ? 0xffffffff : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipInt & mask) === (rangeInt & mask);
}

export function ipInAnyCidr(ip: string, cidrs: string[]): boolean {
  return cidrs.some((cidr) => ipInCidr(ip, cidr));
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `bun test packages/gateway/test/cidr.test.ts`
Expected: `7 pass`, exit 0.

- [ ] **Step 5: Escrever teste de `loadConfig`**

Adicionar ao topo do arquivo de teste do config (criar `packages/gateway/test/config.test.ts`):

```typescript
import { describe, expect, it } from "bun:test";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("applies documented defaults when env is empty", () => {
    const config = loadConfig({});
    expect(config.port).toBe(11434);
    expect(config.headroomUrl).toBe("http://headroom:8787");
    expect(config.manifestUrl).toBe("http://manifest:2099");
    expect(config.trustedCidrs).toEqual([]);
    expect(config.defaultKey).toBe("");
    expect(config.corsOrigins).toEqual([]);
  });

  it("reads and trims comma-separated lists", () => {
    const config = loadConfig({
      GATEWAY_TRUSTED_CIDRS: " 172.28.1.0/24 , 127.0.0.1/32",
      GATEWAY_CORS_ORIGINS: "http://localhost:3000,http://openwebui:3000",
    });
    expect(config.trustedCidrs).toEqual(["172.28.1.0/24", "127.0.0.1/32"]);
    expect(config.corsOrigins).toEqual(["http://localhost:3000", "http://openwebui:3000"]);
  });

  it("strips a trailing slash from the target URLs", () => {
    const config = loadConfig({ HEADROOM_URL: "http://headroom:8787/" });
    expect(config.headroomUrl).toBe("http://headroom:8787");
  });
});
```

- [ ] **Step 6: Rodar e ver falhar**

Run: `bun test packages/gateway/test/config.test.ts`
Expected: FAIL — módulo não existe.

- [ ] **Step 7: Implementar `packages/gateway/src/config.ts`**

```typescript
export type GatewayConfig = {
  port: number;
  headroomUrl: string;
  manifestUrl: string;
  trustedCidrs: string[];
  defaultKey: string;
  corsOrigins: string[];
};

function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): GatewayConfig {
  return {
    port: Number(env.GATEWAY_PORT ?? "11434"),
    headroomUrl: stripTrailingSlash(env.HEADROOM_URL ?? "http://headroom:8787"),
    manifestUrl: stripTrailingSlash(env.MANIFEST_URL ?? "http://manifest:2099"),
    trustedCidrs: splitList(env.GATEWAY_TRUSTED_CIDRS),
    defaultKey: env.GATEWAY_DEFAULT_KEY ?? "",
    corsOrigins: splitList(env.GATEWAY_CORS_ORIGINS),
  };
}
```

- [ ] **Step 8: Rodar e ver passar**

Run: `bun test packages/gateway/test/config.test.ts`
Expected: `3 pass`, exit 0.

- [ ] **Step 9: Escrever teste do middleware de auth**

```typescript
// packages/gateway/test/auth.test.ts
import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { createAuthMiddleware } from "../src/auth.js";

type Env = { Bindings: { ip?: string }; Variables: { injectedAuthHeader?: string } };

function buildTestApp(opts: { trustedCidrs: string[]; defaultKey: string }) {
  const app = new Hono<Env>();
  app.use("*", createAuthMiddleware(opts));
  app.get("/probe", (c) => c.json({ injected: c.get("injectedAuthHeader") ?? null }));
  return app;
}

describe("createAuthMiddleware", () => {
  it("passes through when Authorization is present, regardless of IP", async () => {
    const app = buildTestApp({ trustedCidrs: [], defaultKey: "mnfst_default" });
    const res = await app.request(
      "/probe",
      { headers: { authorization: "Bearer mnfst_whatever" } },
      { ip: "8.8.8.8" },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { injected: string | null };
    expect(body.injected).toBeNull();
  });

  it("passes through when x-api-key is present", async () => {
    const app = buildTestApp({ trustedCidrs: [], defaultKey: "mnfst_default" });
    const res = await app.request(
      "/probe",
      { headers: { "x-api-key": "sk-whatever" } },
      { ip: "8.8.8.8" },
    );
    expect(res.status).toBe(200);
  });

  it("injects the default key for an untrusted-but-loopback caller with no credential", async () => {
    const app = buildTestApp({ trustedCidrs: [], defaultKey: "mnfst_default" });
    const res = await app.request("/probe", {}, { ip: "127.0.0.1" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { injected: string | null };
    expect(body.injected).toBe("Bearer mnfst_default");
  });

  it("injects the default key for a caller inside GATEWAY_TRUSTED_CIDRS", async () => {
    const app = buildTestApp({ trustedCidrs: ["172.28.1.0/24"], defaultKey: "mnfst_default" });
    const res = await app.request("/probe", {}, { ip: "172.28.1.7" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { injected: string | null };
    expect(body.injected).toBe("Bearer mnfst_default");
  });

  it("rejects a credential-less caller outside every trusted CIDR with 401", async () => {
    const app = buildTestApp({ trustedCidrs: ["172.28.1.0/24"], defaultKey: "mnfst_default" });
    const res = await app.request("/probe", {}, { ip: "203.0.113.9" });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { type: string; code: string } };
    expect(body.error.type).toBe("auth_error");
    expect(body.error.code).toBe("gateway_auth");
  });
});
```

- [ ] **Step 10: Rodar e ver falhar**

Run: `bun test packages/gateway/test/auth.test.ts`
Expected: FAIL — módulo não existe.

- [ ] **Step 11: Implementar `packages/gateway/src/auth.ts`**

```typescript
import type { Context, Next } from "hono";
import { ipInAnyCidr } from "./cidr.js";

export type AuthEnv = {
  Bindings: { ip?: string };
  Variables: { injectedAuthHeader?: string };
};

const LOOPBACK_IPS = new Set(["127.0.0.1", "::1"]);

export function createAuthMiddleware(opts: { trustedCidrs: string[]; defaultKey: string }) {
  return async (c: Context<AuthEnv>, next: Next) => {
    const hasCredential =
      c.req.header("authorization") !== undefined || c.req.header("x-api-key") !== undefined;
    if (hasCredential) {
      await next();
      return;
    }

    const ip = c.env?.ip;
    const trusted =
      ip !== undefined && (LOOPBACK_IPS.has(ip) || ipInAnyCidr(ip, opts.trustedCidrs));
    if (!trusted) {
      return c.json(
        {
          error: {
            message:
              "Missing Authorization/x-api-key header, and the caller is not loopback or in GATEWAY_TRUSTED_CIDRS.",
            type: "auth_error",
            code: "gateway_auth",
          },
        },
        401,
      );
    }

    c.set("injectedAuthHeader", `Bearer ${opts.defaultKey}`);
    await next();
  };
}
```

- [ ] **Step 12: Rodar e ver passar**

Run: `bun test packages/gateway/test/auth.test.ts`
Expected: `5 pass`, exit 0.

- [ ] **Step 13: Typecheck + lint + commit**

```bash
cd /home/fkmatsuda/workspace/corehub.ia/ia-stack
bun run typecheck
bun run lint
git add packages/gateway/src/config.ts packages/gateway/src/cidr.ts packages/gateway/src/auth.ts \
  packages/gateway/test/cidr.test.ts packages/gateway/test/config.test.ts packages/gateway/test/auth.test.ts
git commit -m "$(cat <<'EOF'
feat(f2): config + cidr matching + auth LAN (spec 4.4)

HEADROOM_PROXY_TOKEN nao existe no headroom 0.27.0 (verificado no source) --
o hop gateway->headroom nao tem shared-secret; a seguranca vem da rede
interna do compose (headroom sem porta publicada), nao de um token.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Superfície OpenAI (passthrough)

**Files:**
- Create: `packages/gateway/test/fixtures/chat-completions-nonstream.headers.txt`
- Create: `packages/gateway/test/fixtures/chat-completions-nonstream.body.json`
- Create: `packages/gateway/test/fixtures/chat-completions-stream.headers.txt`
- Create: `packages/gateway/test/fixtures/chat-completions-stream.body.txt`
- Create: `packages/gateway/test/fixtures/models.headers.txt`
- Create: `packages/gateway/test/fixtures/models.body.json`
- Create: `packages/gateway/test/fixtures/unauthenticated.headers.txt`
- Create: `packages/gateway/test/fixtures/unauthenticated.body.json`
- Create: `packages/gateway/test/support/mock-upstream.ts`
- Create: `packages/gateway/src/routes/openai.ts`
- Create: `packages/gateway/test/openai-routes.test.ts`

**Interfaces:**
- Consumes: `GatewayConfig` (Task 2), `AuthEnv`/`createAuthMiddleware` (Task 2).
- Produces: `registerOpenAiRoutes(app: Hono<AuthEnv>, config: GatewayConfig): void` — monta `POST /v1/chat/completions`, `POST /v1/responses`, `GET /v1/models`. `startMockUpstream(fixtureBaseName: string): { url: string; stop(): void }` (test support, reutilizado na Task 4).

- [ ] **Step 1: Copiar as fixtures capturadas da cadeia viva**

As fixtures já foram capturadas nesta sessão (2026-07-03) direto do headroom/manifest reais rodando da F1, com `max_tokens:16` para ficarem compactas.

Run:
```bash
mkdir -p /home/fkmatsuda/workspace/corehub.ia/ia-stack/packages/gateway/test/fixtures
cp /tmp/f2_fixtures/chat-completions-nonstream.headers.txt \
   /tmp/f2_fixtures/chat-completions-nonstream.body.json \
   /tmp/f2_fixtures/chat-completions-stream.headers.txt \
   /tmp/f2_fixtures/chat-completions-stream.body.txt \
   /tmp/f2_fixtures/models.headers.txt \
   /tmp/f2_fixtures/models.body.json \
   /tmp/f2_fixtures/unauthenticated.headers.txt \
   /tmp/f2_fixtures/unauthenticated.body.json \
   /home/fkmatsuda/workspace/corehub.ia/ia-stack/packages/gateway/test/fixtures/
```
Expected: 8 arquivos em `packages/gateway/test/fixtures/`.

- [ ] **Step 2: Criar o mock upstream de teste**

Serve os bytes exatos de uma fixture (headers + body) num servidor Bun efêmero, para os testes de contrato rodarem sem a cadeia Docker real.

```typescript
// packages/gateway/test/support/mock-upstream.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FIXTURES_DIR = join(import.meta.dir, "..", "fixtures");

function parseStatus(headersText: string): number {
  const firstLine = headersText.split("\r\n")[0] ?? headersText.split("\n")[0] ?? "";
  const match = /HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(firstLine);
  return match ? Number(match[1]) : 200;
}

function parseHeaders(headersText: string): Headers {
  const headers = new Headers();
  const skip = new Set(["content-length", "connection", "keep-alive", "transfer-encoding"]);
  for (const line of headersText.split(/\r?\n/).slice(1)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const name = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (!name || skip.has(name)) continue;
    headers.append(name, value);
  }
  return headers;
}

export function startMockUpstream(fixtureBaseName: string): { url: string; stop(): void } {
  const headersText = readFileSync(join(FIXTURES_DIR, `${fixtureBaseName}.headers.txt`), "utf8");
  // endsWith, nao includes: "chat-completions-nonstream" tambem contem a
  // substring "stream" (achado ao rodar o teste pela primeira vez).
  const isText = fixtureBaseName.endsWith("-stream");
  const bodyPath = join(FIXTURES_DIR, `${fixtureBaseName}.body.${isText ? "txt" : "json"}`);
  const body = readFileSync(bodyPath);
  const status = parseStatus(headersText);
  const headers = parseHeaders(headersText);

  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Response(body, { status, headers });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
  };
}
```

- [ ] **Step 3: Escrever o teste de contrato das rotas OpenAI**

```typescript
// packages/gateway/test/openai-routes.test.ts
import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { createAuthMiddleware, type AuthEnv } from "../src/auth.js";
import { registerOpenAiRoutes } from "../src/routes/openai.js";
import { startMockUpstream } from "./support/mock-upstream.js";
import type { GatewayConfig } from "../src/config.js";

function buildApp(headroomUrl: string) {
  const config: GatewayConfig = {
    port: 0,
    headroomUrl,
    manifestUrl: "http://unused:2099",
    trustedCidrs: [],
    defaultKey: "mnfst_default",
    corsOrigins: [],
  };
  const app = new Hono<AuthEnv>();
  app.use("*", createAuthMiddleware(config));
  registerOpenAiRoutes(app, config);
  return app;
}

describe("OpenAI passthrough routes", () => {
  it("proxies a non-streaming chat.completions response byte-for-byte", async () => {
    const upstream = startMockUpstream("chat-completions-nonstream");
    try {
      const app = buildApp(upstream.url);
      const res = await app.request(
        "/v1/chat/completions",
        {
          method: "POST",
          headers: { authorization: "Bearer mnfst_opencode", "content-type": "application/json" },
          body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] }),
        },
        { ip: "127.0.0.1" },
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("x-manifest-model")).toBe("qwen2.5:0.5b");
      const body = (await res.json()) as { object: string };
      expect(body.object).toBe("chat.completion");
    } finally {
      upstream.stop();
    }
  });

  it("proxies a streaming SSE response with headers and terminator intact", async () => {
    const upstream = startMockUpstream("chat-completions-stream");
    try {
      const app = buildApp(upstream.url);
      const res = await app.request(
        "/v1/chat/completions",
        {
          method: "POST",
          headers: { authorization: "Bearer mnfst_opencode", "content-type": "application/json" },
          body: JSON.stringify({ model: "auto", stream: true, messages: [{ role: "user", content: "hi" }] }),
        },
        { ip: "127.0.0.1" },
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const text = await res.text();
      expect(text.trim().endsWith("data: [DONE]")).toBe(true);
    } finally {
      upstream.stop();
    }
  });

  it("proxies GET /v1/models", async () => {
    const upstream = startMockUpstream("models");
    try {
      const app = buildApp(upstream.url);
      const res = await app.request("/v1/models", { headers: { authorization: "Bearer mnfst_opencode" } }, { ip: "127.0.0.1" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Array<{ id: string }> };
      expect(body.data[0]?.id).toBe("auto");
    } finally {
      upstream.stop();
    }
  });

  it("injects the default key when an untrusted-CIDR caller has none, and 401s from further out", async () => {
    const upstream = startMockUpstream("models");
    try {
      const app = buildApp(upstream.url);
      const okRes = await app.request("/v1/models", {}, { ip: "127.0.0.1" });
      expect(okRes.status).toBe(200);
    } finally {
      upstream.stop();
    }
  });

  it("returns manifest's 401 body untouched when the upstream itself rejects (bad key case)", async () => {
    const upstream = startMockUpstream("unauthenticated");
    try {
      const app = buildApp(upstream.url);
      const res = await app.request("/v1/models", { headers: { authorization: "Bearer mnfst_invalid" } }, { ip: "127.0.0.1" });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("manifest_auth");
    } finally {
      upstream.stop();
    }
  });
});
```

- [ ] **Step 4: Rodar e ver falhar**

Run: `bun test packages/gateway/test/openai-routes.test.ts`
Expected: FAIL — `../src/routes/openai.js` não existe.

- [ ] **Step 5: Implementar `packages/gateway/src/routes/openai.ts`**

```typescript
import type { Context, Hono } from "hono";
import { proxy } from "hono/proxy";
import type { AuthEnv } from "../auth.js";
import type { GatewayConfig } from "../config.js";

function proxyHeaders(c: Context<AuthEnv>): Record<string, string> {
  const injected = c.get("injectedAuthHeader");
  const headers: Record<string, string> = { ...c.req.header() };
  delete headers.host;
  if (injected) headers.authorization = injected;
  return headers;
}

export function registerOpenAiRoutes(app: Hono<AuthEnv>, config: GatewayConfig): void {
  app.post("/v1/chat/completions", (c) =>
    proxy(`${config.headroomUrl}/v1/chat/completions`, {
      ...c.req,
      headers: proxyHeaders(c),
    }),
  );

  app.post("/v1/responses", (c) =>
    proxy(`${config.headroomUrl}/v1/responses`, {
      ...c.req,
      headers: proxyHeaders(c),
    }),
  );

  app.get("/v1/models", (c) =>
    proxy(`${config.headroomUrl}/v1/models`, {
      ...c.req,
      headers: proxyHeaders(c),
    }),
  );
}
```

- [ ] **Step 6: Rodar e corrigir até verde**

Run: `bun test packages/gateway/test/openai-routes.test.ts`
Expected: `5 pass`. O spread `...c.req` do `hono/proxy` funcionou de primeira nesta sessão (`hono@4.12.27`, incluindo o corpo do streaming) — não precisou do fallback abaixo. Se uma versão futura do Hono quebrar a assinatura do `ProxyRequestInit`, o fallback é montar o `RequestInit` explicitamente:

```typescript
proxy(url, {
  method: c.req.method,
  body: c.req.raw.body,
  headers: proxyHeaders(c),
})
```

- [ ] **Step 7: Typecheck + lint + commit**

```bash
cd /home/fkmatsuda/workspace/corehub.ia/ia-stack
bun run typecheck
bun run lint
git add packages/gateway/test/fixtures packages/gateway/test/support \
  packages/gateway/src/routes/openai.ts packages/gateway/test/openai-routes.test.ts
git commit -m "$(cat <<'EOF'
feat(f2): superficie OpenAI (chat/completions, responses, models) via hono/proxy

Fixtures de contrato capturadas ao vivo da cadeia F1 (headroom 0.27.0 ->
manifest 6.12.0 -> ollama local) em 2026-07-03; mock upstream serve os
bytes exatos para os testes rodarem sem Docker.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Superfície Anthropic (passthrough)

**Files:**
- Create: `packages/gateway/test/fixtures/messages-nonstream.headers.txt`
- Create: `packages/gateway/test/fixtures/messages-nonstream.body.json`
- Create: `packages/gateway/src/routes/anthropic.ts`
- Create: `packages/gateway/test/anthropic-routes.test.ts`

**Interfaces:**
- Consumes: `GatewayConfig`, `AuthEnv` (Task 2); `startMockUpstream` (Task 3).
- Produces: `registerAnthropicRoutes(app: Hono<AuthEnv>, config: GatewayConfig): void` — monta `POST /v1/messages`, `POST /v1/messages/count_tokens`.

- [ ] **Step 1: Copiar a fixture Anthropic**

Run:
```bash
cp /tmp/f2_fixtures/messages-nonstream.headers.txt /tmp/f2_fixtures/messages-nonstream.body.json \
   /home/fkmatsuda/workspace/corehub.ia/ia-stack/packages/gateway/test/fixtures/
```

- [ ] **Step 2: Escrever o teste de contrato**

```typescript
// packages/gateway/test/anthropic-routes.test.ts
import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { createAuthMiddleware, type AuthEnv } from "../src/auth.js";
import { registerAnthropicRoutes } from "../src/routes/anthropic.js";
import { startMockUpstream } from "./support/mock-upstream.js";
import type { GatewayConfig } from "../src/config.js";

function buildApp(headroomUrl: string) {
  const config: GatewayConfig = {
    port: 0,
    headroomUrl,
    manifestUrl: "http://unused:2099",
    trustedCidrs: [],
    defaultKey: "mnfst_default",
    corsOrigins: [],
  };
  const app = new Hono<AuthEnv>();
  app.use("*", createAuthMiddleware(config));
  registerAnthropicRoutes(app, config);
  return app;
}

describe("Anthropic passthrough routes", () => {
  it("proxies POST /v1/messages and forwards anthropic-version verbatim", async () => {
    const upstream = startMockUpstream("messages-nonstream");
    try {
      const app = buildApp(upstream.url);
      const res = await app.request(
        "/v1/messages",
        {
          method: "POST",
          headers: {
            authorization: "Bearer mnfst_claude-code",
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify({ model: "auto", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
        },
        { ip: "127.0.0.1" },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { type: string; content: Array<{ type: string }> };
      expect(body.type).toBe("message");
      expect(body.content[0]?.type).toBe("text");
    } finally {
      upstream.stop();
    }
  });

  it("forwards /v1/messages/count_tokens opaquely (manifest 404 is acceptable, per Claude Code's graceful degrade)", async () => {
    const upstream = startMockUpstream("unauthenticated"); // any fixture with a JSON body works for this shape check
    try {
      const app = buildApp(upstream.url);
      const res = await app.request(
        "/v1/messages/count_tokens",
        {
          method: "POST",
          headers: { authorization: "Bearer mnfst_claude-code", "content-type": "application/json" },
          body: JSON.stringify({ model: "auto", messages: [] }),
        },
        { ip: "127.0.0.1" },
      );
      expect(res.status).toBe(401); // this fixture is the 401 body; proves the route exists and proxies through
    } finally {
      upstream.stop();
    }
  });
});
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `bun test packages/gateway/test/anthropic-routes.test.ts`
Expected: FAIL — módulo não existe.

- [ ] **Step 4: Implementar `packages/gateway/src/routes/anthropic.ts`**

```typescript
import type { Context, Hono } from "hono";
import { proxy } from "hono/proxy";
import type { AuthEnv } from "../auth.js";
import type { GatewayConfig } from "../config.js";

function proxyHeaders(c: Context<AuthEnv>): Record<string, string> {
  const injected = c.get("injectedAuthHeader");
  const headers: Record<string, string> = { ...c.req.header() };
  delete headers.host;
  if (injected) headers.authorization = injected;
  return headers;
}

export function registerAnthropicRoutes(app: Hono<AuthEnv>, config: GatewayConfig): void {
  app.post("/v1/messages", (c) =>
    proxy(`${config.headroomUrl}/v1/messages`, {
      ...c.req,
      headers: proxyHeaders(c),
    }),
  );

  app.post("/v1/messages/count_tokens", (c) =>
    proxy(`${config.headroomUrl}/v1/messages/count_tokens`, {
      ...c.req,
      headers: proxyHeaders(c),
    }),
  );
}
```

- [ ] **Step 5: Rodar e corrigir até verde**

Run: `bun test packages/gateway/test/anthropic-routes.test.ts`
Expected: `2 pass`. Mesma ressalva empírica da Task 3 Step 6 se a assinatura do `proxy()` reclamar do spread.

- [ ] **Step 6: Rodar TODA a suíte do gateway junta**

Run: `cd /home/fkmatsuda/workspace/corehub.ia/ia-stack && bun test packages/gateway/test`

(escopar em `packages/gateway/test`, não no diretório do pacote inteiro — achado ao rodar pela primeira vez: `bun test packages/gateway` também executa os `.js` compilados que `tsc --build` deixa em `packages/gateway/dist/`, que não têm as fixtures copiadas e falham com `ENOENT`)
Expected: todos os testes (smoke + cidr + config + auth + openai-routes + anthropic-routes) `pass`, exit 0.

- [ ] **Step 7: Typecheck + lint + commit**

```bash
bun run typecheck
bun run lint
git add packages/gateway/test/fixtures/messages-nonstream.headers.txt \
  packages/gateway/test/fixtures/messages-nonstream.body.json \
  packages/gateway/src/routes/anthropic.ts packages/gateway/test/anthropic-routes.test.ts
git commit -m "$(cat <<'EOF'
feat(f2): superficie Anthropic (messages, count_tokens) via hono/proxy

count_tokens nao existe no manifest 6.12.0 -- gateway encaminha mesmo
assim (opaco); Claude Code degrada bem sozinho quando o endpoint falta
(estima o contexto localmente), confirmado na doc oficial.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: CORS + `/health` agregado + montagem final do app

**Files:**
- Create: `packages/gateway/src/routes/health.ts`
- Create: `packages/gateway/test/health.test.ts`
- Modify: `packages/gateway/src/index.ts` (monta CORS + todas as rotas + `Bun.serve` com `requestIP`)
- Modify: `packages/gateway/test/smoke.test.ts` (ajustar para `buildApp(config)` já com auth montado, se necessário)

**Interfaces:**
- Consumes: tudo das Tasks 2–4.
- Produces: `registerHealthRoute(app: Hono<AuthEnv>, config: GatewayConfig): void`; `buildApp(config: GatewayConfig): Hono<AuthEnv>` (versão final, exportada para os testes e para o `Bun.serve`).

- [ ] **Step 1: Escrever o teste de `/health`**

```typescript
// packages/gateway/test/health.test.ts
import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import type { AuthEnv } from "../src/auth.js";
import { registerHealthRoute } from "../src/routes/health.js";
import type { GatewayConfig } from "../src/config.js";

function baseConfig(overrides: Partial<GatewayConfig>): GatewayConfig {
  return {
    port: 0,
    headroomUrl: "http://127.0.0.1:1",
    manifestUrl: "http://127.0.0.1:1",
    trustedCidrs: [],
    defaultKey: "",
    corsOrigins: [],
    ...overrides,
  };
}

describe("GET /health", () => {
  it("returns 200 status ok when both hops respond ok", async () => {
    const headroom = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const manifest = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    try {
      const app = new Hono<AuthEnv>();
      registerHealthRoute(
        app,
        baseConfig({ headroomUrl: `http://127.0.0.1:${headroom.port}`, manifestUrl: `http://127.0.0.1:${manifest.port}` }),
      );
      const res = await app.request("/health");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; gateway: string };
      expect(body.status).toBe("ok");
      expect(body.gateway).toBe("ok");
    } finally {
      headroom.stop(true);
      manifest.stop(true);
    }
  });

  it("returns 503 status degraded when a hop is unreachable", async () => {
    const manifest = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    try {
      const app = new Hono<AuthEnv>();
      registerHealthRoute(
        app,
        baseConfig({ headroomUrl: "http://127.0.0.1:1", manifestUrl: `http://127.0.0.1:${manifest.port}` }),
      );
      const res = await app.request("/health");
      expect(res.status).toBe(503);
      const body = (await res.json()) as { status: string };
      expect(body.status).toBe("degraded");
    } finally {
      manifest.stop(true);
    }
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun test packages/gateway/test/health.test.ts`
Expected: FAIL — módulo não existe.

- [ ] **Step 3: Implementar `packages/gateway/src/routes/health.ts`**

```typescript
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
      { status: allOk ? "ok" : "degraded", gateway: "ok", headroom: headroom.detail, manifest: manifest.detail },
      allOk ? 200 : 503,
    );
  });
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `bun test packages/gateway/test/health.test.ts`
Expected: `2 pass`, exit 0.

- [ ] **Step 5: Montar o `index.ts` final**

```typescript
// packages/gateway/src/index.ts
import { Hono } from "hono";
import { cors } from "hono/cors";
import { createAuthMiddleware, type AuthEnv } from "./auth.js";
import { loadConfig, type GatewayConfig } from "./config.js";
import { registerAnthropicRoutes } from "./routes/anthropic.js";
import { registerHealthRoute } from "./routes/health.js";
import { registerOpenAiRoutes } from "./routes/openai.js";

export function buildApp(config: GatewayConfig): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  if (config.corsOrigins.length > 0) {
    app.use("*", cors({ origin: config.corsOrigins }));
  }

  registerHealthRoute(app, config);

  app.use("/v1/*", createAuthMiddleware(config));
  registerOpenAiRoutes(app, config);
  registerAnthropicRoutes(app, config);

  return app;
}

if (import.meta.main) {
  const config = loadConfig();
  const app = buildApp(config);

  Bun.serve({
    port: config.port,
    fetch(req, server) {
      const ip = server.requestIP(req)?.address;
      return app.fetch(req, { ip });
    },
  });

  console.log(`corehub gateway listening on :${config.port} (headroom=${config.headroomUrl})`);
}
```

- [ ] **Step 6: Atualizar `packages/gateway/test/smoke.test.ts` para o `buildApp(config)` novo**

```typescript
// packages/gateway/test/smoke.test.ts
import { describe, expect, it } from "bun:test";
import { buildApp } from "../src/index.js";
import { loadConfig } from "../src/config.js";

describe("gateway smoke", () => {
  it("GET /health responds (even if degraded, since there's no real upstream in this test)", async () => {
    const app = buildApp(loadConfig({}));
    const res = await app.request("/health");
    expect([200, 503]).toContain(res.status);
  });
});
```

- [ ] **Step 7: Rodar a suíte inteira**

Run: `cd /home/fkmatsuda/workspace/corehub.ia/ia-stack && bun test packages/gateway/test`

(escopar em `packages/gateway/test`, não no diretório do pacote inteiro — achado ao rodar pela primeira vez: `bun test packages/gateway` também executa os `.js` compilados que `tsc --build` deixa em `packages/gateway/dist/`, que não têm as fixtures copiadas e falham com `ENOENT`)
Expected: todos os testes `pass`.

- [ ] **Step 8: Subir local fora do Docker para smoke manual rápido**

```bash
cd /home/fkmatsuda/workspace/corehub.ia/ia-stack
HEADROOM_URL=http://127.0.0.1:8787 MANIFEST_URL=http://localhost:2099 \
  GATEWAY_DEFAULT_KEY=$(grep MANIFEST_KEY_LAN_ANON deploy/compose/.env | cut -d= -f2) \
  bun run --cwd packages/gateway start &
sleep 1
curl -sS http://localhost:11434/health | jq .
kill %1
```

Expected: `"status":"ok"` (a cadeia F1 já está de pé nesta sessão).

- [ ] **Step 9: Typecheck + lint + commit**

```bash
bun run typecheck
bun run lint
git add packages/gateway/src/routes/health.ts packages/gateway/test/health.test.ts \
  packages/gateway/src/index.ts packages/gateway/test/smoke.test.ts
git commit -m "$(cat <<'EOF'
feat(f2): /health agregado (headroom+manifest) + montagem final do app (CORS+auth+rotas)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Dockerfile + compose (gateway entra, headroom perde a porta host)

**Files:**
- Create: `packages/gateway/Dockerfile`
- Create: `packages/gateway/.dockerignore`
- Modify: `deploy/compose/docker-compose.yml` (rede fixa, serviço `gateway`, `headroom` sem `ports:`)
- Modify: `deploy/compose/.env.example` (variáveis `GATEWAY_*`)
- Create: `deploy/compose/scripts/validate-gateway.sh` (variante do `validate-chain.sh` batendo em `:11434`)

**Interfaces:**
- Consumes: imagem construída de `packages/gateway` (Task 1–5).
- Produces: serviço `gateway` em `0.0.0.0:11434`; `validate-gateway.sh` — critério de aceite da F2, evolui para `corehub doctor` (F4).

- [ ] **Step 1: Criar `packages/gateway/.dockerignore`**

```
node_modules
dist
*.tsbuildinfo
test
```

- [ ] **Step 2: Criar `packages/gateway/Dockerfile`**

```dockerfile
FROM oven/bun:1.3.14-alpine

WORKDIR /repo

COPY package.json tsconfig.json bun.lock ./
COPY packages/gateway/package.json packages/gateway/package.json
RUN bun install --frozen-lockfile

COPY packages/gateway packages/gateway

WORKDIR /repo/packages/gateway
EXPOSE 11434
CMD ["bun", "run", "src/index.ts"]
```

- [ ] **Step 3: Testar o build da imagem isoladamente**

Run: `cd /home/fkmatsuda/workspace/corehub.ia/ia-stack && docker build -f packages/gateway/Dockerfile -t ia-stack-gateway:dev .`
Expected: build `Successfully` / exit 0. Se `bun install --frozen-lockfile` falhar por lockfile desatualizado, rodar `bun install` na raiz e recommitar o `bun.lock` atualizado antes de seguir.

- [ ] **Step 4: Adicionar rede fixa e serviço `gateway` ao compose; remover a porta host do `headroom`**

**Achado empírico ao rodar este step**: a máquina desta sessão já tinha um `ollama.service` nativo (systemd, fora do Docker) ocupando `127.0.0.1:11434` — `docker compose up` do serviço `gateway` bateria em `EADDRINUSE` na porta host. Perguntado ao usuário; decisão foi **não mexer no serviço do sistema** e usar uma porta host alternativa só nesta máquina via `GATEWAY_HOST_PORT` (env, default `11434`, documentado como o padrão real — outras máquinas da LAN sem esse conflito usam `11434` normalmente).

Editar `deploy/compose/docker-compose.yml`:

```yaml
name: ia-stack

networks:
  default:
    name: ia-stack_net
    ipam:
      config:
        - subnet: 172.28.1.0/24

services:
  gateway:
    build:
      context: ../..
      dockerfile: packages/gateway/Dockerfile
    restart: unless-stopped
    ports:
      # host configuravel (GATEWAY_HOST_PORT) porque uma maquina pode ja ter
      # um Ollama nativo ocupando a 11434 -- nao mexemos em servico do host
      # sem confirmar. 11434 continua sendo o padrao documentado pra LAN.
      - "0.0.0.0:${GATEWAY_HOST_PORT:-11434}:11434"
    environment:
      - GATEWAY_PORT=11434
      - HEADROOM_URL=http://headroom:8787
      - MANIFEST_URL=http://manifest:2099
      - GATEWAY_TRUSTED_CIDRS=${GATEWAY_TRUSTED_CIDRS:-172.28.1.0/24}
      - GATEWAY_DEFAULT_KEY=${MANIFEST_KEY_LAN_ANON}
      - GATEWAY_CORS_ORIGINS=${GATEWAY_CORS_ORIGINS:-}
    depends_on:
      headroom:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "bun", "-e", "fetch('http://127.0.0.1:11434/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 10s
      timeout: 5s
      retries: 12
      start_period: 15s
```

No serviço `manifest` já existente, remover nada (continua igual). No serviço `headroom` já existente, **remover** o bloco `ports:` inteiro (era `"127.0.0.1:8787:8787"` na F1) — headroom agora só é alcançável dentro da rede do compose, pelo `gateway`.

- [ ] **Step 5: Adicionar as variáveis `GATEWAY_*` ao `.env.example`**

Adicionar ao final de `deploy/compose/.env.example`:

```bash
# ── Gateway (F2) — auth LAN sem credencial só para a rede do compose ───
GATEWAY_TRUSTED_CIDRS=172.28.1.0/24
GATEWAY_CORS_ORIGINS=
# Porta host do gateway. 11434 é o padrão (emula a porta default do Ollama
# para os clientes acharem sozinhos). Só mude se a máquina já tiver um
# Ollama nativo ocupando 11434 (ex.: GATEWAY_HOST_PORT=21434).
GATEWAY_HOST_PORT=11434
```

- [ ] **Step 6: Aplicar as mesmas variáveis no `.env` local**

Run (ajustar `GATEWAY_HOST_PORT` se a máquina tiver um Ollama nativo — checar com `ss -tlnp | grep 11434` ou `curl -sS http://localhost:11434/api/version`; se responder `{"version":...}`, a porta já está ocupada):
```bash
cd /home/fkmatsuda/workspace/corehub.ia/ia-stack/deploy/compose
grep -q '^GATEWAY_TRUSTED_CIDRS=' .env || printf '\nGATEWAY_TRUSTED_CIDRS=172.28.1.0/24\nGATEWAY_CORS_ORIGINS=\nGATEWAY_HOST_PORT=11434\n' >> .env
```

- [ ] **Step 7: Validar sintaxe do compose**

Run: `cd /home/fkmatsuda/workspace/corehub.ia/ia-stack && docker compose -f deploy/compose/docker-compose.yml --env-file deploy/compose/.env config -q && echo OK`
Expected: `OK`.

- [ ] **Step 8: Subir a cadeia completa com o gateway**

Run:
```bash
cd /home/fkmatsuda/workspace/corehub.ia/ia-stack
docker compose -f deploy/compose/docker-compose.yml --env-file deploy/compose/.env --profile local-models up -d --build
sleep 15
docker compose -f deploy/compose/docker-compose.yml --profile local-models ps
```
Expected: 5 serviços `running`/`healthy` (manifest, postgres, headroom, ollama, **gateway**). Diagnosticar via `docker compose logs gateway` se `unhealthy`.

- [ ] **Step 9: Criar `deploy/compose/scripts/validate-gateway.sh`**

```bash
#!/usr/bin/env bash
# validate-gateway.sh — valida a cadeia gateway(:11434) -> headroom -> manifest -> provedor
set -u
cd "$(dirname "$0")/.."
set -a; source ./.env; set +a

GW="http://127.0.0.1:${GATEWAY_HOST_PORT:-11434}"
KEY="${MANIFEST_KEY_OPENCODE:?MANIFEST_KEY_OPENCODE ausente no .env}"
fail=0
say() { printf '%-52s %s\n' "$1" "$2"; }
check() {
  if [ "$2" = "$3" ]; then say "$1" "PASS"; else say "$1" "FAIL (esperado $2, obtido $3)"; fail=1; fi
}

check "GET /health" 200 "$(curl -sS -o /dev/null -w '%{http_code}' $GW/health)"

check "GET /v1/models (com chave)" 200 \
  "$(curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $KEY" $GW/v1/models)"
check "GET /v1/models (sem chave, fora da CIDR confiavel) => 401" 401 \
  "$(curl -sS -o /dev/null -w '%{http_code}' $GW/v1/models)"

body=$(curl -sS -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"model":"auto","max_tokens":16,"messages":[{"role":"user","content":"gateway-validate-openai"}]}' \
  $GW/v1/chat/completions)
echo "$body" | jq -e '.choices[0].message.content' >/dev/null \
  && say "POST /v1/chat/completions" PASS || { say "POST /v1/chat/completions" FAIL; echo "$body" | head -c 300; fail=1; }

curl -sSN -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"model":"auto","stream":true,"max_tokens":16,"messages":[{"role":"user","content":"gateway-validate-stream"}]}' \
  $GW/v1/chat/completions | tail -5 | grep -q '\[DONE\]' \
  && say "streaming SSE com [DONE]" PASS || { say "streaming SSE com [DONE]" FAIL; fail=1; }

code=$(curl -sS -o /tmp/gw_anth.json -w '%{http_code}' \
  -H "Authorization: Bearer $KEY" -H 'anthropic-version: 2023-06-01' -H 'Content-Type: application/json' \
  -d '{"model":"auto","max_tokens":16,"messages":[{"role":"user","content":"gateway-validate-anthropic"}]}' \
  $GW/v1/messages)
check "POST /v1/messages" 200 "$code"

resp=$(curl -sS -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"model":"auto","max_tokens":16,"input":"gateway-validate-responses"}' \
  $GW/v1/responses)
echo "$resp" | jq -e '.object=="response"' >/dev/null \
  && say "POST /v1/responses" PASS || { say "POST /v1/responses" FAIL; echo "$resp" | head -c 300; fail=1; }

exit $fail
```

- [ ] **Step 10: Rodar e corrigir até verde**

Run: `chmod +x deploy/compose/scripts/validate-gateway.sh && ./deploy/compose/scripts/validate-gateway.sh`
Expected: todas as linhas `PASS`, exit 0.

- [ ] **Step 11: Confirmar que o `validate-chain.sh` antigo (headroom) já não bate mais em nada exposto**

Run: `curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/readyz`
Expected: falha de conexão (`curl: (7) Failed to connect` ou similar) — confirma que o headroom não está mais na LAN/host, só o gateway. **Não** rodar mais `deploy/compose/scripts/validate-chain.sh` como critério de aceite a partir daqui; `validate-gateway.sh` é o substituto (mesmo papel que ele tinha, um nível acima).

- [ ] **Step 12: Commit**

```bash
cd /home/fkmatsuda/workspace/corehub.ia/ia-stack
git add packages/gateway/Dockerfile packages/gateway/.dockerignore \
  deploy/compose/docker-compose.yml deploy/compose/.env.example \
  deploy/compose/scripts/validate-gateway.sh
git commit -m "$(cat <<'EOF'
feat(f2): servico gateway no compose; headroom perde a porta host

Rede fixa (172.28.1.0/24) para GATEWAY_TRUSTED_CIDRS ser deterministico.
gateway e agora a unica porta LAN-facing da cadeia de inferencia (11434);
headroom so alcancavel via rede interna do compose. validate-gateway.sh
substitui validate-chain.sh como criterio de aceite (mesmos checks, um
hop acima).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Conectar as 3 ferramentas via `:11434`

**Files:**
- Modify: `opencode.json` (baseURL muda de `:8787` para `:11434`)
- Create: `docs/connecting-tools.md` (Claude Code + Copilot BYOK — instruções + JSON pronto pra colar)

**Interfaces:**
- Consumes: gateway rodando (Task 6), chaves `MANIFEST_KEY_*` (F1).
- Produces: `opencode.json` apontando pro gateway; documentação com o JSON exato do Copilot Custom Endpoint.

- [ ] **Step 1: Atualizar `opencode.json`**

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "iastack": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "ia-stack (gateway)",
      "options": {
        "baseURL": "http://127.0.0.1:11434/v1",
        "apiKey": "{env:MANIFEST_KEY_OPENCODE}"
      },
      "models": {
        "auto": {
          "name": "auto (roteado pelo manifest)",
          "limit": { "context": 200000, "output": 64000 }
        }
      }
    }
  }
}
```

- [ ] **Step 2: Teste headless do opencode via gateway**

```bash
cd /home/fkmatsuda/workspace/corehub.ia/ia-stack
set -a; source deploy/compose/.env; set +a
opencode run -m iastack/auto "Responda com uma unica palavra: gateway-ok"
```
Expected: resposta contendo "ok", exit 0.

- [ ] **Step 3: Teste headless do Claude Code via gateway**

```bash
cd /home/fkmatsuda/workspace/corehub.ia/ia-stack
set -a; source deploy/compose/.env; set +a
ANTHROPIC_BASE_URL=http://127.0.0.1:11434 ANTHROPIC_AUTH_TOKEN="$MANIFEST_KEY_CLAUDE_CODE" \
  claude -p "Responda com uma unica palavra: claude-gateway-ok"
```
Expected: resposta impressa, exit 0. Se falhar por causa de `anthropic-beta`/`context_management` sendo exigido e não suportado pelo manifest, capturar o erro exato e ajustar (ex.: `claude` pode precisar de `--no-...` ou a versão instalada pode mandar um header que o manifest rejeita — diagnosticar com `claude --debug` se necessário. Não é esperado dado que o manifest é o alvo real de produção do headroom para Claude Code, mas é o primeiro teste real desta sessão).

- [ ] **Step 4: Criar `docs/connecting-tools.md` com o Copilot BYOK pronto**

```markdown
# Conectando ferramentas ao ia-stack

Gateway em `:11434` (LAN). Cada ferramenta usa a chave do seu agente em
`deploy/compose/.env` (`MANIFEST_KEY_*`).

## opencode
Já configurado em `opencode.json` (raiz do repo) — provider `iastack`, modelo `iastack/auto`.

## Claude Code
Escopo por projeto via `.claude/settings.local.json` (auto-gitignorado, não commitar):
\`\`\`json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://<ip-da-maquina>:11434",
    "ANTHROPIC_AUTH_TOKEN": "<MANIFEST_KEY_CLAUDE_CODE do .env>"
  }
}
\`\`\`
Confirmar com `/status` dentro de uma sessão do Claude Code.

## GitHub Copilot Chat (VS Code) — BYOK Custom Endpoint
Estável desde a v1.122 (2026-05-28), funciona sem login GitHub.

1. Command Palette → **Chat: Manage Models...** → **Custom Endpoint** → **Add Model**.
2. O VS Code abre um `chatLanguageModels.json` para editar. Colar:
\`\`\`json
[
  {
    "name": "ia-stack (Copilot)",
    "vendor": "customendpoint",
    "apiKey": "<MANIFEST_KEY_COPILOT do .env>",
    "apiType": "chat-completions",
    "models": [
      {
        "id": "auto",
        "name": "ia-stack auto",
        "url": "http://<ip-da-maquina>:11434/v1/chat/completions",
        "toolCalling": true,
        "vision": false,
        "maxInputTokens": 128000,
        "maxOutputTokens": 16000
      }
    ]
  }
]
\`\`\`
3. Salvar, reabrir o seletor de modelo no Chat — "ia-stack auto" deve aparecer na lista.
```

- [ ] **Step 5 (MANUAL — usuário): Verificar o Copilot BYOK no VS Code**

Seguir os passos do `docs/connecting-tools.md` acima (a localização exata do `chatLanguageModels.json` só é revelada pela própria UI do VS Code ao clicar "Add Model" — não há um caminho de arquivo fixo documentado publicamente para escrever direto). Confirmar que uma pergunta simples no Chat com o modelo "ia-stack auto" responde e aparece com custo/agente `copilot` no dashboard do manifest.

- [ ] **Step 6: Commit**

```bash
cd /home/fkmatsuda/workspace/corehub.ia/ia-stack
git add opencode.json docs/connecting-tools.md
git commit -m "$(cat <<'EOF'
feat(f2): aponta opencode pro gateway; docs de conexao (Claude Code + Copilot BYOK)

opencode e Claude Code testados headless via :11434 nesta sessao. Copilot
BYOK Custom Endpoint (estavel desde VS Code 1.122, sem exigir login
GitHub) documentado com o JSON pronto -- checkpoint manual porque a
localizacao do chatLanguageModels.json so aparece via UI do VS Code.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: CI (extensão TypeScript) + README + push

**Files:**
- Modify: `.github/workflows/ci.yml` (novo job `gateway-checks`)
- Modify: `README.md` (status F2, quick start atualizado)

**Interfaces:**
- Produces: workflow `ci` com jobs `compose-validate`, `gateway-checks`, `gitleaks`.

- [ ] **Step 1: Adicionar o job `gateway-checks` ao `.github/workflows/ci.yml`**

Inserir como novo job (mesmo arquivo da F1), antes ou depois de `compose-validate`:

```yaml
  gateway-checks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: "1.3.14"
      - run: bun install --frozen-lockfile
      - run: bun run typecheck
      - run: bun run lint
      - run: bun test packages/gateway/test
```

- [ ] **Step 2: Atualizar `deploy/compose/docker-compose.yml` no job `compose-validate` (a rede/serviço novo precisa validar igual)**

Nenhuma mudança de comando necessária — `docker compose ... config -q` já cobre o serviço `gateway` novo automaticamente. Só confirmar que o job da F1 ainda passa:

Run: `docker run --rm -v "$PWD":/repo -w /repo python:3-alpine sh -c "pip install -q pyyaml && python -c \"import yaml; yaml.safe_load(open('.github/workflows/ci.yml')); print('yaml ok')\""`
Expected: `yaml ok`.

- [ ] **Step 3: Atualizar `README.md`**

Trocar a seção "Status" e "Quick start" para refletir a F2:

```markdown
**Status:** F2 — gateway v1 (passthrough OpenAI+Anthropic) up; opencode e Claude Code
conectados via `:11434`; Copilot BYOK Custom Endpoint documentado.

## Quick start (F2)

1. `cd deploy/compose && cp .env.example .env` — fill the three secrets (`openssl rand -hex 32`).
2. `docker compose up -d --build` (builds the gateway image; `local-models` profile
   runs a local Ollama container so no paid API key is required to try the stack).
3. Open `http://localhost:2099` — create the admin account, connect a provider
   (or `docker exec <ollama-container> ollama pull <model>` for the bundled tile),
   configure the default routing tier, create the agents (`opencode`, `claude-code`,
   `copilot`, `openwebui`, `lan-anon`) and put their `mnfst_` keys in `.env`.
4. `./scripts/validate-gateway.sh` — everything must PASS.
5. See `docs/connecting-tools.md` for opencode / Claude Code / Copilot BYOK setup.
```

- [ ] **Step 4: Rodar a suíte completa uma última vez**

Run:
```bash
cd /home/fkmatsuda/workspace/corehub.ia/ia-stack
bun run typecheck && bun run lint && bun test packages/gateway/test
./deploy/compose/scripts/validate-gateway.sh
```
Expected: tudo verde.

- [ ] **Step 5: Commit e push**

```bash
git add .github/workflows/ci.yml README.md
git commit -m "$(cat <<'EOF'
ci: job gateway-checks (typecheck+biome+bun test); docs: README da F2

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
git push origin main
```

- [ ] **Step 6: Verificar CI verde no GitHub**

Run: `git ls-remote --heads origin main`
Expected: hash de `main` listado. No site: aba Actions com `ci` verde (3 jobs: `compose-validate`, `gateway-checks`, `gitleaks`).

---

## Critério de aceite da F2 (do spec §9)

- [ ] `validate-gateway.sh` todo PASS (health agregado, auth LAN com/sem credencial, chat/completions, streaming, messages, responses)
- [ ] opencode conversando via `iastack/auto` apontando pro gateway (`:11434`)
- [ ] Claude Code conversando via `ANTHROPIC_BASE_URL=http://<host>:11434`
- [ ] Copilot (VS Code) BYOK Custom Endpoint conectado e respondendo (checkpoint manual, Task 7 Step 5)
- [ ] CI verde no GitHub (3 jobs)

---

## Addendum: correção de segurança pós-Task 8 (2026-07-03)

Uma revisão de segurança automática, rodada depois da F2 já pushada, encontrou dois achados em `deploy/compose/docker-compose.yml` e `packages/gateway/src/routes/openai.ts`. Investigados e corrigidos com um commit dedicado (não reabri as tasks acima).

**1. [HIGH] Bypass de auth via reescrita de IP de origem do `docker-proxy` — CONFIRMADO empiricamente.**

O `GATEWAY_TRUSTED_CIDRS` default (`172.28.1.0/24`, a subnet da rede do compose) partia da premissa de que só peers genuínos da mesma rede Docker apareceriam com um IP dessa faixa. Falso: o Docker roda `docker-proxy` (userland-proxy, **ligado por padrão**) pra cada porta publicada. Quando um processo no HOST (qualquer um — não só containers do projeto) conecta em `127.0.0.1:<porta-publicada>` ou na própria interface LAN do host, o `docker-proxy` faz hairpin dessa conexão pro container via uma NOVA conexão de saída, cujo IP de origem — do ponto de vista do container — vira o IP do gateway da bridge (`172.28.1.1` na nossa rede), **dentro** da CIDR "confiável".

Verificado ao vivo (endpoint de debug temporário, removido depois): `curl http://127.0.0.1:21434/...` → gateway via `server.requestIP()` enxergava `::ffff:172.28.1.1`. Ou seja: **qualquer processo no host — não só os containers do próprio stack — conseguia bater no gateway sem nenhuma credencial e receber a chave `GATEWAY_DEFAULT_KEY` injetada.**

Correção:
- `packages/gateway/src/cidr.ts`: nova função `normalizeIp()` que remove o prefixo `::ffff:` que o Bun retorna pra peers IPv4 (bug de parsing separado, mas preciso pra sequer avaliar CIDR/loopback corretamente).
- `packages/gateway/src/auth.ts`: usa `normalizeIp()` antes de checar `LOOPBACK_IPS`/`ipInAnyCidr`.
- `deploy/compose/docker-compose.yml` e `.env.example`: `GATEWAY_TRUSTED_CIDRS` **não** tem mais default pra subnet do compose — fica vazio (só loopback `127.0.0.1`/`::1` é confiável por padrão). Vira uma env explicitamente opt-in, com o risco documentado no comentário, pra quando (F3+) algo como o Open WebUI precisar de fato desse caminho.
- Testes novos: `normalizeIp` (cidr.test.ts) e um caso de auth.test.ts com IP `::ffff:...` explícito.

**Por que loopback continua confiável por padrão:** é o comportamento pedido no spec (§4.4 ponto 2) e, fora do container (`bun run` direto, o cenário usado pros smoke tests manuais desta sessão), `server.requestIP()` reporta `127.0.0.1` corretamente sem essa distorção — só dentro do Docker publicado é que loopback vira indistinguível da subnet da bridge, e por isso a subnet parou de ser um default seguro.

**2. [MEDIUM] Injeção de credencial via header controlado pelo cliente — investigado, não reproduzido no código atual, corrigido como *defense-in-depth*.**

A função `proxyHeaders` original fazia `{...c.req.header()}` (bulk) e só sobrescrevia `headers.authorization` quando havia injeção. Testei se um cliente poderia se aproveitar de alguma inconsistência entre o lookup singular (`c.req.header("authorization")`, usado pelo middleware de auth pra decidir `hasCredential`) e o bulk (usado pra montar os headers de saída) — ex. um client mandando `Authorization` (maiúsculo) escapando da checagem. Empiricamente, o Hono normaliza chaves de header pra minúsculas em ambos os casos (`bun run` de um script de teste dedicado confirmou), então esse caminho específico não é explorável hoje.

Ainda assim, a sugestão do review — parar de depender implicitamente desse comportamento do framework e ser explícito — é uma melhoria real de robustez e auditabilidade, de graça:
- Novo módulo compartilhado `packages/gateway/src/proxy-headers.ts` (antes, `proxyHeaders` estava duplicada em `openai.ts` e `anthropic.ts` com pequenas divergências entre si — mais um motivo pra unificar).
- Remove explicitamente `host`, `authorization` e `x-api-key` do objeto copiado antes de decidir o que mandar; nunca deixa os dois convivendo.
- Teste dedicado `proxy-headers.test.ts` (4 casos: client-owned `authorization`, client-owned `x-api-key`, chave injetada sempre vence, `host` nunca vaza).

Suíte completa após as correções: **32 testes passando** (eram 25 no fim da Task 8). `validate-gateway.sh` revalidado 100% PASS contra a cadeia real, incluindo a checagem explícita de que `curl` sem credencial via `127.0.0.1:<porta-publicada>` agora dá 401 pelo motivo certo (não mais um acidente de parsing).
