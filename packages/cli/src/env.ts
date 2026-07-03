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
