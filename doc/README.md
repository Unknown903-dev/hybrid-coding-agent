# Hybrid Coding Agent — Milestone 4

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

1. Cloud supervisor escalation and review checkpoints.
2. Automated task scheduling and model usage budgets.

## Security

The proposal workflow hard-enforces a single authorized target and never executes model-supplied command strings. Automated checks may execute the proposed repository code, subject to the trust boundary documented below. The older opt-in `local --apply` workflow does not provide the proposal executor's per-file boundary. Do not use write-enabled local mode against production credentials or valuable working trees. A model's prompt is not a security boundary.

## Proposal generation

Qwen2.5-Coder 7B may not use Codex CLI tool calling reliably. Use the `propose` command to bypass Codex for small tasks:

```sh
npm run dev -- propose --project . --file src/cli.ts --task "Suggest a small readability improvement without changing behavior"
```

It reads one selected source file (maximum 40 KB), calls Ollama's local `/api/chat`, schema-checks the response, and stores a JSON proposal in `.agent-proposals/`. The proposal contains the task, repository-relative file, model, summary, complete replacement content, claimed checks and risks, and a SHA-256 digest of the source version used for generation. A no-change response contains the original content and is subsequently reported by validation as unchanged.

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

## Execute in an isolated worktree

Execution requires explicit authorization and never writes the proposal into the original working tree:

```sh
npm run dev -- execute --project . --proposal .agent-proposals/example.json --apply
```

The executor revalidates the proposal, requires its `original_sha256` to match the current source, acquires a per-target concurrency lock, and creates a unique detached worktree under `.agent-worktrees/` at the current `HEAD`. It verifies the checked-out file has the same digest, revalidates immediately before writing, applies only the authorized file, runs trusted checks, writes a report under `.agent-runs/`, and removes its worktree.

Legacy proposals without `original_sha256` remain usable with `validate` and `diff`, but cannot be executed. Regenerate them with `propose`. Execution creates no branch or commit and never merges, pushes, deploys, or changes the original source file.

Preserve the isolated worktree for inspection with:

```sh
npm run dev -- execute --proposal .agent-proposals/example.json --apply --keep-worktree
```

Only the unique worktree created and tracked by the current run is eligible for cleanup. User-created worktrees are never pruned or removed. Repository Git hooks are disabled for system worktree creation and removal. A preserved worktree remains registered with Git and must be removed manually after inspection.

## Trusted validation commands

By default, conventional `typecheck`, `lint`, and `test` package scripts enable fixed direct invocations of locally installed `tsc`, `eslint`, and `vitest`. Missing checks are not silently successful: if no trusted command is available, execution fails with checks marked `skipped`.

Repository owners can instead define exact commands in `.agent-validation.json`:

```json
{
  "commands": [
    {
      "name": "typecheck",
      "executable": "/absolute/trusted/path/to/tsc",
      "args": ["--noEmit"],
      "timeout_ms": 120000,
      "max_output_bytes": 1000000
    }
  ]
}
```

This file is trusted operator configuration and protected from proposal application. Commands are spawned directly with argument arrays and no orchestrator shell interpolation. Proposal checks, summaries, risks, source comments, and other model output can never select executables or arguments. Timeout, output truncation, spawn error, nonzero exit, or skipped checks prevent a successful report.

## Execution reports and trust boundary

Each `.agent-runs/<task-id>.json` report records the task/model/file, worktree and cleanup state, diff summary, structural validation, application/staleness state, command arguments, bounded stdout/stderr, exit codes, timeouts, final status, and errors. It separately labels structural safety, automated compilation/test results, and mandatory human or cloud-supervisor review. Passing checks does not prove semantic correctness or authorize merging.

Git worktrees provide source-control separation, not a security sandbox. Tests and compilers execute repository code with the current OS user's permissions and may access the filesystem, network, processes, or credentials available outside the restricted environment variables passed by the orchestrator. Run untrusted repositories only inside a stronger container or VM. This milestone does not install dependencies or perform cloud escalation.

## Bounded local repair workflow

The `repair` command runs an initial proposal and, when trusted checks fail, gives a sanitized failure summary and the current authorized source back to the configured local Ollama model. A corrected proposal is strictly validated and applied in the same detached worktree before checks run again:

```sh
npm run dev -- repair \
  --project . \
  --proposal .agent-proposals/example.json \
  --apply \
  --max-retries 2
```

`--apply` is mandatory. Without explicit authorization the coordinator does not create a worktree, execute checks, or contact Ollama. The default is two repair attempts after the initial attempt; the CLI accepts zero through five. A total time budget is also enforced and can be shortened with `--time-budget-ms`.

Each repair cycle:

1. Revalidates the initial proposal, protected path, and source digest.
2. Acquires the same per-target lock used by `execute` and creates one owned detached worktree.
3. Applies only the authorized file and runs configured trusted checks.
4. Captures bounded, redacted diagnostics, modified-file names, and a diff summary.
5. Requests a complete corrected file from local Ollama—never commands or additional paths.
6. Wraps the response in the strict proposal schema, validates it against the current worktree content, and verifies that the file did not change unexpectedly.
7. Repeats until checks pass or a bounded stop condition is reached.

The coordinator stops early for stale content, protected or unauthorized files, repeated identical proposals, repeated ineffective formatting-only changes with the same error, repeated malformed responses, unexpected check-generated source changes, concurrent execution, timeout, total-budget exhaustion, or retry exhaustion. Failures recommend cloud escalation in the report, but this milestone never contacts a cloud model automatically.

Preserve the repair worktree for debugging with:

```sh
npm run dev -- repair --proposal .agent-proposals/example.json --apply --keep-worktree
```

Otherwise only the worktree created by that repair run is removed. User-created worktrees are never pruned or guessed to be stale.

## Repair diagnostics and artifacts

Repair reports are stored as `.agent-runs/<task-id>-repair.json`. They contain attempt number and duration, proposal hash and validity, sanitized model response, checks and exit codes, bounded/redacted output, error fingerprint, modified files, diff summary, retry count, stop reason, and cleanup state. The report separately records proposal validity, automated checks, required semantic review, and whether cloud escalation is recommended.

The final worktree diff is saved as `.agent-runs/<task-id>.patch` before cleanup, including on recoverable failures where a diff exists. Inspect it with any normal patch or diff viewer. A passing report means only that the configured trusted checks passed; it does not prove task correctness or authorize a commit, merge, push, or deployment.

Diagnostics forwarded to Ollama are restricted to the authorized file, failed check names and exit codes, bounded stdout/stderr, modified-file names, and diff counts. Common credential/token patterns are redacted. This is a best-effort leak-reduction measure, not a substitute for keeping secrets out of source and test output.

## Current limitations

- Validation establishes structure and filesystem safety, not intent or semantic correctness.
- Formatting-only detection compares non-whitespace content and is intentionally heuristic.
- Diff size is a review signal; task-to-diff relevance still requires a human or supervisor.
- The validator does not run model-proposed commands, compilers, linters, or tests.
- Execution supports one existing file and trusted checks; it does not merge accepted changes back into the original tree.
- Each proposal targets one existing regular file; file creation, deletion, and multi-file proposals are not supported.
- A process crash may leave an owned worktree or lock for manual inspection; the executor never prunes unknown worktrees or guesses that another process is dead.
- Repair uses the local Ollama endpoint only. It does not implement cloud supervision, autonomous scheduling, automatic merging, or deployment.

Run project checks with:

```sh
npm run typecheck
npm test
```
