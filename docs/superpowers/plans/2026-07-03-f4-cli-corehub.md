# F4 — CLI `corehub` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a `corehub` CLI (Bun/TypeScript, `packages/cli`) that brings a fresh machine from clone to a green chain in ≤3 commands — `up`/`down`/`status`/`doctor`/`init` plus `skills sync`.

**Architecture:** New Bun-workspace package `packages/cli`, mirroring `packages/gateway` conventions (composite tsconfig, Biome, `bun test`, no runtime deps). A thin `index.ts` dispatches parsed argv to one handler per command. Each handler is a thin IO wrapper over a **pure core** (arg parse, repo-root resolution, compose-argv building, `.env` rendering, doctor summarize, skills-sync planner) so the logic is unit-tested without a live stack. `up/down/status` shell out to `docker compose`; `init` generates secrets into `.env`; `doctor` probes the running chain; `skills sync` symlinks per-skill into `~/.claude/skills` and `~/.agents/skills` while tracking a managed manifest so it never touches the user's pre-existing skills.

**Tech Stack:** Bun 1.3.14, TypeScript 6.0.3 (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `moduleResolution: bundler`), Hono not needed here, Biome 2.5.2, `node:crypto`, `node:fs`, `Bun.spawn`, `docker compose`.

## Global Constraints

- **Bun workspace member** under `packages/*`; `packages/cli/tsconfig.json` extends `../../tsconfig.json` and is `composite: true` with `types: ["bun-types"]`. Root `tsconfig.json` MUST gain a `{ "path": "packages/cli" }` reference so `tsc --build` compiles it.
- **No new runtime dependencies.** Hand-roll arg parsing, ANSI, and IO with Bun/Node built-ins only. Dev dep: `bun-types@1.3.14` (same pin as gateway).
- **Import style:** ESM with explicit `.js` extensions on relative imports (matches gateway, e.g. `import { parseArgs } from "./cli.js"`).
- **Biome:** 2-space indent, `lineWidth: 100`, `preset: "recommended"`, `organizeImports: on`. All CLI code must pass `bun run lint`.
- **Tests:** `bun test packages/cli/test`. CI must run this in the `gateway-checks` job (or a sibling) alongside the existing gateway tests.
- **Secrets discipline:** `init` generates only the four infra secrets (`BETTER_AUTH_SECRET`, `MANIFEST_ENCRYPTION_KEY`, `POSTGRES_PASSWORD`, `WEBUI_SECRET_KEY`) via `randomBytes(32).toString("hex")` (== `openssl rand -hex 32`). It NEVER fabricates `MANIFEST_KEY_*` agent keys (those come from the dashboard) and NEVER overwrites an existing `.env` without `--force`. No secret is ever printed or committed.
- **Repo-root resolution:** locate the repo by walking up from `COREHUB_ROOT` (if set) → `process.cwd()` → `import.meta.dir`, looking for the marker `deploy/compose/docker-compose.yml`. Never hard-code an absolute path.
- **Skills safety (spec §6):** symlink **per skill**, never the whole dir. Track managed links in `<base>/.corehub-managed.json`. A target that exists but is NOT in our manifest is **foreign** — skip it with a warning, never clobber. The machine already has ~55 real skills in `~/.claude/skills` and ~49 in `~/.agents/skills`; the sync must leave every one untouched.
- **Binary name:** `corehub`. Commit footer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

## File Structure

```
packages/cli/
├── package.json              # @ia-stack/cli; bin corehub; scripts start/test/build
├── tsconfig.json             # composite, extends root, bun-types
├── src/
│   ├── index.ts              # #!/usr/bin/env bun — parse argv, dispatch to handler
│   ├── cli.ts                # parseArgs (pure)
│   ├── paths.ts              # findRepoRoot (pure) + resolvePaths (IO)
│   ├── ui.ts                 # printHelp, notImplemented, say/PASS-FAIL helpers, ANSI
│   ├── compose.ts            # composeBaseArgs/upArgs/downArgs/psArgs (pure) + runCompose (IO)
│   ├── env.ts                # generateSecret, renderInitialEnv, parseEnvFile (pure) + IO
│   ├── doctor.ts             # CheckResult, summarize (pure) + probes (IO)
│   ├── skills.ts             # SkillAction, planSkillsSync (pure) + apply (IO)
│   └── commands/
│       ├── stack.ts          # cmdUp / cmdDown / cmdStatus
│       ├── init.ts           # cmdInit
│       ├── doctor.ts         # cmdDoctor
│       └── skills.ts         # cmdSkills
└── test/
    ├── cli.test.ts
    ├── paths.test.ts
    ├── compose.test.ts
    ├── env.test.ts
    ├── doctor.test.ts
    └── skills.test.ts
```

---

### Task 1: Package scaffold, arg parser, repo-root resolution, dispatch skeleton

**Files:**
- Create: `packages/cli/package.json`, `packages/cli/tsconfig.json`
- Modify: `tsconfig.json` (root — add reference)
- Create: `packages/cli/src/cli.ts`, `packages/cli/src/paths.ts`, `packages/cli/src/ui.ts`, `packages/cli/src/index.ts`
- Create stubs: `packages/cli/src/commands/stack.ts`, `packages/cli/src/commands/init.ts`, `packages/cli/src/commands/doctor.ts`, `packages/cli/src/commands/skills.ts`
- Test: `packages/cli/test/cli.test.ts`, `packages/cli/test/paths.test.ts`

**Interfaces:**
- Produces: `parseArgs(argv: string[]): ParsedArgs` where `ParsedArgs = { command: string | null; sub: string | null; positionals: string[]; flags: Record<string, string | boolean> }`.
- Produces: `findRepoRoot(startDirs: string[], exists?: (p: string) => boolean): string | null`.
- Produces: `resolvePaths(env?: Record<string,string|undefined>): RepoPaths` where `RepoPaths = { root: string; composeFile: string; envFile: string; envExample: string; skillsDir: string }`.
- Produces: `printHelp(): void`, `notImplemented(name: string): number`, `CmdHandler = (args: ParsedArgs) => Promise<number>`.

- [ ] **Step 1: Write `packages/cli/package.json`**

```json
{
  "name": "@ia-stack/cli",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": { "corehub": "./src/index.ts" },
  "scripts": {
    "start": "bun run src/index.ts",
    "test": "bun test",
    "build": "bun build --compile src/index.ts --outfile ../../corehub"
  },
  "devDependencies": {
    "bun-types": "1.3.14"
  }
}
```

