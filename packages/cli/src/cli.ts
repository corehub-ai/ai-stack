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
