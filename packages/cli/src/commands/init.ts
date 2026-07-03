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

  console.log(`✓ ${paths.envFile} criado com segredos novos (BETTER_AUTH_SECRET,`);
  console.log("  MANIFEST_ENCRYPTION_KEY, POSTGRES_PASSWORD, WEBUI_SECRET_KEY).\n");
  console.log("próximos passos:");
  console.log("  1. corehub up                       # sobe o stack");
  console.log("  2. abra http://localhost:2099       # crie o admin do manifest,");
  console.log("     conecte um provider, defina o tier default e crie os agentes");
  console.log("     (opencode, claude-code, copilot, openwebui, lan-anon).");
  console.log("  3. cole as chaves mnfst_ nos MANIFEST_KEY_* do .env e rode 'corehub up' de novo");
  console.log("  4. corehub doctor                   # valida a cadeia ponta-a-ponta");
  return 0;
}
