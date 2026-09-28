import {
  choice,
  noul,
  type ChoiceResponse,
  type NoulResponse,
  type Questions,
  type TypeSafeClient,
} from "@typesafe-ai/sdk";

/** A Choice accepts at most 255 options; one is reserved for `none`. */
export const MAX_GROUP_LABELS = 254;
export const MAX_BODY_CHARS = 12_000;
export const MAX_CHANGED_FILES = 300;
const NO_DESCRIPTION = "(no description; infer from the name)";

export interface Label {
  name: string;
  description: string | null;
}

export interface Item {
  kind: "issue" | "pull_request";
  number: number;
  title: string;
  body: string;
  author: string;
  /** Labels already on the issue or PR. */
  labels: string[];
  /** PRs only. */
  changedFiles?: string[];
}

export interface Group {
  name: string;
  labels: Label[];
}

export interface SkippedGroup {
  name: string;
  labelCount: number;
  reason: "already-labeled" | "too-many-labels";
}

export interface Grouping {
  groups: Group[];
  ungrouped: Label[];
  skipped: SkippedGroup[];
}

export type QuestionPlan =
  | { id: string; kind: "group"; group: string; noneKey: string }
  | { id: string; kind: "label"; label: string };

export type Decision =
  | {
      kind: "group";
      group: string;
      /** `null` when the model picked `none`. */
      pick: string | null;
      probability: number;
      runnerUp: { option: string; probability: number } | null;
      applied: boolean;
    }
  | { kind: "label"; label: string; probability: number; applied: boolean };

export interface Scores {
  groups: Record<string, { pick: string | null; probability: number; applied: boolean }>;
  labels: Record<string, { probability: number; applied: boolean }>;
}

/** Returns the group a label belongs to, or `null` when it is ungrouped. */
export function groupOf(name: string, separator: string): string | null {
  const index = name.indexOf(separator);
  if (index < 0) return null;
  const prefix = name.slice(0, index).trim();
  const rest = name.slice(index + separator.length).trim();
  return prefix && rest ? prefix : null;
}

/**
 * Splits the repo's labels into Choice groups and ungrouped Noul labels.
 * Labels already on the item are dropped, and a group the item already has a label from is skipped,
 * because at most one label per group is applied. Group names compare case-insensitively, like GitHub labels.
 */
export function groupLabels(repoLabels: Label[], itemLabels: string[], separator: string): Grouping {
  const onItem = new Set(itemLabels.map((l) => l.toLowerCase()));
  const labeledGroups = new Set(
    itemLabels.map((l) => groupOf(l, separator)?.toLowerCase()).filter((g): g is string => g != null),
  );

  const byGroup = new Map<string, Group>();
  const ungrouped: Label[] = [];
  for (const label of repoLabels) {
    const group = groupOf(label.name, separator);
    if (group == null) {
      if (!onItem.has(label.name.toLowerCase())) ungrouped.push(label);
      continue;
    }
    const key = group.toLowerCase();
    let entry = byGroup.get(key);
    if (!entry) {
      entry = { name: group, labels: [] };
      byGroup.set(key, entry);
    }
    entry.labels.push(label);
  }

  const groups: Group[] = [];
  const skipped: SkippedGroup[] = [];
  for (const [key, group] of byGroup) {
    if (labeledGroups.has(key)) {
      skipped.push({ name: group.name, labelCount: group.labels.length, reason: "already-labeled" });
    } else if (group.labels.length > MAX_GROUP_LABELS) {
      skipped.push({ name: group.name, labelCount: group.labels.length, reason: "too-many-labels" });
    } else {
      groups.push(group);
    }
  }
  return { groups, ungrouped, skipped };
}

export function buildState(item: Item) {
  const body =
    item.body.length > MAX_BODY_CHARS ? `${item.body.slice(0, MAX_BODY_CHARS)}\n…[truncated]` : item.body;
  return {
    kind: item.kind,
    title: item.title,
    body,
    author: item.author,
    ...(item.changedFiles ? { changed_files: item.changedFiles.slice(0, MAX_CHANGED_FILES) } : {}),
  };
}

