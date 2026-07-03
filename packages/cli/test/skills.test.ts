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

  test("prunes a managed link we still own whose source skill disappeared", () => {
    // A dropped repo skill leaves a dangling symlink that still points into
    // skillsDir → classify() returns "ours" → safe to delete.
    const status = (): "ours" => "ours";
    const actions = planSkillsSync(["keep"], ["keep", "gone"], status);
    expect(actions).toContainEqual({ name: "keep", kind: "ok" });
    expect(actions).toContainEqual({ name: "gone", kind: "prune" });
  });

  test("untracks — never deletes — a managed link the user repointed", () => {
    const status = (n: string): "ours" | "foreign" => (n === "keep" ? "ours" : "foreign");
    const actions = planSkillsSync(["keep"], ["keep", "mine"], status);
    expect(actions).toContainEqual({ name: "mine", kind: "untrack" });
    expect(actions.filter((a) => a.kind === "prune")).toEqual([]);
  });

  test("untracks a managed link the user already removed", () => {
    const status = (n: string): "ours" | "absent" => (n === "keep" ? "ours" : "absent");
    const actions = planSkillsSync(["keep"], ["keep", "gone"], status);
    expect(actions).toContainEqual({ name: "gone", kind: "untrack" });
  });

  test("does not prune a name that is still desired", () => {
    const actions = planSkillsSync(["a"], ["a"], () => "ours");
    expect(actions.filter((x) => x.kind === "prune")).toEqual([]);
  });
});
