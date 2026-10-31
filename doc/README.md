# Hybrid Coding Agent — Milestone 6B

This project connects a **read-only Cloud Codex supervisor**, a direct **local Ollama proposal/repair worker**, and a **TypeScript policy and execution orchestrator**. Milestone 6A provides one explicitly authorized end-to-end command for a single eligible existing-file task; Milestone 6B adds explicit human approval and controlled application of the exact reviewed patch. It does not schedule multiple tasks, commit, push, merge, deploy, or perform cloud coding.

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
# Cloud supervisor: explicit cloud authorization, read-only structured plan
npm run dev -- supervisor plan --project /absolute/path/to/demo-repo \
  --task "Add a utility to format durations" --allow-cloud

# Local worker: read-only analysis, no cloud-model usage
npm run dev -- local --project /absolute/path/to/demo-repo --task "Explain where to add duration formatting"

# Local worker: allows changes, use ONLY in a disposable branch/worktree
CONFIRM_LOCAL_EDITS=YES npm run dev -- local --project /absolute/path/to/demo-repo --task "Add a pure duration formatting function with unit tests" --apply
```

Review changes with `git diff` and run your tests yourself. Codex tool approvals, file sandboxing, and model capabilities depend on your CLI/version/OS.

## End-to-end orchestration

```sh
npm run dev -- run \
  --project /absolute/path/to/disposable-repository \
  --task "Fix the calculator addition bug" \
  --allow-cloud \
  --apply