- [ ] **Step 2: Write `packages/cli/tsconfig.json`**

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

- [ ] **Step 3: Add the CLI project reference to root `tsconfig.json`**

Replace the `references` array so it reads:

```json
  "files": [],
  "references": [{ "path": "packages/gateway" }, { "path": "packages/cli" }]
```

- [ ] **Step 4: Write `packages/cli/src/cli.ts` (pure arg parser)**

```ts
export type ParsedArgs = {
  command: string | null;
  sub: string | null;
  positionals: string[];
  flags: Record<string, string | boolean>;
};

// Minimal parser: `corehub <command> [sub] [--flag [value]] ...`.
// A `--flag` followed by a non-flag token consumes it as the value;
// otherwise the flag is a boolean `true`. Positionals keep their order.
export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(arg);
    }
  }
  return {
    command: positionals[0] ?? null,
    sub: positionals[1] ?? null,
    positionals: positionals.slice(1),
    flags,
  };
}
```

- [ ] **Step 5: Write `packages/cli/src/paths.ts` (repo-root resolution)**

```ts
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const MARKER = join("deploy", "compose", "docker-compose.yml");

export type RepoPaths = {
  root: string;
  composeFile: string;
  envFile: string;
  envExample: string;
  skillsDir: string;
};

// Walk up from each start dir until MARKER is found. Pure given `exists`.
export function findRepoRoot(
  startDirs: string[],
  exists: (p: string) => boolean = existsSync,
): string | null {
  for (const start of startDirs) {
    let dir = resolve(start);
    while (true) {
      if (exists(join(dir, MARKER))) return dir;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

export function resolvePaths(env: Record<string, string | undefined> = process.env): RepoPaths {
  const candidates = [
    ...(env.COREHUB_ROOT ? [env.COREHUB_ROOT] : []),
    process.cwd(),
    import.meta.dir,
  ];
  const root = findRepoRoot(candidates);
  if (!root) {
    throw new Error(
      "não encontrei a raiz do ia-stack (marcador deploy/compose/docker-compose.yml). " +
        "Rode de dentro do repositório ou defina COREHUB_ROOT.",
    );
  }
  return {
    root,
    composeFile: join(root, "deploy", "compose", "docker-compose.yml"),
    envFile: join(root, "deploy", "compose", ".env"),
    envExample: join(root, "deploy", "compose", ".env.example"),
    skillsDir: join(root, "skills"),
  };
}
```

- [ ] **Step 6: Write `packages/cli/src/ui.ts` (help + print helpers)**

```ts
import type { ParsedArgs } from "./cli.js";

export type CmdHandler = (args: ParsedArgs) => Promise<number>;

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

export function say(label: string, status: "PASS" | "FAIL", detail = ""): void {
  const color = status === "PASS" ? GREEN : RED;
  const tail = detail ? ` ${DIM}${detail}${RESET}` : "";
  console.log(`${label.padEnd(48)} ${color}${status}${RESET}${tail}`);
}

export function notImplemented(name: string): number {
  console.error(`'${name}' ainda não implementado`);
  return 1;
}

export function printHelp(): void {
  console.log(`corehub — orquestra o ia-stack

uso: corehub <comando> [opções]

comandos:
  init                 gera deploy/compose/.env com segredos novos (não sobrescreve; use --force)
  up [--profile ui]    sobe o stack (docker compose up -d --build); use --no-build p/ pular o build
  down [--volumes]     derruba o stack (--volumes remove os volumes nomeados)
  status               docker compose ps dos serviços
  doctor               smoke-test da cadeia (health dos 3 hops + request ponta-a-ponta)
  skills sync          symlink das skills do repo em ~/.claude/skills e ~/.agents/skills

globais:
  --help               esta ajuda
  COREHUB_ROOT=<dir>   força a raiz do repositório (se não rodar de dentro dele)`);
}
```

- [ ] **Step 7: Write the four command stubs**

`packages/cli/src/commands/stack.ts`:

```ts
import type { ParsedArgs } from "../cli.js";
import { notImplemented } from "../ui.js";

export async function cmdUp(_args: ParsedArgs): Promise<number> {
  return notImplemented("up");
}

export async function cmdDown(_args: ParsedArgs): Promise<number> {
  return notImplemented("down");
}

export async function cmdStatus(_args: ParsedArgs): Promise<number> {
  return notImplemented("status");
}
```

`packages/cli/src/commands/init.ts`:

```ts
import type { ParsedArgs } from "../cli.js";
import { notImplemented } from "../ui.js";

export async function cmdInit(_args: ParsedArgs): Promise<number> {
  return notImplemented("init");
}
```

`packages/cli/src/commands/doctor.ts`:

```ts
import type { ParsedArgs } from "../cli.js";
import { notImplemented } from "../ui.js";

export async function cmdDoctor(_args: ParsedArgs): Promise<number> {
  return notImplemented("doctor");
}
```

`packages/cli/src/commands/skills.ts`:

```ts
import type { ParsedArgs } from "../cli.js";
import { notImplemented } from "../ui.js";

export async function cmdSkills(_args: ParsedArgs): Promise<number> {
  return notImplemented("skills");
}
```

- [ ] **Step 8: Write `packages/cli/src/index.ts` (dispatch)**

```ts
#!/usr/bin/env bun
import { parseArgs } from "./cli.js";
import { cmdDoctor } from "./commands/doctor.js";
import { cmdInit } from "./commands/init.js";
import { cmdSkills } from "./commands/skills.js";
import { cmdDown, cmdStatus, cmdUp } from "./commands/stack.js";
import { type CmdHandler, printHelp } from "./ui.js";

const handlers: Record<string, CmdHandler> = {
  up: cmdUp,
  down: cmdDown,
  status: cmdStatus,
  init: cmdInit,
  doctor: cmdDoctor,
  skills: cmdSkills,
};

const args = parseArgs(process.argv.slice(2));

if (!args.command || args.command === "help" || args.flags.help === true) {
  printHelp();
  process.exit(args.command && args.command !== "help" ? 1 : 0);
}

const handler = handlers[args.command];
if (!handler) {
  console.error(`comando desconhecido: ${args.command}\n`);
  printHelp();
  process.exit(1);
}

handler(args)
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
```

- [ ] **Step 9: Write `packages/cli/test/cli.test.ts`**

