import { describe, expect, test } from "bun:test";
import { planSkillsSync } from "../src/skills.js";

describe("planSkillsSync", () => {
  test("creates absent desired links", () => {
    const actions = planSkillsSync(["a", "b"], [], () => "absent");
    expect(actions).toEqual([
      { name: "a", kind: "create" },
      { name: "b", kind: "create" },
    ]);
  });

  test("leaves our up-to-date links as ok", () => {
    const actions = planSkillsSync(["a"], ["a"], () => "ours");
    expect(actions).toEqual([{ name: "a", kind: "ok" }]);
  });

  test("never clobbers a foreign entry", () => {
    const actions = planSkillsSync(["a"], [], () => "foreign");
    expect(actions).toEqual([{ name: "a", kind: "skip-foreign" }]);
  });

  test("prunes managed links whose source skill disappeared", () => {
    const status = (n: string): "ours" | "absent" => (n === "keep" ? "ours" : "absent");
    const actions = planSkillsSync(["keep"], ["keep", "gone"], status);
    expect(actions).toContainEqual({ name: "keep", kind: "ok" });
    expect(actions).toContainEqual({ name: "gone", kind: "prune" });
  });

  test("does not prune a name that is still desired", () => {
    const actions = planSkillsSync(["a"], ["a"], () => "ours");
    expect(actions.filter((x) => x.kind === "prune")).toEqual([]);
  });
});