function describe(label: Label): string {
  return label.description?.trim() || NO_DESCRIPTION;
}

/** Builds one Choice per group and one Noul per ungrouped label. Question IDs are not sent to the model. */
export function buildQuestions(grouping: Grouping): { questions: Questions; plan: QuestionPlan[] } {
  const questions: Questions = {};
  const plan: QuestionPlan[] = [];

  grouping.groups.forEach((group, i) => {
    const id = `g${i}`;
    const names = new Set(group.labels.map((l) => l.name));
    const noneKey = names.has("none") ? "__none__" : "none";
    const criteria: Record<string, string> = {};
    for (const label of group.labels) criteria[label.name] = describe(label);
    criteria[noneKey] = "No label in this group clearly applies";

    questions[id] = choice(
      {
        question:
          "Which label from the group best fits the `kind` described in the state? " +
          `Pick \`${noneKey}\` unless one label clearly fits the title, body, or changed_files.`,
        group: group.name,
      },
      criteria,
    );
    plan.push({ id, kind: "group", group: group.name, noneKey });
  });

  grouping.ungrouped.forEach((label, i) => {
    const id = `n${i}`;
    questions[id] = noul(
      {
        question: "Should this label be applied to the `kind` described in the state?",
        label: { name: label.name, description: describe(label) },
      },
      {
        true: "The label's meaning clearly matches the title, body, or changed_files",
        false: "The label is unrelated, only tangentially related, or would be a guess",
      },
    );
    plan.push({ id, kind: "label", label: label.name });
  });

  return { questions, plan };
}

type Answer = NoulResponse | ChoiceResponse;

/** Applies the threshold and max-labels policy to the model's answers. */
export function selectLabels(
  plan: QuestionPlan[],
  answers: Record<string, Answer | undefined>,
  threshold: number,
  maxLabels: number,
): { labels: string[]; decisions: Decision[] } {
  const decisions: Decision[] = plan.map((q) => {
    const answer = answers[q.id];
    if (q.kind === "group") {
      if (answer?.type !== "choice") throw new Error(`TypeSafe returned no choice answer for group "${q.group}".`);
      const ranked = Object.entries(answer.probabilities as Record<string, number>).sort((a, b) => b[1] - a[1]);
      const probability = (answer.probabilities as Record<string, number>)[answer.choice] ?? 0;
      const second = ranked.find(([option]) => option !== answer.choice);
      return {
        kind: "group",
        group: q.group,
        pick: answer.choice === q.noneKey ? null : answer.choice,
        probability,
        runnerUp: second ? { option: second[0], probability: second[1] } : null,
        applied: false,
      };
    }
    if (answer?.type !== "noul") throw new Error(`TypeSafe returned no noul answer for label "${q.label}".`);
    return { kind: "label", label: q.label, probability: answer.noul, applied: false };
  });

  const candidates = decisions
    .filter((d) => d.probability >= threshold && (d.kind === "label" || d.pick != null))
    .sort((a, b) => b.probability - a.probability);
  const chosen = maxLabels > 0 ? candidates.slice(0, maxLabels) : candidates;
  for (const d of chosen) d.applied = true;

  const labels = chosen.map((d) => (d.kind === "group" ? d.pick! : d.label));
  return { labels, decisions };
}

/** `groups`: the model's pick per group (`null` for none). `labels`: probability of yes per ungrouped label. */
export function toScores(decisions: Decision[]): Scores {
  const scores: Scores = { groups: {}, labels: {} };
  for (const d of decisions) {
    if (d.kind === "group") scores.groups[d.group] = { pick: d.pick, probability: d.probability, applied: d.applied };
    else scores.labels[d.label] = { probability: d.probability, applied: d.applied };
  }
  return scores;
}

export async function classify(
  client: Pick<TypeSafeClient, "systemOne">,
  state: ReturnType<typeof buildState>,
  questions: Questions,
  model: string,
): Promise<Record<string, Answer | undefined>> {
  const result = await client.systemOne({ state, questions, model });
  return result.answers as Record<string, Answer | undefined>;
}