```ts
import { describe, expect, test } from "bun:test";
import { parseArgs } from "../src/cli.js";

describe("parseArgs", () => {
  test("command only", () => {
    const a = parseArgs(["up"]);
    expect(a.command).toBe("up");
    expect(a.sub).toBeNull();
    expect(a.flags).toEqual({});
  });

  test("command + sub", () => {
    const a = parseArgs(["skills", "sync"]);
    expect(a.command).toBe("skills");
    expect(a.sub).toBe("sync");
  });

  test("flag with value", () => {
    const a = parseArgs(["up", "--profile", "ui"]);
    expect(a.command).toBe("up");
    expect(a.flags.profile).toBe("ui");
  });

  test("boolean flag", () => {
    const a = parseArgs(["up", "--no-build"]);
    expect(a.flags["no-build"]).toBe(true);
  });

  test("boolean flag before another flag", () => {
    const a = parseArgs(["down", "--volumes", "--force"]);
    expect(a.flags.volumes).toBe(true);
    expect(a.flags.force).toBe(true);
  });

  test("empty argv", () => {
    const a = parseArgs([]);
    expect(a.command).toBeNull();
  });
});
```

- [ ] **Step 10: Write `packages/cli/test/paths.test.ts`**

```ts
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { findRepoRoot } from "../src/paths.js";

describe("findRepoRoot", () => {
  const marker = join("deploy", "compose", "docker-compose.yml");

  test("finds root by walking up from a nested dir", () => {
    const root = "/home/x/ia-stack";
    const exists = (p: string) => p === join(root, marker);
    expect(findRepoRoot(["/home/x/ia-stack/packages/cli/src"], exists)).toBe(root);
  });

  test("finds root when start IS the root", () => {
    const root = "/repo";
    const exists = (p: string) => p === join(root, marker);
    expect(findRepoRoot(["/repo"], exists)).toBe(root);
  });

  test("returns null when marker never appears", () => {
    expect(findRepoRoot(["/home/x/nothing"], () => false)).toBeNull();
  });

  test("tries later start dirs when earlier ones miss", () => {
    const root = "/srv/ia-stack";
    const exists = (p: string) => p === join(root, marker);
    expect(findRepoRoot(["/tmp/elsewhere", "/srv/ia-stack/packages/cli"], exists)).toBe(root);
  });
});
```

- [ ] **Step 11: Install and verify (typecheck + lint + tests)**

Run: `bun install`
Run: `bun run typecheck`
Expected: no errors (root `tsc --build` now compiles `packages/cli`).
Run: `bun run lint`
Expected: no diagnostics.
Run: `bun test packages/cli/test`
Expected: PASS (10 tests in cli.test + 4 in paths.test).

- [ ] **Step 12: Verify the CLI runs**

Run: `bun run packages/cli/src/index.ts --help`
Expected: prints the help block.
Run: `bun run packages/cli/src/index.ts up`
Expected: prints `'up' ainda não implementado` and exits 1.

- [ ] **Step 13: Commit**

```bash
git add packages/cli tsconfig.json bun.lock
git commit -m "feat(f4): scaffold do CLI corehub (parser + repo-root + dispatch)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `up` / `down` / `status` over docker compose

**Files:**
- Create: `packages/cli/src/compose.ts`
- Modify: `packages/cli/src/commands/stack.ts`
- Test: `packages/cli/test/compose.test.ts`

**Interfaces:**
- Consumes: `resolvePaths()` → `RepoPaths` (Task 1).
- Produces: `composeBaseArgs(p: { composeFile: string; envFile: string }): string[]`.
- Produces: `composeUpArgs(p, opts: { profiles: string[]; build: boolean; detach: boolean }): string[]`.
- Produces: `composeDownArgs(p, opts: { volumes: boolean }): string[]`.
- Produces: `composePsArgs(p): string[]`.
- Produces: `runCompose(args: string[]): Promise<number>` — spawns `docker` inheriting stdio.
- Produces: `splitProfiles(flag: string | boolean | undefined): string[]`.

- [ ] **Step 1: Write the failing test `packages/cli/test/compose.test.ts`**

```ts
import { describe, expect, test } from "bun:test";
import {
  composeBaseArgs,
  composeDownArgs,
  composePsArgs,
  composeUpArgs,
  splitProfiles,
} from "../src/compose.js";

const p = { composeFile: "/repo/deploy/compose/docker-compose.yml", envFile: "/repo/deploy/compose/.env" };

