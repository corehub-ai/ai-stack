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
  kind: "create" | "ok" | "skip-foreign" | "prune" | "untrack";
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
    if (desiredSet.has(name)) continue;
    // Only delete a link we still own (points into skillsDir). If the user
    // repointed it (foreign) or already removed it (absent), just drop it from
    // tracking — never rmSync something that is no longer ours.
    actions.push({ name, kind: status(name) === "ours" ? "prune" : "untrack" });
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
    return Array.isArray(parsed.managed)
      ? parsed.managed.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

function writeManaged(baseDir: string, managed: string[]): void {
  const file = join(baseDir, MANIFEST_FILE);
  writeFileSync(file, `${JSON.stringify({ version: 1, managed: managed.sort() }, null, 2)}\n`);
}

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

// Classify an existing entry: ours only if it's a symlink we manage that points
// into the repo skillsDir; anything else present is foreign (never touched).
function classify(
  baseDir: string,
  skillsDir: string,
  managed: Set<string>,
  name: string,
): EntryStatus {
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
    } else if (action.kind === "untrack") {
      nowManaged.delete(action.name);
    }
    // "ok" and "skip-foreign" need no filesystem change.
  }
  writeManaged(baseDir, [...nowManaged]);
  return actions;
}
