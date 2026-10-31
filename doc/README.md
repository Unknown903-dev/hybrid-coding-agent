# Hybrid Coding Agent — Milestone 3A

Starter integrating a **cloud Codex supervisor (read-only planning)** and a **local Ollama worker through Codex CLI**. This is not yet an automatic multi-agent orchestrator. It deliberately requires explicit steps and protects writes by default.

## Prerequisites

- Node.js 20+, Codex CLI installed (`npm i -g @openai/codex`), signed in with `codex login` for cloud tasks
- Ollama installed/running with `ollama pull qwen2.5-coder:7b`
- A target Git repository; start with a disposable demo repository

## Install

```bash
npm install
npm run typecheck
```

## Run (substitute your actual repo path)

```bash
# Cloud supervisor: creates a plan, does not edit files
npm run dev -- plan --project /absolute/path/to/demo-repo --task "Add a utility to format durations"

# Local worker: read-only analysis, no cloud-model usage
npm run dev -- local --project /absolute/path/to/demo-repo --task "Explain where to add duration formatting"

# Local worker: allows changes, use ONLY in a disposable branch/worktree
CONFIRM_LOCAL_EDITS=YES npm run dev -- local --project /absolute/path/to/demo-repo --task "Add a pure duration formatting function with unit tests" --apply
```

Review changes with `git diff` and run your tests yourself. Codex tool approvals, file sandboxing, and model capabilities depend on your CLI/version/OS.

## Next milestones

1. Isolated Git worktree execution and conflict detection.
2. Automated local delegation from cloud plans and escalation policies.
3. Review checkpoints, execution logs, and model usage budgets.

## Security

The proposal workflow hard-enforces a single authorized target and never executes model output, but the older opt-in `local --apply` workflow does not provide that per-file boundary. Do not use write-enabled local mode against production credentials or valuable working trees. Use disposable branches and review all diffs. A model's prompt is not a security boundary.

## Proposal generation

Qwen2.5-Coder 7B may not use Codex CLI tool calling reliably. Use the `propose` command to bypass Codex for small tasks:

```sh
npm run dev -- propose --project . --file src/cli.ts --task "Suggest a small readability improvement without changing behavior"
```

It reads one selected source file (maximum 40 KB), calls Ollama's local `/api/chat`, schema-checks the response, and stores a JSON proposal in `.agent-proposals/`. The proposal contains the task, repository-relative file, model, summary, complete replacement content, claimed checks, and claimed risks. A no-change response contains the original content and is subsequently reported by validation as unchanged.

The command does **not** edit project source files or run commands from model output. The worker is instructed to keep changes task-specific, preserve public behavior and interfaces, avoid formatting churn, and never claim checks passed without supplied results. These instructions reduce noise but are not a security boundary. Proposals are ignored by Git, and this command makes no cloud Codex call.

Note: The selected file is sent to the configured Ollama endpoint. Keep `OLLAMA_URL` pointed to your own trusted local server and don't select sensitive files.

## Validate a proposal

```sh
npm run dev -- validate --project . --proposal .agent-proposals/example.json
```

Validation is read-only. It strictly checks the JSON fields, rejects malformed/empty/unchanged content, and verifies both the proposal and target paths against the real Git repository path. Absolute target paths, traversal, symlink escapes, secrets, dependency/build directories, proposal storage, and lockfiles are rejected. Model-provided summaries, checks, and risks are displayed only as untrusted claims; they are never treated as test evidence.

A valid report means the proposal is structurally well-formed, targets an allowed existing file, and contains a change. It does **not** mean the proposed code is semantically correct, compiles, or passes tests. Suspicious diff findings produce warnings and require human or cloud-supervisor review rather than automatically rejecting every large change.

Diff review thresholds can be adjusted for a command:

```sh
npm run dev -- validate --proposal .agent-proposals/example.json \
  --max-changed-lines 100 --max-changed-ratio 0.4 --formatting-only-lines 20
```

Validation failures include a specific reason and return a nonzero exit code. Common failures are schema errors, an unreadable proposal path, an unsafe or protected target, empty content, or content identical to the current source file.

## Inspect a proposal diff

```sh
npm run dev -- diff --project . --proposal .agent-proposals/example.json
```

This runs the same validation and prints a unified diff with added/removed lines and a changed-line count. It never applies the diff. Large or broad changes and large whitespace-only rewrites are flagged for review using configurable thresholds. A rejected proposal or an inability to generate its diff returns a nonzero exit code.

## Current limitations

- Validation establishes structure and filesystem safety, not intent or semantic correctness.
- Formatting-only detection compares non-whitespace content and is intentionally heuristic.
- Diff size is a review signal; task-to-diff relevance still requires a human or supervisor.
- The validator does not run model-proposed commands, compilers, linters, or tests.
- There is no automatic proposal application, isolated worktree execution, or cloud escalation in this milestone.
- Each proposal targets one existing regular file; file creation, deletion, and multi-file proposals are not supported.

Run project checks with:

```sh
npm run typecheck
npm test
```
