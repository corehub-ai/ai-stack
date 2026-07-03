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
