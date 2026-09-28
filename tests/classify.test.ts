import { describe, expect, it } from "vitest";
import {
  buildQuestions,
  buildState,
  groupLabels,
  groupOf,
  MAX_BODY_CHARS,
  MAX_GROUP_LABELS,
  selectLabels,
  toScores,
  type Item,
  type Label,
} from "../src/classify.js";

const label = (name: string, description: string | null = null): Label => ({ name, description });

describe("groupOf", () => {
  it("splits on the first separator and trims", () => {
    expect(groupOf("ui:bug", ":")).toBe("ui");
    expect(groupOf(" area : api:v2", ":")).toBe("area");
    expect(groupOf("type/feature", "/")).toBe("type");
  });

  it("treats missing or empty parts as ungrouped", () => {
    expect(groupOf("bug", ":")).toBeNull();
    expect(groupOf(":bug", ":")).toBeNull();
    expect(groupOf("ui:", ":")).toBeNull();
    expect(groupOf("  : x", ":")).toBeNull();
  });
});

describe("groupLabels", () => {
  it("separates groups from ungrouped labels", () => {
    const g = groupLabels(
      [label("ui:bug"), label("ui:feature"), label("priority:high"), label("documentation")],
      [],
      ":",
    );
    expect(g.groups.map((x) => [x.name, x.labels.map((l) => l.name)])).toEqual([
      ["ui", ["ui:bug", "ui:feature"]],
      ["priority", ["priority:high"]],
    ]);
    expect(g.ungrouped.map((l) => l.name)).toEqual(["documentation"]);
    expect(g.skipped).toEqual([]);
  });

  it("keeps a one-label group as a group", () => {
    const g = groupLabels([label("size:xl")], [], ":");
    expect(g.groups).toHaveLength(1);
    expect(g.ungrouped).toHaveLength(0);
  });

  it("groups case-insensitively, keeping the first spelling", () => {
    const g = groupLabels([label("UI:bug"), label("ui:feature")], [], ":");
    expect(g.groups).toHaveLength(1);
    expect(g.groups[0]!.name).toBe("UI");
  });

  it("skips a group the item already has a label from, and drops applied ungrouped labels", () => {
    const g = groupLabels([label("ui:bug"), label("ui:feature"), label("bug"), label("docs")], ["UI:Bug", "bug"], ":");
    expect(g.groups).toEqual([]);
    expect(g.skipped).toEqual([{ name: "ui", labelCount: 2, reason: "already-labeled" }]);
    expect(g.ungrouped.map((l) => l.name)).toEqual(["docs"]);
  });

  it("skips a group with more labels than a choice supports, keeping the rest", () => {
    const big = Array.from({ length: MAX_GROUP_LABELS + 1 }, (_, i) => label(`big:${i}`));
    const g = groupLabels([...big, label("ok:a"), label("bug")], [], ":");
    expect(g.skipped).toEqual([{ name: "big", labelCount: MAX_GROUP_LABELS + 1, reason: "too-many-labels" }]);
    expect(g.groups.map((x) => x.name)).toEqual(["ok"]);
    expect(g.ungrouped.map((l) => l.name)).toEqual(["bug"]);
  });

  it("allows a group of exactly the maximum size", () => {
    const max = Array.from({ length: MAX_GROUP_LABELS }, (_, i) => label(`big:${i}`));
    expect(groupLabels(max, [], ":").groups).toHaveLength(1);
  });
});

describe("buildState", () => {
  const item: Item = { kind: "issue", number: 1, title: "T", body: "B", author: "a", labels: [] };

  it("omits changed_files for issues", () => {
    expect(buildState(item)).toEqual({ kind: "issue", title: "T", body: "B", author: "a" });
  });

  it("includes changed_files for PRs and truncates long bodies", () => {
    const state = buildState({ ...item, kind: "pull_request", body: "x".repeat(MAX_BODY_CHARS + 5), changedFiles: ["a.ts"] });
    expect(state.changed_files).toEqual(["a.ts"]);
    expect(state.body.startsWith("x".repeat(MAX_BODY_CHARS))).toBe(true);
    expect(state.body.endsWith("[truncated]")).toBe(true);
  });
});

