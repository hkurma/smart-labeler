# Smart Labeler

A GitHub Action that labels new issues and pull requests with your repository's **existing** labels. It reads the title and body (plus the changed file paths, for PRs) and asks [TypeSafe](https://docs.typesafe.ai)'s Jev model which labels fit.

It never creates or removes labels. It only adds existing ones.

## How it works

Label names are split into a **group** and a name by a separator (default `:`):

| Labels in your repo | How they are judged |
|---|---|
| `type:bug`, `type:feature`, `type:chore` | One question for group `type`: pick one of these, or `none` |
| `priority:high` | Group `priority` with a single label: pick it, or `none` |
| `documentation`, `good first issue` | No separator: each label is judged on its own (yes or no) |

- **At most one label per group** is applied.
- A group is skipped when the issue or PR **already has a label from it**.
- Everything is sent in one TypeSafe request.

A label is applied when the model's probability is at least `threshold`. If more labels pass than `max-labels` allows, the highest-probability ones win.

## Setup

1. Get a TypeSafe API key and add it as the repository secret `TYPESAFE_API_KEY`.
2. Add [`examples/smart-label.yml`](examples/smart-label.yml) as `.github/workflows/smart-label.yml`:

```yaml
name: Smart Label

on:
  issues:
    types: [opened]
  pull_request_target:
    types: [opened]

permissions:
  issues: write
  pull-requests: write

jobs:
  label:
    runs-on: ubuntu-latest
    steps:
      - uses: <owner>/smart-labeler@v1
        with:
          typesafe-api-key: ${{ secrets.TYPESAFE_API_KEY }}
```

**Why `pull_request_target`?** On `pull_request`, PRs from forks get neither secrets nor a write token, so labeling would fail. `pull_request_target` runs in the context of the base repository. That is safe here because this action never checks out or runs the PR's code; it only reads the PR's metadata and file list through the API. Don't add a checkout of the PR head to this job.

## Inputs

| Input | Default | Description |
|---|---|---|
| `typesafe-api-key` | *(required)* | TypeSafe API key. |
| `github-token` | `${{ github.token }}` | Token used to read labels and apply them. |
| `model` | `jev-latest` | TypeSafe System One model. |
| `threshold` | `0.7` | Minimum probability (0–1) for a label to be applied. |
| `max-labels` | `3` | Maximum labels to apply; `0` means unlimited. |
| `group-separator` | `:` | Splits `ui:bug` into group `ui`. Use `/` for `kind/bug` style labels. |
| `dry-run` | `false` | Compute and report labels without applying them. |
| `fail-on-warning` | `false` | Fail the step if any warning was logged. Labels are still applied first. |

## Outputs

| Output | Description |
|---|---|
| `labels` | JSON array of the labels applied (or that would be, under `dry-run`). |
| `scores` | JSON object with `groups` (each group's pick, probability, and whether it was applied; `pick` is `null` for none) and `labels` (each ungrouped label's probability and whether it was applied). |

Each run also writes a job summary with the pick, probability and runner-up for every group, and the probability for every ungrouped label.

## Errors and warnings

- A TypeSafe or GitHub API error fails the step.
- A group with more than 254 labels (the limit for one choice question) is skipped with a warning; everything else still runs. Set `fail-on-warning: true` to turn warnings into a failed step.

## Getting good results

- **Write label descriptions.** The model sees each label's name and description. `type:bug — Something that used to work is broken` gets far better results than a bare name.
- **Group labels that exclude each other.** `priority:high` / `priority:low` belong in one group. Labels that can apply together (`frontend` and `backend`, say) should be ungrouped so each is judged on its own.
- **Tune `threshold` with `dry-run`.** Start with `dry-run: true` and read the job summaries on a few real issues. Raise the threshold if wrong labels get through; lower it if obvious ones are missed.

## Development

```sh
npm ci
npm run typecheck
npm test
npm run build   # bundles to dist/ — commit the result
```

`dist/` must be committed, since GitHub runs `dist/index.js` directly. CI fails if it is out of date.

To try a local run, set the `INPUT_*` and `GITHUB_*` variables the Actions runtime would provide:

```sh
env GITHUB_EVENT_NAME=issues GITHUB_EVENT_PATH=./event.json GITHUB_REPOSITORY=owner/repo \
  "INPUT_TYPESAFE-API-KEY=$TYPESAFE_API_KEY" "INPUT_GITHUB-TOKEN=$(gh auth token)" "INPUT_DRY-RUN=true" \
  node dist/index.js
```

On Git Bash for Windows, prefix with `MSYS_NO_PATHCONV=1` if the separator is `/`.
