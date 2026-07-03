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