describe("buildQuestions", () => {
  it("builds a choice per group with a none option and a noul per ungrouped label", () => {
    const { questions, plan } = buildQuestions(
      groupLabels([label("ui:bug", "Something is broken in the UI"), label("ui:feature"), label("docs", "Docs")], [], ":"),
    );
    expect(plan).toEqual([
      { id: "g0", kind: "group", group: "ui", noneKey: "none" },
      { id: "n0", kind: "label", label: "docs" },
    ]);
    const g0 = questions.g0!;
    expect(g0.type).toBe("choice");
    expect(g0.type === "choice" && g0.criteria).toEqual({
      "ui:bug": "Something is broken in the UI",
      "ui:feature": "(no description; infer from the name)",
      none: "No label in this group clearly applies",
    });
    expect(questions.n0!.type).toBe("noul");
    expect(JSON.stringify(questions.n0!.instructions)).toContain('"name":"docs"');
  });

  it("uses __none__ when a label in the group is literally named none", () => {
    const { questions, plan } = buildQuestions({ groups: [{ name: "x", labels: [label("none"), label("x b")] }], ungrouped: [], skipped: [] });
    expect(plan[0]).toMatchObject({ noneKey: "__none__" });
    const q = questions.g0!;
    expect(q.type === "choice" && Object.keys(q.criteria)).toEqual(["none", "x b", "__none__"]);
  });
});

describe("selectLabels", () => {
  const plan = [
    { id: "g0", kind: "group", group: "ui", noneKey: "none" },
    { id: "g1", kind: "group", group: "priority", noneKey: "none" },
    { id: "n0", kind: "label", label: "docs" },
    { id: "n1", kind: "label", label: "good first issue" },
  ] as const;

  const answers = {
    g0: { type: "choice", choice: "ui:bug", confidence: 0.9, probabilities: { "ui:bug": 0.9, "ui:feature": 0.06, none: 0.04 } },
    g1: { type: "choice", choice: "none", confidence: 0.8, probabilities: { "priority:high": 0.15, none: 0.85 } },
    n0: { type: "noul", noul: 0.75 },
    n1: { type: "noul", noul: 0.2 },
  } as const;

  it("applies non-none picks and nouls at or above the threshold, highest first", () => {
    const { labels, decisions } = selectLabels([...plan], answers, 0.7, 0);
    expect(labels).toEqual(["ui:bug", "docs"]);
    expect(decisions[0]).toMatchObject({ pick: "ui:bug", probability: 0.9, runnerUp: { option: "ui:feature", probability: 0.06 }, applied: true });
    expect(decisions[1]).toMatchObject({ pick: null, probability: 0.85, applied: false });
    expect(decisions[3]).toMatchObject({ applied: false });
  });

  it("skips a pick below the threshold", () => {
    expect(selectLabels([...plan], answers, 0.95, 0).labels).toEqual([]);
  });

  it("caps at max-labels", () => {
    expect(selectLabels([...plan], answers, 0.1, 1).labels).toEqual(["ui:bug"]);
  });

  it("throws when an answer is missing", () => {
    expect(() => selectLabels([...plan], { ...answers, n1: undefined }, 0.7, 0)).toThrow(/good first issue/);
  });

  it("produces scores split by groups and labels", () => {
    const { decisions } = selectLabels([...plan], answers, 0.7, 0);
    expect(toScores(decisions)).toEqual({
      groups: {
        ui: { pick: "ui:bug", probability: 0.9, applied: true },
        priority: { pick: null, probability: 0.85, applied: false },
      },
      labels: {
        docs: { probability: 0.75, applied: true },
        "good first issue": { probability: 0.2, applied: false },
      },
    });
  });
});
