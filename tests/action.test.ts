import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

const manifestPath = new URL("../action.yml", import.meta.url);

describe("action.yml", () => {
  // GitHub fails to load the action at all if the manifest isn't valid YAML.
  const manifest = YAML.parse(readFileSync(manifestPath, "utf8"));

  it("runs the bundled entry point on node24", () => {
    expect(manifest.runs).toEqual({ using: "node24", main: "dist/index.js" });
  });

  it("declares exactly the inputs src/config.ts reads", () => {
    expect(Object.keys(manifest.inputs).sort()).toEqual(
      [
        "typesafe-api-key",
        "github-token",
        "model",
        "threshold",
        "max-labels",
        "group-separator",
        "dry-run",
        "fail-on-warning",
      ].sort(),
    );
  });

  it("declares the outputs src/main.ts sets", () => {
    expect(Object.keys(manifest.outputs).sort()).toEqual(["labels", "scores"]);
  });
});
