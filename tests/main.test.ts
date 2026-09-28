import { beforeEach, describe, expect, it, vi } from "vitest";

const inputs: Record<string, string> = {};
const systemOne = vi.fn();

vi.mock("@actions/core", () => {
  const summary = {
    addHeading: vi.fn(() => summary),
    addRaw: vi.fn(() => summary),
    addTable: vi.fn(() => summary),
    write: vi.fn(async () => summary),
  };
  return {
    getInput: vi.fn((name: string, opts?: { required?: boolean }) => {
      const v = inputs[name] ?? "";
      if (opts?.required && !v) throw new Error(`Input required and not supplied: ${name}`);
      return v;
    }),
    setSecret: vi.fn(),
    setOutput: vi.fn(),
    setFailed: vi.fn(),
    info: vi.fn(),
    notice: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    summary,
  };
});

const octokit = {
  rest: {
    issues: { listLabelsForRepo: vi.fn(), addLabels: vi.fn() },
    pulls: { listFiles: vi.fn() },
  },
  paginate: vi.fn(),
};

const context = { eventName: "issues", payload: {} as Record<string, unknown>, repo: { owner: "o", repo: "r" } };

vi.mock("@actions/github", () => ({ context, getOctokit: vi.fn(() => octokit) }));

vi.mock("@typesafe-ai/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@typesafe-ai/sdk")>();
  return {
    ...actual,
    TypeSafeClient: class {
      systemOne = systemOne;
    },
  };
});

const core = await import("@actions/core");
const { run } = await import("../src/main.js");

let repoLabels: { name: string; description: string | null }[];
let prFiles: string[];

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(inputs)) delete inputs[k];
  Object.assign(inputs, {
    "typesafe-api-key": "ts-key",
    "github-token": "gh-token",
    threshold: "0.7",
    "max-labels": "3",
    "group-separator": ":",
  });
  repoLabels = [
    { name: "type:bug", description: "Something is broken" },
    { name: "type:feature", description: "New functionality" },
    { name: "documentation", description: "Docs changes" },
  ];
  prFiles = ["docs/readme.md", "src/app.ts"];
  octokit.paginate.mockImplementation(async (method: unknown, _params: unknown, mapFn?: Function) => {
    if (method === octokit.rest.issues.listLabelsForRepo) return repoLabels;
    if (method === octokit.rest.pulls.listFiles) {
      mapFn?.({ data: prFiles.map((filename) => ({ filename })) }, () => {});
      return [];
    }
    throw new Error("unexpected paginate call");
  });
  context.eventName = "issues";
  context.payload = {
    issue: { number: 7, title: "Crash on save", body: "It crashes", user: { login: "alice" }, labels: [] },
  };
  systemOne.mockResolvedValue({
    model: "jev-latest",
    usage: { input_tokens: 1, output_tokens: 0 },
    answers: {
      g0: { type: "choice", choice: "type:bug", confidence: 0.9, probabilities: { "type:bug": 0.9, "type:feature": 0.05, none: 0.05 } },
      n0: { type: "noul", noul: 0.1 },
    },
  });
});

const output = (name: string) =>
  vi.mocked(core.setOutput).mock.calls.find(([n]) => n === name)?.[1] as string | undefined;

describe("run", () => {
  it("labels a new issue", async () => {
    await run();
    const request = systemOne.mock.calls[0]![0];
    expect(request.model).toBe("jev-latest");
    expect(request.state).toEqual({ kind: "issue", title: "Crash on save", body: "It crashes", author: "alice" });
    expect(Object.keys(request.questions)).toEqual(["g0", "n0"]);
    expect(octokit.rest.issues.addLabels).toHaveBeenCalledWith({ owner: "o", repo: "r", issue_number: 7, labels: ["type:bug"] });
    expect(JSON.parse(output("labels")!)).toEqual(["type:bug"]);
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it("labels a new pull request and sends changed files", async () => {
    context.eventName = "pull_request_target";
    context.payload = { pull_request: { number: 9, title: "Update docs", body: null, user: { login: "bob" }, labels: [] } };
    await run();
    expect(systemOne.mock.calls[0]![0].state).toMatchObject({ kind: "pull_request", changed_files: prFiles, body: "" });
    expect(octokit.rest.issues.addLabels).toHaveBeenCalledWith({ owner: "o", repo: "r", issue_number: 9, labels: ["type:bug"] });
    expect(JSON.parse(output("labels")!)).toEqual(["type:bug"]);
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it("does not write labels in dry-run", async () => {
    inputs["dry-run"] = "true";
    await run();
    expect(octokit.rest.issues.addLabels).not.toHaveBeenCalled();
    expect(JSON.parse(output("labels")!)).toEqual(["type:bug"]);
  });

  it("skips groups already labeled and does not call TypeSafe when nothing is left", async () => {
    repoLabels = [{ name: "type:bug", description: null }, { name: "type:feature", description: null }];
    (context.payload.issue as { labels: unknown[] }).labels = [{ name: "type:feature" }];
    await run();
    expect(systemOne).not.toHaveBeenCalled();
    expect(octokit.rest.issues.addLabels).not.toHaveBeenCalled();
    expect(JSON.parse(output("labels")!)).toEqual([]);
  });

  it("fails the step when TypeSafe errors", async () => {
    systemOne.mockRejectedValue(new Error("TypeSafe unavailable"));
    await run();
    expect(core.setFailed).toHaveBeenCalledWith("TypeSafe unavailable");
    expect(octokit.rest.issues.addLabels).not.toHaveBeenCalled();
  });

  it("applies labels, then fails on warnings when fail-on-warning is set", async () => {
    inputs["fail-on-warning"] = "true";
    repoLabels = [...repoLabels, ...Array.from({ length: 255 }, (_, i) => ({ name: `big:${i}`, description: null }))];
    await run();
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('Skipped group "big"'));
    expect(octokit.rest.issues.addLabels).toHaveBeenCalled();
    expect(core.setFailed).toHaveBeenCalledWith("1 warning(s); see log.");
  });

  it("only warns on an oversized group without fail-on-warning", async () => {
    repoLabels = [...repoLabels, ...Array.from({ length: 255 }, (_, i) => ({ name: `big:${i}`, description: null }))];
    await run();
    expect(core.warning).toHaveBeenCalled();
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it("ignores unsupported events", async () => {
    context.eventName = "push";
    await run();
    expect(core.notice).toHaveBeenCalled();
    expect(systemOne).not.toHaveBeenCalled();
  });

  it("rejects an invalid threshold", async () => {
    inputs.threshold = "1.5";
    await run();
    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining("threshold"));
  });
});