```

The `run` command performs one bounded lifecycle:

1. Verifies the Git repository has a `HEAD` commit and no tracked index or working-tree changes.
2. Uses the shared Cloud Codex call budget to obtain and validate a grounded plan.
3. Requires exactly one deterministically local-eligible task targeting one existing file tracked at `HEAD`.
4. Sends a bounded task and that authorized file to Ollama's direct HTTP API.
5. Validates the strict proposal schema, target path, and SHA-256 source digest.
6. Applies the proposal in one owned detached worktree, runs trusted checks, and requests bounded local repair only after a failed check.
7. Saves the final patch and repair report before worktree cleanup.
8. Uses the same cloud budget for a read-only supervisor review, then stops for human review.

Available flags are:

- `--model <name>`: local Ollama proposal and repair model; defaults to `LOCAL_MODEL` or `qwen2.5-coder:7b`.
- `--cloud-model <name>`: exact requested Codex supervisor model; no silent substitution.
- `--max-retries <0-5>`: local repair attempts after the initial proposal.
- `--max-cloud-calls <0-20>`: total planning plus review calls; the default is two.
- `--keep-worktree`: preserve the owned execution worktree for inspection.
- `--dry-run`: perform grounded planning and task selection without contacting Ollama, creating a worktree, running checks, or requesting final cloud review.

Normal execution requires both `--allow-cloud` and `--apply`. A non-dry run without either authorization stops before any model call. There is no fallback to cloud coding when local generation, execution, or repair fails.

### Orchestration reports and recovery

Each run atomically maintains `.agent-runs/<run-id>-orchestration.json`. Its versioned schema records lifecycle transitions, plan/task/proposal/report/patch/review references, requested models, shared cloud-call counts, SDK token usage when reported, validation outcomes, review status, failure details, and the permanent human-approval requirement. Unknown token usage is stored as `null`, not fabricated as zero.

Successful automated checks produce a reviewable patch, not an approved or merged change. If final cloud review fails or the remaining call budget is exhausted, the patch is retained and the state remains `awaiting_cloud_review`. Unsupported plans become `blocked`; unsafe proposals, stale digests, missing `HEAD`, dirty tracked state, execution failures without reviewable artifacts, and other terminal errors become `failed`. Repair failures retain diagnostics and a patch when one can be safely generated.

State and artifacts can be inspected with normal JSON and diff tools:

```sh
cat .agent-runs/<run-id>-orchestration.json
git apply --stat .agent-runs/<execution-task-id>.patch
```

### Inspect, approve, and integrate a patch

Inspection is read-only and prints the original request, authorized file, diff counts, complete patch, validation outcome, Cloud review, warnings, usage, patch SHA-256, and approval eligibility:

```sh
npm run dev -- run inspect --project /path/to/repository --run-id <run-id>
```

Approval requires either typing `approve` at an interactive terminal or passing the explicit `--yes` flag:

```sh
npm run dev -- run approve --project /path/to/repository --run-id <run-id> --yes
```

Approval requires passing trusted checks and a `ready_for_human_review` review artifact. It revalidates the run, execution report, review, protected path, original source digest, and patch applicability. It records the exact patch hash, repository identity, `HEAD`, source digest, artifact hashes, timestamp, and authorization method under `.agent-state/approvals/`. Approval does not modify source and remains a human decision—not proof of correctness.

Apply that exact approved patch to the original working tree with:

```sh
npm run dev -- run integrate --project /path/to/repository --run-id <run-id>
```

Integration verifies the signed approval, artifact hashes, patch hash, repository identity, unchanged `HEAD`, clean tracked working tree/index, unchanged target digest, protected-path policy, exact one-file scope, and `git apply --check`. It acquires the same per-target lock as worktree execution, applies without shell interpolation, then requires the resulting working-tree diff to exactly equal the approved patch. It creates no commit and performs no merge, push, or deployment.

The original authorized file is buffered before application. If application or post-application verification fails, the coordinator restores that file and records a failed integration audit. Successful and failed audit records are separately HMAC-signed under `.agent-state/integrations/`; a successful run cannot be integrated twice.

#### Local integrity threat model

The signing key is a random, mode-`0600` local key under `.agent-state/`. Approval and audit records are HMAC-bound to it, while `.agent-state` and its subdirectories are rejected if they are symlinks and are excluded from supervisor/local-worker file scope. This prevents approval by merely editing a JSON report or patch and detects post-approval artifact changes.

This is a local single-user integrity mechanism, not a defense against the repository owner, root, malware, filesystem rollback, or an attacker with the same OS account and access to the signing key. Deleting the key invalidates existing approvals; deleting signed audits can erase local history. For stronger assurance, protect the repository and key with OS access controls or an external signing/audit system.

### Disposable-repository test

Create a disposable Git repository with an initial commit, one existing source file, and trusted validation configuration. Ensure Ollama is running locally and Codex is signed in, then run the command above. Confirm the original file and `HEAD` are unchanged, inspect the saved patch/report, and manually remove any intentionally preserved worktree. Tests and compilers execute repository code: use a container or VM for repositories you do not trust.

## Architecture and security boundaries

- Cloud Codex performs read-only structured planning and review through the SDK with explicit authorization.
- Ollama receives one authorized source file and returns untrusted structured proposal or repair content. Ollama calls do not count against the cloud budget.
- The TypeScript orchestrator owns path authorization, deterministic routing, source digests, trusted commands, retries, locks, worktrees, reports, and approvals.
- Repository files, LLM output, check logs, patches, and saved reports are all treated as untrusted data.
- Model output cannot choose commands, add permissions, expand file scope, or trigger a deployment or Git integration action.
- Git worktrees isolate source-control state but are not an OS sandbox. Trusted checks may execute repository code with the current user's OS permissions.

## Next milestones

1. Multi-task scheduling and dependency coordination.
2. Separately authorized commit, merge, or remote integration workflows.

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

## Cloud Codex supervisor

The supervisor is a read-only planning and review layer built with the official `@openai/codex-sdk`. It uses the user's existing Codex sign-in and configuration; it does not require or save a separate OpenAI API key and does not modify global Codex configuration. SDK calls start threads with:

- `sandboxMode: "read-only"`;
- `approvalPolicy: "never"`;
- agent network access and web search disabled;
- per-request deny rules for repository `.env*`, credential files, and agent-artifact directories;
- a restricted child-process environment.

The default Codex model is intentionally omitted so the user's available configured default is used. An optional `--cloud-model` is passed through exactly as requested. If that model is unavailable or unauthorized, the request fails and is recorded; the orchestrator never silently upgrades, substitutes, or retries with a more expensive model.

Cloud supervisor operations never call `execute`, `repair`, Ollama, deployment tools, Git commit, merge, or push. They may write only sanitized plans, reviews, and usage records under `.agent-runs/`.

### Structured planning

```sh
npm run dev -- supervisor plan \
  --project /path/to/repository \
  --task "Add employee labor-hour charts" \
  --allow-cloud \
  --max-tasks 8 \
  --max-cloud-calls 2
```

Before any planning request, the orchestrator obtains tracked and non-ignored untracked paths with `git ls-files`, then verifies every candidate with `lstat` and `realpath`. Symlinks, escaping paths, protected/secret paths, oversized files, and non-regular files are excluded. The resulting inventory and bounded, redacted source excerpts are included as untrusted planning context. File count, path characters, per-file content, total content, and individual file size all have hard limits; large repositories therefore produce a deliberately truncated inventory.

The cloud response must match a strict versioned Zod schema. Tasks include IDs, ordered dependencies, operation type, explicit relative file scope, acceptance criteria, risk, complexity, proposed executor, routing explanation, and validation requirements. Unknown or circular dependencies and out-of-order plans are rejected. Plans also record whether repository context was sufficient. When the relevant file is not in the selectable inventory, the supervisor must return `context_status: "insufficient"` with no implementation tasks instead of inventing a path.

Cloud routing recommendations are advisory. A deterministic policy overrides them when necessary:

- only simple low-risk, one-existing-file modifications are directly local-eligible;
- bounded moderate work needs one file, at least two acceptance criteria, and explicit validation;
- complex, multi-file, create/delete, protected-path, or missing-file tasks route to cloud/human handling;
- security, authentication, authorization, billing, migration, deployment, infrastructure, public-API, production, credential, and data-loss work routes to cloud/human handling.

For `modify_existing` and `delete`, every model-selected path must exactly match a path in the verified inventory. Absolute paths, traversal, protected paths, symlink escapes, and nonexistent or inventory-truncated paths are rejected; the orchestrator never rewrites a bad path to a guessed alternative. Genuine `create` tasks may name a new safe relative path, but deterministic routing marks them ineligible for the current local worker and keeps them for cloud/human handling only.

The current local worker still supports exactly one existing safe regular file per task.

The legacy `plan` command remains as an alias for structured supervisor planning, but now requires the same `--allow-cloud` authorization.

### Inspect a saved plan without cloud usage

```sh
npm run dev -- supervisor inspect \
  --project /path/to/repository \
  --plan .agent-runs/<plan-id>-supervisor-plan.json
