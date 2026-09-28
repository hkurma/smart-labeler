import * as core from "@actions/core";

export interface Config {
  typesafeApiKey: string;
  githubToken: string;
  model: string;
  threshold: number;
  /** 0 means unlimited. */
  maxLabels: number;
  groupSeparator: string;
  dryRun: boolean;
  failOnWarning: boolean;
}

export function getConfig(): Config {
  const typesafeApiKey = core.getInput("typesafe-api-key", { required: true });
  core.setSecret(typesafeApiKey);

  const threshold = Number(core.getInput("threshold") || "0.7");
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error(`Input "threshold" must be a number between 0 and 1, got "${core.getInput("threshold")}".`);
  }

  const maxLabels = Number(core.getInput("max-labels") || "3");
  if (!Number.isInteger(maxLabels) || maxLabels < 0) {
    throw new Error(`Input "max-labels" must be a whole number >= 0, got "${core.getInput("max-labels")}".`);
  }

  // No trimming: whitespace is a legitimate separator for some label schemes.
  const groupSeparator = core.getInput("group-separator", { trimWhitespace: false }) || ":";

  return {
    typesafeApiKey,
    githubToken: core.getInput("github-token", { required: true }),
    model: core.getInput("model") || "jev-latest",
    threshold,
    maxLabels,
    groupSeparator,
    dryRun: getBoolean("dry-run"),
    failOnWarning: getBoolean("fail-on-warning"),
  };
}

function getBoolean(name: string): boolean {
  return (core.getInput(name) || "false").toLowerCase() === "true";
}
