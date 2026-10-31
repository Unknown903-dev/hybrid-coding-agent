# Hybrid Coding Agent — Milestone 1

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

1. JSON task contracts, validation gate and execution logs.
2. Isolated Git worktree creation per task and conflict detection.
3. Automated local delegation from cloud plans and escalation policies.
4. Review checkpoints and model usage budgets.

## Security

This prototype does not hard-enforce per-file scope or protect against all dangerous shell commands. Do not run against production credentials or valuable working trees. Use disposable branches and review all diffs. A model's prompt is not a security boundary.
