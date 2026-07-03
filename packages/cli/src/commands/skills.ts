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
    else if (a.kind === "untrack") say(`  ~ ${a.name}`, "PASS", "destrackeado (não é mais nosso)");
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