describe("compose argv", () => {
  test("base args carry -f and --env-file", () => {
    expect(composeBaseArgs(p)).toEqual([
      "compose",
      "-f",
      "/repo/deploy/compose/docker-compose.yml",
      "--env-file",
      "/repo/deploy/compose/.env",
    ]);
  });

  test("up: detach + build, no extra profiles", () => {
    const a = composeUpArgs(p, { profiles: [], build: true, detach: true });
    expect(a.slice(-3)).toEqual(["up", "-d", "--build"]);
    expect(a).not.toContain("--profile");
  });

  test("up: injects each profile before the 'up' verb", () => {
    const a = composeUpArgs(p, { profiles: ["ui"], build: false, detach: true });
    expect(a).toContain("--profile");
    expect(a[a.indexOf("--profile") + 1]).toBe("ui");
    expect(a.indexOf("--profile")).toBeLessThan(a.indexOf("up"));
    expect(a).not.toContain("--build");
    expect(a).toContain("-d");
  });

  test("down: --volumes only when asked", () => {
    expect(composeDownArgs(p, { volumes: false }).slice(-1)).toEqual(["down"]);
    expect(composeDownArgs(p, { volumes: true }).slice(-2)).toEqual(["down", "--volumes"]);
  });

  test("ps args", () => {
    expect(composePsArgs(p).slice(-1)).toEqual(["ps"]);
  });

  test("splitProfiles handles undefined, single, and comma list", () => {
    expect(splitProfiles(undefined)).toEqual([]);
    expect(splitProfiles(true)).toEqual([]);
    expect(splitProfiles("ui")).toEqual(["ui"]);
    expect(splitProfiles("ui,extra")).toEqual(["ui", "extra"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/cli/test/compose.test.ts`
Expected: FAIL — cannot find module `../src/compose.js`.

- [ ] **Step 3: Write `packages/cli/src/compose.ts`**

```ts
type ComposePaths = { composeFile: string; envFile: string };

export function composeBaseArgs(p: ComposePaths): string[] {
  return ["compose", "-f", p.composeFile, "--env-file", p.envFile];
}

export function splitProfiles(flag: string | boolean | undefined): string[] {
  if (typeof flag !== "string") return [];
  return flag
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function composeUpArgs(
  p: ComposePaths,
  opts: { profiles: string[]; build: boolean; detach: boolean },
): string[] {
  const args = composeBaseArgs(p);
  for (const profile of opts.profiles) args.push("--profile", profile);
  args.push("up");
  if (opts.detach) args.push("-d");
  if (opts.build) args.push("--build");
  return args;
}

export function composeDownArgs(p: ComposePaths, opts: { volumes: boolean }): string[] {
  const args = composeBaseArgs(p);
  args.push("down");
  if (opts.volumes) args.push("--volumes");
  return args;
}

export function composePsArgs(p: ComposePaths): string[] {
  const args = composeBaseArgs(p);
  args.push("ps");
  return args;
}

export async function runCompose(args: string[]): Promise<number> {
  const proc = Bun.spawn(["docker", ...args], {
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });
  return await proc.exited;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/cli/test/compose.test.ts`
Expected: PASS.

- [ ] **Step 5: Fill in `packages/cli/src/commands/stack.ts`**

```ts
import type { ParsedArgs } from "../cli.js";
import {
  composeDownArgs,
  composePsArgs,
  composeUpArgs,
  runCompose,
  splitProfiles,
} from "../compose.js";
import { resolvePaths } from "../paths.js";

export async function cmdUp(args: ParsedArgs): Promise<number> {
  const paths = resolvePaths();
  const composeArgs = composeUpArgs(paths, {
    profiles: splitProfiles(args.flags.profile),
    build: args.flags["no-build"] !== true,
    detach: true,
  });
  return await runCompose(composeArgs);
}

export async function cmdDown(args: ParsedArgs): Promise<number> {
  const paths = resolvePaths();
  return await runCompose(composeDownArgs(paths, { volumes: args.flags.volumes === true }));
}

export async function cmdStatus(_args: ParsedArgs): Promise<number> {
  const paths = resolvePaths();
  return await runCompose(composePsArgs(paths));
}
```

- [ ] **Step 6: Manually verify against the running stack**

Run: `bun run packages/cli/src/index.ts status`
Expected: prints the `docker compose ps` table for the ia-stack services (they are already up from F3).

- [ ] **Step 7: Full verification**

Run: `bun run typecheck && bun run lint && bun test packages/cli/test`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/compose.ts packages/cli/src/commands/stack.ts packages/cli/test/compose.test.ts
git commit -m "feat(f4): corehub up/down/status (wrapper docker compose)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: `init` — generate `.env` with fresh secrets

**Files:**
- Create: `packages/cli/src/env.ts`
- Modify: `packages/cli/src/commands/init.ts`
- Test: `packages/cli/test/env.test.ts`

**Interfaces:**
- Consumes: `resolvePaths()` → `RepoPaths` (Task 1).
- Produces: `SECRET_KEYS: readonly string[]` — the four infra secrets.
- Produces: `generateSecret(): string` (64 hex chars).
- Produces: `renderInitialEnv(exampleText: string, generate?: () => string): string` — fills empty secret assignments, leaves everything else verbatim.
- Produces: `parseEnvFile(text: string): Record<string, string>` (reused by doctor in Task 4).

- [ ] **Step 1: Write the failing test `packages/cli/test/env.test.ts`**

```ts
import { describe, expect, test } from "bun:test";
import { generateSecret, parseEnvFile, renderInitialEnv, SECRET_KEYS } from "../src/env.js";

const EXAMPLE = `# comentário
BETTER_AUTH_SECRET=
MANIFEST_ENCRYPTION_KEY=
POSTGRES_PASSWORD=
MANIFEST_PUBLIC_URL=http://localhost:2099
COMPOSE_PROFILES=local-models
WEBUI_SECRET_KEY=
MANIFEST_KEY_OPENCODE=
`;

describe("renderInitialEnv", () => {
  test("fills every empty secret with a generated value", () => {
    let n = 0;
    const out = renderInitialEnv(EXAMPLE, () => `secret${n++}`);
    const env = parseEnvFile(out);
    for (const key of SECRET_KEYS) {
      expect(env[key]).toMatch(/^secret\d$/);
    }
  });

  test("leaves non-secret and pre-filled lines verbatim", () => {
    const out = renderInitialEnv(EXAMPLE, () => "x");
    const env = parseEnvFile(out);
    expect(env.MANIFEST_PUBLIC_URL).toBe("http://localhost:2099");
    expect(env.COMPOSE_PROFILES).toBe("local-models");
  });

  test("never fabricates agent keys", () => {
    const out = renderInitialEnv(EXAMPLE, () => "x");
    const env = parseEnvFile(out);
    expect(env.MANIFEST_KEY_OPENCODE).toBe("");
  });

  test("preserves comments", () => {
    const out = renderInitialEnv(EXAMPLE, () => "x");
    expect(out).toContain("# comentário");
  });
});

describe("generateSecret", () => {
  test("returns 64 hex chars", () => {
    expect(generateSecret()).toMatch(/^[0-9a-f]{64}$/);
  });

  test("is not constant", () => {
    expect(generateSecret()).not.toBe(generateSecret());
  });
});

describe("parseEnvFile", () => {
  test("ignores comments and blanks, keeps KEY=VALUE", () => {
    const env = parseEnvFile("# c\n\nA=1\nB=two words\n");
    expect(env).toEqual({ A: "1", B: "two words" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/cli/test/env.test.ts`
Expected: FAIL — cannot find module `../src/env.js`.

- [ ] **Step 3: Write `packages/cli/src/env.ts`**

```ts
import { randomBytes } from "node:crypto";

export const SECRET_KEYS = [
  "BETTER_AUTH_SECRET",
  "MANIFEST_ENCRYPTION_KEY",
  "POSTGRES_PASSWORD",
  "WEBUI_SECRET_KEY",
] as const;

const SECRET_SET: ReadonlySet<string> = new Set(SECRET_KEYS);

export function generateSecret(): string {
  return randomBytes(32).toString("hex");
}

// Fill each empty secret assignment (KEY=) with a generated value. Every other
// line — comments, blanks, pre-filled and non-secret keys — is left verbatim.
export function renderInitialEnv(
  exampleText: string,
  generate: () => string = generateSecret,
): string {
  return exampleText
    .split("\n")
    .map((line) => {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
      if (!match) return line;
      const key = match[1] ?? "";
      const value = match[2] ?? "";
      if (SECRET_SET.has(key) && value === "") return `${key}=${generate()}`;
      return line;
    })
    .join("\n");
}

export function parseEnvFile(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(trimmed);
    if (!match) continue;
    env[match[1] ?? ""] = match[2] ?? "";
  }
  return env;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/cli/test/env.test.ts`
Expected: PASS.

- [ ] **Step 5: Fill in `packages/cli/src/commands/init.ts`**

```ts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { ParsedArgs } from "../cli.js";
import { renderInitialEnv } from "../env.js";
import { resolvePaths } from "../paths.js";

export async function cmdInit(args: ParsedArgs): Promise<number> {
  const paths = resolvePaths();

  if (existsSync(paths.envFile) && args.flags.force !== true) {
    console.error(
      `${paths.envFile} já existe — não vou sobrescrever segredos.\n` +
        "Use 'corehub init --force' para regenerar (isso apaga as chaves atuais).",
    );
    return 1;
  }

  if (!existsSync(paths.envExample)) {
    console.error(`modelo ausente: ${paths.envExample}`);
    return 1;
  }

  const rendered = renderInitialEnv(readFileSync(paths.envExample, "utf8"));
  writeFileSync(paths.envFile, rendered, { mode: 0o600 });

  console.log(`✓ ${paths.envFile} criado com segredos novos (BETTER_AUTH_SECRET, `);
  console.log("  MANIFEST_ENCRYPTION_KEY, POSTGRES_PASSWORD, WEBUI_SECRET_KEY).\n");
  console.log("próximos passos:");
  console.log("  1. corehub up                       # sobe o stack");
  console.log("  2. abra http://localhost:2099       # crie o admin do manifest");
  console.log("     conecte um provider, defina o tier default e crie os agentes");
  console.log("     (opencode, claude-code, copilot, openwebui, lan-anon).");
  console.log("  3. cole as chaves mnfst_ nos MANIFEST_KEY_* do .env e rode 'corehub up' de novo");
  console.log("  4. corehub doctor                   # valida a cadeia ponta-a-ponta");
  return 0;
}
```

- [ ] **Step 6: Manually verify (without clobbering the real `.env`)**

Run: `COREHUB_ROOT=/tmp/corehub-init-test bash -c 'mkdir -p /tmp/corehub-init-test/deploy/compose && cp deploy/compose/.env.example /tmp/corehub-init-test/deploy/compose/ && cp deploy/compose/docker-compose.yml /tmp/corehub-init-test/deploy/compose/ && cd /tmp/corehub-init-test && bun run '"$PWD"'/packages/cli/src/index.ts init'`
Expected: prints the ✓ + next-steps block; creates `/tmp/corehub-init-test/deploy/compose/.env`.
Run: `grep -c '^BETTER_AUTH_SECRET=[0-9a-f]\{64\}$' /tmp/corehub-init-test/deploy/compose/.env`
Expected: `1`.
Run: `grep '^MANIFEST_KEY_OPENCODE=' /tmp/corehub-init-test/deploy/compose/.env`
Expected: `MANIFEST_KEY_OPENCODE=` (empty — not fabricated).
Run: `rm -rf /tmp/corehub-init-test`
Expected: cleanup, no trace.

- [ ] **Step 7: Confirm the real `.env` is untouched**

Run: `git status --short deploy/compose/.env`
Expected: no output (`.env` is gitignored and was never written by the test).

- [ ] **Step 8: Full verification**

Run: `bun run typecheck && bun run lint && bun test packages/cli/test`
Expected: all green.

- [ ] **Step 9: Commit**

```bash
git add packages/cli/src/env.ts packages/cli/src/commands/init.ts packages/cli/test/env.test.ts
git commit -m "feat(f4): corehub init (gera .env com segredos; nunca sobrescreve nem inventa chave de agente)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: `doctor` — smoke-test the whole chain

**Files:**
- Create: `packages/cli/src/doctor.ts`
- Modify: `packages/cli/src/commands/doctor.ts`
- Test: `packages/cli/test/doctor.test.ts`

**Interfaces:**
- Consumes: `resolvePaths()` (Task 1); `parseEnvFile` (Task 3).
- Produces: `CheckResult = { name: string; ok: boolean; detail: string }`.
- Produces: `summarize(results: CheckResult[]): { ok: boolean; failed: number }`.
- Produces: `checkEnvSecrets(env: Record<string,string>): CheckResult` — fails if any of `SECRET_KEYS` is empty.
- Produces async probes: `probeHealth(base: string): Promise<CheckResult>`, `probeChat(base: string, key: string): Promise<CheckResult>`.

- [ ] **Step 1: Write the failing test `packages/cli/test/doctor.test.ts`**

```ts
import { describe, expect, test } from "bun:test";
import { checkEnvSecrets, summarize } from "../src/doctor.js";

describe("summarize", () => {
  test("ok when every check passes", () => {
    const s = summarize([
      { name: "a", ok: true, detail: "" },
      { name: "b", ok: true, detail: "" },
    ]);
    expect(s).toEqual({ ok: true, failed: 0 });
  });

  test("counts failures", () => {
    const s = summarize([
      { name: "a", ok: true, detail: "" },
      { name: "b", ok: false, detail: "boom" },
      { name: "c", ok: false, detail: "boom" },
    ]);
    expect(s).toEqual({ ok: false, failed: 2 });
  });
});

describe("checkEnvSecrets", () => {
  test("passes when all four infra secrets are set", () => {
    const r = checkEnvSecrets({
      BETTER_AUTH_SECRET: "x",
      MANIFEST_ENCRYPTION_KEY: "x",
      POSTGRES_PASSWORD: "x",
      WEBUI_SECRET_KEY: "x",
    });
    expect(r.ok).toBe(true);
  });

  test("fails and names the missing secret", () => {
    const r = checkEnvSecrets({
      BETTER_AUTH_SECRET: "x",
      MANIFEST_ENCRYPTION_KEY: "",
      POSTGRES_PASSWORD: "x",
      WEBUI_SECRET_KEY: "x",
    });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("MANIFEST_ENCRYPTION_KEY");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/cli/test/doctor.test.ts`
Expected: FAIL — cannot find module `../src/doctor.js`.

- [ ] **Step 3: Write `packages/cli/src/doctor.ts`**

```ts
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
    return { name, ok: false, detail: "sem MANIFEST_KEY_OPENCODE no .env (crie os agentes no dashboard)" };
  }
  try {
    const res = await fetchWithTimeout(
      `${base}/v1/chat/completions`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: "auto",
          max_tokens: 16,
          messages: [{ role: "user", content: "corehub-doctor-ping" }],
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/cli/test/doctor.test.ts`
Expected: PASS.

- [ ] **Step 5: Fill in `packages/cli/src/commands/doctor.ts`**

```ts
import { existsSync, readFileSync } from "node:fs";
import type { ParsedArgs } from "../cli.js";
import {
  type CheckResult,
  checkEnvSecrets,
  probeChat,
  probeHealth,
  summarize,
} from "../doctor.js";
import { parseEnvFile } from "../env.js";
import { resolvePaths } from "../paths.js";
import { say } from "../ui.js";

export async function cmdDoctor(_args: ParsedArgs): Promise<number> {
  const paths = resolvePaths();

  if (!existsSync(paths.envFile)) {
    console.error(`${paths.envFile} não existe — rode 'corehub init' primeiro.`);
    return 1;
  }
  const env = parseEnvFile(readFileSync(paths.envFile, "utf8"));
  const port = env.GATEWAY_HOST_PORT ?? "11434";
  const base = `http://127.0.0.1:${port}`;

  const results: CheckResult[] = [];
  results.push(checkEnvSecrets(env));
  results.push(await probeHealth(base));
  results.push(await probeChat(base, env.MANIFEST_KEY_OPENCODE ?? ""));

  for (const r of results) say(r.name, r.ok ? "PASS" : "FAIL", r.detail);

  const { ok, failed } = summarize(results);
  console.log(ok ? "\ncorehub doctor: tudo verde ✓" : `\ncorehub doctor: ${failed} falha(s) ✗`);
  return ok ? 0 : 1;
}
```

- [ ] **Step 6: Manually verify against the running chain**

Run: `bun run packages/cli/src/index.ts doctor`
Expected: three PASS lines (`.env` secrets, gateway /health, e2e chat) and `corehub doctor: tudo verde ✓`, exit 0.

- [ ] **Step 7: Full verification**

Run: `bun run typecheck && bun run lint && bun test packages/cli/test`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/doctor.ts packages/cli/src/commands/doctor.ts packages/cli/test/doctor.test.ts
git commit -m "feat(f4): corehub doctor (health dos 3 hops + request ponta-a-ponta)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: `skills sync` — per-skill symlinks, foreign-safe

**Files:**
- Create: `packages/cli/src/skills.ts`
- Modify: `packages/cli/src/commands/skills.ts`
- Test: `packages/cli/test/skills.test.ts`

**Interfaces:**
- Consumes: `resolvePaths()` → `skillsDir` (Task 1).
- Produces: `EntryStatus = "absent" | "ours" | "foreign"`.
- Produces: `SkillAction = { name: string; kind: "create" | "ok" | "skip-foreign" | "prune" }`.
- Produces: `planSkillsSync(desired: string[], managed: string[], status: (name: string) => EntryStatus): SkillAction[]` (pure).
- Produces: `discoverSkills(skillsDir: string): string[]` — dirs containing `SKILL.md`.
- Produces: `syncTarget(baseDir: string, skillsDir: string, desired: string[]): SkillAction[]` (IO apply).

- [ ] **Step 1: Write the failing test `packages/cli/test/skills.test.ts`**

```ts
import { describe, expect, test } from "bun:test";
import { planSkillsSync } from "../src/skills.js";

describe("planSkillsSync", () => {
  test("creates absent desired links", () => {
    const actions = planSkillsSync(["a", "b"], [], () => "absent");
    expect(actions).toEqual([
      { name: "a", kind: "create" },
      { name: "b", kind: "create" },
    ]);
  });

  test("leaves our up-to-date links as ok", () => {
    const actions = planSkillsSync(["a"], ["a"], () => "ours");
    expect(actions).toEqual([{ name: "a", kind: "ok" }]);
  });

  test("never clobbers a foreign entry", () => {
    const actions = planSkillsSync(["a"], [], () => "foreign");
    expect(actions).toEqual([{ name: "a", kind: "skip-foreign" }]);
  });

  test("prunes managed links whose source skill disappeared", () => {
    const status = (n: string): "ours" | "absent" => (n === "keep" ? "ours" : "absent");
    const actions = planSkillsSync(["keep"], ["keep", "gone"], status);
    expect(actions).toContainEqual({ name: "keep", kind: "ok" });
    expect(actions).toContainEqual({ name: "gone", kind: "prune" });
  });

  test("does not prune a name that is still desired", () => {
    const actions = planSkillsSync(["a"], ["a"], () => "ours");
    expect(actions.filter((x) => x.kind === "prune")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/cli/test/skills.test.ts`
Expected: FAIL — cannot find module `../src/skills.js`.

- [ ] **Step 3: Write `packages/cli/src/skills.ts`**

```ts
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type EntryStatus = "absent" | "ours" | "foreign";

export type SkillAction = {
  name: string;
  kind: "create" | "ok" | "skip-foreign" | "prune";
};

// Pure planner. `status(name)` classifies the current on-disk entry.
export function planSkillsSync(
  desired: string[],
  managed: string[],
  status: (name: string) => EntryStatus,
): SkillAction[] {
  const actions: SkillAction[] = [];
  for (const name of desired) {
    const s = status(name);
    if (s === "absent") actions.push({ name, kind: "create" });
    else if (s === "ours") actions.push({ name, kind: "ok" });
    else actions.push({ name, kind: "skip-foreign" });
  }
  const desiredSet = new Set(desired);
  for (const name of managed) {
    if (!desiredSet.has(name)) actions.push({ name, kind: "prune" });
  }
  return actions;
}

// A skill is a subdir of skillsDir that contains a SKILL.md.
export function discoverSkills(skillsDir: string): string[] {
  if (!existsSync(skillsDir)) return [];
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(skillsDir, d.name, "SKILL.md")))
    .map((d) => d.name)
    .sort();
}

export const TARGET_BASES = [
  join(homedir(), ".claude", "skills"),
  join(homedir(), ".agents", "skills"),
];

const MANIFEST_FILE = ".corehub-managed.json";

function readManaged(baseDir: string): string[] {
  const file = join(baseDir, MANIFEST_FILE);
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { managed?: unknown };
    return Array.isArray(parsed.managed) ? parsed.managed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function writeManaged(baseDir: string, managed: string[]): void {
  const file = join(baseDir, MANIFEST_FILE);
  writeFileSync(file, `${JSON.stringify({ version: 1, managed: managed.sort() }, null, 2)}\n`);
}

// Classify an existing entry: ours only if it's a symlink we manage that points
// into the repo skillsDir; anything else present is foreign (never touched).
function classify(baseDir: string, skillsDir: string, managed: Set<string>, name: string): EntryStatus {
  const target = join(baseDir, name);
  if (!existsSync(target) && !isSymlink(target)) return "absent";
  if (!managed.has(name)) return "foreign";
  if (!isSymlink(target)) return "foreign";
  try {
    return resolve(readlinkSync(target)) === resolve(join(skillsDir, name)) ? "ours" : "foreign";
  } catch {
    return "foreign";
  }
}

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

// Apply the plan for one target base dir; returns the actions taken.
export function syncTarget(baseDir: string, skillsDir: string, desired: string[]): SkillAction[] {
  mkdirSync(baseDir, { recursive: true });
  const managed = readManaged(baseDir);
  const managedSet = new Set(managed);
  const actions = planSkillsSync(desired, managed, (name) =>
    classify(baseDir, skillsDir, managedSet, name),
  );

  const nowManaged = new Set(managed);
  for (const action of actions) {
    const target = join(baseDir, action.name);
    if (action.kind === "create") {
      symlinkSync(resolve(join(skillsDir, action.name)), target);
      nowManaged.add(action.name);
    } else if (action.kind === "prune") {
      if (isSymlink(target)) rmSync(target);
      nowManaged.delete(action.name);
    }
    // "ok" and "skip-foreign" need no filesystem change.
  }
  writeManaged(baseDir, [...nowManaged]);
  return actions;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/cli/test/skills.test.ts`
Expected: PASS.

- [ ] **Step 5: Fill in `packages/cli/src/commands/skills.ts`**

```ts
import type { ParsedArgs } from "../cli.js";
import { resolvePaths } from "../paths.js";
import { discoverSkills, type SkillAction, syncTarget, TARGET_BASES } from "../skills.js";
import { say } from "../ui.js";

function report(base: string, actions: SkillAction[]): void {
  console.log(`\n${base}`);
  if (actions.length === 0) {
    console.log("  (nada a fazer)");
    return;
  }
  for (const a of actions) {
    if (a.kind === "create") say(`  + ${a.name}`, "PASS", "link criado");
    else if (a.kind === "ok") say(`  = ${a.name}`, "PASS", "já ok");
    else if (a.kind === "prune") say(`  - ${a.name}`, "PASS", "link removido (skill sumiu)");
    else say(`  ! ${a.name}`, "FAIL", "já existe e não é nosso — preservado");
  }
}

export async function cmdSkills(args: ParsedArgs): Promise<number> {
  if (args.sub !== "sync") {
    console.error("uso: corehub skills sync");
    return 1;
  }
  const paths = resolvePaths();
  const desired = discoverSkills(paths.skillsDir);
  if (desired.length === 0) {
    console.log(`nenhuma skill em ${paths.skillsDir} (F5 popula essa pasta) — nada a sincronizar.`);
    return 0;
  }
  for (const base of TARGET_BASES) {
    report(base, syncTarget(base, paths.skillsDir, desired));
  }
  console.log(`\n${desired.length} skill(s) sincronizada(s).`);
  return 0;
}
```

- [ ] **Step 6: Manually verify with a throwaway skill + fake HOME (protects the real 55 skills)**

Run:
```bash
FAKEHOME=$(mktemp -d)
mkdir -p skills/demo-skill
printf -- '---\nname: demo-skill\ndescription: demo\n---\noi\n' > skills/demo-skill/SKILL.md
HOME="$FAKEHOME" bun run packages/cli/src/index.ts skills sync
```
Expected: two blocks (`.claude/skills`, `.agents/skills`), each with `+ demo-skill  PASS link criado`.

Run: `ls -l "$FAKEHOME/.claude/skills/demo-skill" && cat "$FAKEHOME/.claude/skills/.corehub-managed.json"`
Expected: symlink → `<repo>/skills/demo-skill`; manifest lists `"demo-skill"`.

- [ ] **Step 7: Verify foreign-safety and prune with the fake HOME**

Run:
```bash
mkdir -p "$FAKEHOME/.claude/skills/user-owned"           # a foreign entry
HOME="$FAKEHOME" bun run packages/cli/src/index.ts skills sync
```
Expected: `user-owned` is NOT reported/removed (it's foreign, not in our manifest). `demo-skill` shows `= ... já ok`.

Run:
```bash
rm -rf skills/demo-skill                                  # skill disappears
HOME="$FAKEHOME" bun run packages/cli/src/index.ts skills sync
```
Expected: `nenhuma skill em .../skills` message — since `desired` is now empty the command returns early without pruning. (Prune only runs when at least one skill remains; an empty `skills/` is treated as "nothing to sync", which is the F4 reality until F5.)

Run:
```bash
ls "$FAKEHOME/.claude/skills"        # user-owned must still be there
rm -rf "$FAKEHOME" skills
```
Expected: `user-owned` present; cleanup removes the fake home and the empty `skills/` dir.

- [ ] **Step 8: Confirm the real skills dirs were never touched**

Run: `ls -1 ~/.claude/skills | wc -l`
Expected: `55` (unchanged — the manual test used a fake `HOME`).

- [ ] **Step 9: Full verification**

Run: `bun run typecheck && bun run lint && bun test packages/cli/test`
Expected: all green.

- [ ] **Step 10: Commit**

```bash
git add packages/cli/src/skills.ts packages/cli/src/commands/skills.ts packages/cli/test/skills.test.ts
git commit -m "feat(f4): corehub skills sync (symlink por skill; preserva skills do usuario; manifest de links geridos)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Wire CI, root script, and docs

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `package.json` (root — add `corehub` script)
- Modify: `README.md`
- Modify: `docs/connecting-tools.md`

**Interfaces:**
- Consumes: everything from Tasks 1–5.

- [ ] **Step 1: Add the CLI tests to CI**

In `.github/workflows/ci.yml`, in the `gateway-checks` job, add a step after the gateway test line:

```yaml
      - run: bun test packages/gateway/test
      - run: bun test packages/cli/test
```

- [ ] **Step 2: Add a root `corehub` convenience script**

In root `package.json` `scripts`, add:

```json
    "test": "bun test",
    "corehub": "bun run packages/cli/src/index.ts"
```

- [ ] **Step 3: Update `README.md` — status line and quick start**

Replace the `**Status:**` block and the "Quick start (F3)" heading/steps so the flow leads with the CLI:

```markdown
**Status:** F4 — `corehub` CLI (`init`/`up`/`down`/`status`/`doctor` + `skills sync`).
Gateway on `:11434` with OpenAI + Anthropic + Ollama surfaces; Open WebUI in the stack.

## Quick start (F4)

New machine, ≤3 commands (after cloning):

1. `bun install`
2. `bun run corehub init` — writes `deploy/compose/.env` with fresh infra secrets.
3. `bun run corehub up` — builds and starts the stack (add `--profile ui` for Open WebUI).
4. Open `http://localhost:2099` — create the manifest admin, connect a provider, set the
   default routing tier, create the agents (`opencode`, `claude-code`, `copilot`, `openwebui`,
   `lan-anon`), paste their `mnfst_` keys into `.env`, then `bun run corehub up` again.
5. `bun run corehub doctor` — the chain must be all green.

Later, `bun run corehub skills sync` links the shared skills library (populated in F5) into
`~/.claude/skills` and `~/.agents/skills`. See `docs/connecting-tools.md` for per-tool setup.
```

- [ ] **Step 4: Add a CLI section to `docs/connecting-tools.md`**

Append at the end of the file:

```markdown
## CLI `corehub`

Orquestra o stack a partir da raiz do repositório (ou defina `COREHUB_ROOT`):

| Comando | O que faz |
|---|---|
| `corehub init` | gera `deploy/compose/.env` com segredos novos (não sobrescreve; `--force` regenera) |
| `corehub up [--profile ui] [--no-build]` | sobe o stack (`docker compose up -d --build`) |
| `corehub down [--volumes]` | derruba o stack (`--volumes` apaga os volumes nomeados) |
| `corehub status` | `docker compose ps` dos serviços |
| `corehub doctor` | health dos 3 hops + request ponta-a-ponta (usa `MANIFEST_KEY_OPENCODE`) |
| `corehub skills sync` | symlink por skill em `~/.claude/skills` e `~/.agents/skills` (preserva as suas) |

Rodar via `bun run corehub <cmd>` (script na raiz) ou, após `bun link` em `packages/cli`,
direto como `corehub <cmd>`. Binário único opcional: `bun run --cwd packages/cli build`
gera `./corehub` (defina `COREHUB_ROOT` se movê-lo pra fora do repo).
```

- [ ] **Step 5: Validate CI YAML and compose still parse**

Run: `docker compose -f deploy/compose/docker-compose.yml --env-file deploy/compose/.env config -q`
Expected: no output (valid).
Run: `bun -e "const {parse}=await import('yaml').catch(()=>({parse:null})); const t=require('fs').readFileSync('.github/workflows/ci.yml','utf8'); console.log(t.includes('packages/cli/test')?'ci-ok':'ci-missing')"` — or simply inspect the file.
Expected: `ci-ok` (or visual confirmation the step is present).

- [ ] **Step 6: Full verification**

Run: `bun run typecheck && bun run lint && bun test packages/cli/test && bun test packages/gateway/test`
Expected: all green (CLI + gateway suites).
Run: `bun run corehub doctor`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add .github/workflows/ci.yml package.json README.md docs/connecting-tools.md
git commit -m "feat(f4): CI roda testes do cli; script corehub na raiz; docs do CLI (README + connecting-tools)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Final validation and push

- [ ] **Step 1: Green-field verification of the whole workspace**

Run: `bun install && bun run typecheck && bun run lint`
Expected: clean.
Run: `bun test packages/cli/test && bun test packages/gateway/test`
Expected: all pass.

- [ ] **Step 2: End-to-end CLI smoke (against the running stack)**

Run: `bun run corehub status`
Expected: services listed.
Run: `bun run corehub doctor`
Expected: `corehub doctor: tudo verde ✓`.

- [ ] **Step 3: Confirm no secrets are tracked**

Run: `git status --short && git ls-files | grep -E '\.env$|\.local$' || echo "nenhum segredo rastreado"`
Expected: clean tree; `nenhum segredo rastreado`.

- [ ] **Step 4: Push**

```bash
git push origin main
```
Expected: the F4 commits land on `origin/main`.

---

## Self-Review

**Spec coverage (§9 F4 = `up/down/status/doctor/init` + `skills sync`, ≤3 commands, doctor green):**
- `init` → Task 3; `up`/`down`/`status` → Task 2; `doctor` → Task 4; `skills sync` → Task 5. ✓
- "≤3 commands new machine" → README quick start (`init` → `up` → `doctor`), Task 6. ✓
- "doctor green" → `probeHealth` (3-hop aggregate) + `probeChat` (e2e), Task 4. ✓
- §6 skills hub: per-skill symlinks to `~/.claude/skills` + `~/.agents/skills`, `.corehub-managed.json`, never whole-dir, never touch pre-existing → Task 5. ✓
- §7 repo layout `packages/cli/` in Bun workspace, strict TS, CI runs tests → Tasks 1 & 6. ✓
- §8 "`corehub doctor` smoke-test permanent" → Task 4. ✓

**Placeholder scan:** every code step contains complete code; every run step has an expected result. No TBD/TODO. ✓

**Type consistency:** `ParsedArgs`, `RepoPaths`, `CheckResult`, `SkillAction`, `EntryStatus`, `CmdHandler` are defined once and reused with matching field names across tasks. `parseEnvFile`/`SECRET_KEYS` defined in Task 3, consumed in Task 4. `resolvePaths` defined in Task 1, consumed in Tasks 2–5. ✓

**Note on the prune edge case:** when `skills/` is empty (the F4 reality until F5), `cmdSkills` returns early and does not prune. Documented in Task 5 Step 7 and acceptable — F5 will populate `skills/`, at which point prune activates for removed skills. This avoids the surprise of an empty repo dir wiping managed links.
