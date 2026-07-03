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
