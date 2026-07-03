import { existsSync, readFileSync } from "node:fs";
import type { ParsedArgs } from "../cli.js";
import { type CheckResult, checkEnvSecrets, probeChat, probeHealth, summarize } from "../doctor.js";
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
