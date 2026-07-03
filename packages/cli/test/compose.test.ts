import { describe, expect, test } from "bun:test";
import {
  composeBaseArgs,
  composeDownArgs,
  composePsArgs,
  composeUpArgs,
  splitProfiles,
} from "../src/compose.js";

const p = {
  composeFile: "/repo/deploy/compose/docker-compose.yml",
  envFile: "/repo/deploy/compose/.env",
};

describe("compose argv", () => {
  test("base args carry -f and --env-file", () => {
    expect(composeBaseArgs(p)).toEqual([
      "compose",
      "-f",
      "/repo/deploy/compose/docker-compose.yml",
      "--env-file",
      "/repo/deploy/compose/.env",
    ]);
  });

  test("up: detach + build, no extra profiles", () => {
    const a = composeUpArgs(p, { profiles: [], build: true, detach: true });
    expect(a.slice(-3)).toEqual(["up", "-d", "--build"]);
    expect(a).not.toContain("--profile");
  });

  test("up: injects each profile before the 'up' verb", () => {
    const a = composeUpArgs(p, { profiles: ["ui"], build: false, detach: true });
    expect(a).toContain("--profile");
    expect(a[a.indexOf("--profile") + 1]).toBe("ui");
    expect(a.indexOf("--profile")).toBeLessThan(a.indexOf("up"));
    expect(a).not.toContain("--build");
    expect(a).toContain("-d");
  });

  test("down: --volumes only when asked", () => {
    expect(composeDownArgs(p, { volumes: false }).slice(-1)).toEqual(["down"]);
    expect(composeDownArgs(p, { volumes: true }).slice(-2)).toEqual(["down", "--volumes"]);
  });

  test("ps args", () => {
    expect(composePsArgs(p).slice(-1)).toEqual(["ps"]);
  });

  test("splitProfiles handles undefined, single, and comma list", () => {
    expect(splitProfiles(undefined)).toEqual([]);
    expect(splitProfiles(true)).toEqual([]);
    expect(splitProfiles("ui")).toEqual(["ui"]);
    expect(splitProfiles("ui,extra")).toEqual(["ui", "extra"]);
  });
});