```

`inspect` rebuilds the bounded repository inventory and performs schema, dependency, grounded file-scope, and deterministic routing checks locally. It never contacts Codex and does not require `--allow-cloud`. Plan paths must resolve to regular non-symlink JSON files inside the repository's `.agent-runs/` directory. A repository change or a different bounded inventory can therefore invalidate a previously saved existing-file plan.

### Review a local run

```sh
npm run dev -- supervisor review \
  --project /path/to/repository \
  --report .agent-runs/<task-id>-repair.json \
  --allow-cloud
```

Review requires a bounded local report and the matching `.agent-runs/<task-id>.patch`. The patch is checked against the report's authorized file before forwarding. Only a sanitized report summary and bounded/redacted patch are sent; paths embedded in reports are not trusted. Missing, malformed, oversized, symlinked, escaping, or multi-file artifacts are rejected before a cloud call.

Review output separates structural validity, trusted-check results, semantic relevance, security findings, remaining risk, and required human approval. Verdicts are:

- `ready_for_human_review`;
- `retry_local`;
- `cloud_escalation_recommended`;
- `rejected`.

Deterministic policy prevents a failed or structurally invalid local run from being marked ready merely because the model recommends it. Reviews never apply patches.

### Cloud authorization and usage

Cloud calls require either the explicit `--allow-cloud` flag or `SUPERVISOR_CLOUD_ENABLED=YES`. Local `supervisor inspect` needs neither. The default call budget is two per usage manager and can be lowered with `--max-cloud-calls`; exhausted or disabled budgets stop before invoking the adapter.

Usage records are stored as uniquely named `.agent-runs/<task-id>-<run-id>-supervisor-usage.json` files and include operation, timestamp, success/failure, requested or reported model when known, and token counts returned by the SDK when available. Missing usage stays unknown. The project does not estimate dollar cost, subscription quota, or remaining plan capacity.

Cloud-hosted inference may consume OpenAI-hosted usage and requires Codex authentication. Ollama proposal/repair inference stays on the configured local Ollama endpoint and does not consume a supervisor call budget. Redaction is best effort and cannot guarantee removal of every secret; keep credentials out of repositories, patches, and logs.

## Current limitations

- Validation establishes structure and filesystem safety, not intent or semantic correctness.
- Formatting-only detection compares non-whitespace content and is intentionally heuristic.
- Diff size is a review signal; task-to-diff relevance still requires a human or supervisor.
- The validator does not run model-proposed commands, compilers, linters, or tests.
- Execution supports one existing file and trusted checks; it does not merge accepted changes back into the original tree.
- Each proposal targets one existing regular file; file creation, deletion, and multi-file proposals are not supported.
- A process crash may leave an owned worktree or lock for manual inspection; the executor never prunes unknown worktrees or guesses that another process is dead.
- Supervisor planning and review remain read-only. The explicitly authorized `run` workflow coordinates one local task but never performs cloud takeover, merging, or deployment.
- The bounded inventory is intentionally incomplete in very large repositories. If the needed file is omitted, planning reports insufficient context rather than searching outside the allowed context or guessing a path.
- Source redaction is best effort. The inventory excludes conventional secret locations and credential file types, but repositories should not contain secrets under misleading ordinary source-file names.
- End-to-end orchestration supports exactly one dependency-free existing-file task. Multi-task plans and create/delete work are saved and blocked rather than partially executed.
- A Cloud review verdict is advisory. It never starts another repair loop, cloud coding task, merge, commit, push, or deployment.
- Approval/integration currently supports the same single existing text file as Milestone 6A; binary, mode-changing, rename, creation, and deletion patches are rejected.
- Integration intentionally leaves the approved change unstaged in the original working tree for manual review and commit.
- Git patch application plus in-process restoration prevents partial-file results during handled failures. An uncatchable process termination or machine failure can still leave the complete approved working-tree diff without a final audit; inspect `git diff` and the local audit directory before retrying.

Run project checks with:

```sh
npm run typecheck
npm test
```
