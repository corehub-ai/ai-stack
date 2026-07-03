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
