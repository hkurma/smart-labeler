import * as github from "@actions/github";
import { MAX_CHANGED_FILES, type Item, type Label } from "./classify.js";

type Context = typeof github.context;

interface PayloadLabel {
  name?: string;
}

interface PayloadItem {
  number: number;
  title?: string;
  body?: string | null;
  user?: { login?: string } | null;
  labels?: (PayloadLabel | string)[];
}

const PR_EVENTS = new Set(["pull_request", "pull_request_target"]);

/** Reads the issue or PR from the event payload, or returns `null` for unsupported events. */
export function readItem(context: Pick<Context, "eventName" | "payload">): Item | null {
  const { eventName, payload } = context;
  let kind: Item["kind"];
  let raw: PayloadItem | undefined;
  if (eventName === "issues") {
    kind = "issue";
    raw = payload.issue as PayloadItem | undefined;
  } else if (PR_EVENTS.has(eventName)) {
    kind = "pull_request";
    raw = payload.pull_request as PayloadItem | undefined;
  } else {
    return null;
  }
  if (!raw) return null;

  return {
    kind,
    number: raw.number,
    title: raw.title ?? "",
    body: raw.body ?? "",
    author: raw.user?.login ?? "",
    labels: (raw.labels ?? [])
      .map((l) => (typeof l === "string" ? l : l.name))
      .filter((n): n is string => !!n),
  };
}

/** GitHub API calls for one repository, sharing a single authenticated client. */
export function createGitHub(token: string, { owner, repo }: Context["repo"] = github.context.repo) {
  const octokit = github.getOctokit(token);

  return {
    async fetchRepoLabels(): Promise<Label[]> {
      const labels = await octokit.paginate(octokit.rest.issues.listLabelsForRepo, { owner, repo, per_page: 100 });
      return labels.map((l) => ({ name: l.name, description: l.description ?? null }));
    },

    async fetchChangedFiles(pullNumber: number): Promise<string[]> {
      const files: string[] = [];
      await octokit.paginate(
        octokit.rest.pulls.listFiles,
        { owner, repo, pull_number: pullNumber, per_page: 100 },
        (response, done) => {
          for (const f of response.data) files.push(f.filename);
          if (files.length >= MAX_CHANGED_FILES) done();
          return [];
        },
      );
      return files.slice(0, MAX_CHANGED_FILES);
    },

    async addLabels(issueNumber: number, labels: string[]): Promise<void> {
      await octokit.rest.issues.addLabels({ owner, repo, issue_number: issueNumber, labels });
    },
  };
}

export type GitHub = ReturnType<typeof createGitHub>;
