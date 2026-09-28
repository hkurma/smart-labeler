import * as core from "@actions/core";
import * as github from "@actions/github";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import {
  buildQuestions,
  buildState,
  classify,
  groupLabels,
  MAX_GROUP_LABELS,
  selectLabels,
  toScores,
  type Decision,
} from "./classify.js";
import { getConfig } from "./config.js";
import { createGitHub, readItem } from "./github.js";

export async function run(): Promise<void> {
  let warnings = 0;
  const warn = (message: string) => {
    warnings++;
    core.warning(message);
  };

  try {
    const config = getConfig();
    const { context } = github;
    const item = readItem(context);
    if (!item) {
      core.notice(`Smart Labeler: event "${context.eventName}" is not an issue or pull request event; nothing to do.`);
      return;
    }

    const gh = createGitHub(config.githubToken, context.repo);
    const [repoLabels, changedFiles] = await Promise.all([
      gh.fetchRepoLabels(),
      item.kind === "pull_request" ? gh.fetchChangedFiles(item.number) : undefined,
    ]);
    if (changedFiles) item.changedFiles = changedFiles;

    const grouping = groupLabels(repoLabels, item.labels, config.groupSeparator);
    for (const s of grouping.skipped) {
      if (s.reason === "too-many-labels") {
        warn(`Skipped group "${s.name}": it has ${s.labelCount} labels, more than the ${MAX_GROUP_LABELS} a single choice supports.`);
      } else {
        core.info(`Skipped group "${s.name}": #${item.number} already has a label from it.`);
      }
    }

    const { questions, plan } = buildQuestions(grouping);
    let labels: string[] = [];
    let decisions: Decision[] = [];
    if (plan.length === 0) {
      core.notice("Smart Labeler: no candidate labels to evaluate.");
    } else {
      core.info(
        `Asking ${config.model} about ${grouping.groups.length} group(s) and ${grouping.ungrouped.length} ungrouped label(s) for ${item.kind} #${item.number}.`,
      );
      const client = new TypeSafeClient({ apiKey: config.typesafeApiKey });
      const answers = await classify(client, buildState(item), questions, config.model);
      ({ labels, decisions } = selectLabels(plan, answers, config.threshold, config.maxLabels));
    }

    if (labels.length === 0) {
      core.info("No labels met the threshold.");
    } else if (config.dryRun) {
      core.info(`Dry run: would apply ${labels.join(", ")}.`);
    } else {
      await gh.addLabels(item.number, labels);
      core.info(`Applied ${labels.join(", ")} to #${item.number}.`);
    }

    core.setOutput("labels", JSON.stringify(labels));
    core.setOutput("scores", JSON.stringify(toScores(decisions)));
    await writeSummary(item.kind, item.number, labels, decisions, config.dryRun);

    if (config.failOnWarning && warnings > 0) {
      core.setFailed(`${warnings} warning(s); see log.`);
    }
  } catch (error) {
    // setFailed also logs the message as an error annotation.
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
}

const pct = (p: number) => `${(p * 100).toFixed(1)}%`;

async function writeSummary(
  kind: string,
  number: number,
  labels: string[],
  decisions: Decision[],
  dryRun: boolean,
): Promise<void> {
  // Absent outside GitHub Actions (e.g. local runs); core.summary.write() would throw.
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  const summary = core.summary.addHeading("Smart Labeler", 2);
  const verb = dryRun ? "Would apply" : "Applied";
  summary.addRaw(
    `${kind === "issue" ? "Issue" : "Pull request"} #${number}: ${
      labels.length ? `${verb} ${labels.map((l) => `\`${l}\``).join(", ")}` : "no labels applied"
    }`,
    true,
  );

  const groups = decisions.filter((d) => d.kind === "group");
  if (groups.length) {
    summary.addHeading("Groups", 3).addTable([
      [
        { data: "Group", header: true },
        { data: "Pick", header: true },
        { data: "Probability", header: true },
        { data: "Runner-up", header: true },
        { data: "Applied", header: true },
      ],
      ...groups.map((d) => [
        d.group,
        d.pick ?? "none",
        pct(d.probability),
        d.runnerUp ? `${d.runnerUp.option} (${pct(d.runnerUp.probability)})` : "",
        d.applied ? "yes" : "no",
      ]),
    ]);
  }

  const singles = decisions.filter((d) => d.kind === "label");
  if (singles.length) {
    summary.addHeading("Ungrouped labels", 3).addTable([
      [
        { data: "Label", header: true },
        { data: "Probability", header: true },
        { data: "Applied", header: true },
      ],
      ...singles.map((d) => [d.label, pct(d.probability), d.applied ? "yes" : "no"]),
    ]);
  }

  await summary.write();
}
