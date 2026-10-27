# flwn-oqelira

**Oqelira** - the AI coding agent by Flwn. A standalone product (CLI + IDE extension) that
reads the team's context (memory, decision ledger, tickets) from Flwn and helps members
write code instead of writing it manually.

Status: **pre-milestone-1**. We are validating the model-provider layer first.

## Layout

    spikes/foundry-provider/   throwaway tests: which Foundry route/models work (start here)
    docs/                      design notes and decisions
    packages/core/             provider interface, Foundry adapter, agent loop, tools, permissions
    packages/cli/              the `oqelira` command: interactive session + one-shot, approvals, previews
    packages/extension/        (next) VS Code extension - not created yet

## Quick start (Node >= 20.6)

    npm install            # at the repo root (npm workspaces)
    npm test               # 12 mock-server tests, no network needed
    copy .env.example .env # at the repo root; fill FOUNDRY_ENDPOINT / FOUNDRY_KEY (never commit .env)
    npm run live           # real Foundry: streaming + tools, permissions, edit + run

## Use the CLI

    npm run oqelira -- --help                      # from the repo root
    npm run oqelira -- --cwd C:\path\to\project    # interactive session in another project
    npm run oqelira -- "add a unit test for add()"  # one-shot task

    cd packages\cli && npm link                    # optional: gives you a global `oqelira` command

Reads and listing are automatic; every file write/edit shows a preview and asks first
(`y` / `n` / `a` = always this session); shell commands always ask unless `--yolo`.
`--yes` auto-approves writes only. Models: `-m gpt-6-sol` (default), `gpt-6-luna`, `mai-thinking`.
Project rules are read from `OQELIRA.md` or `AGENTS.md` in the project directory.

## Background

1. `cd spikes/foundry-provider` and follow its README.
2. Read `docs/foundry-endpoint-problem.md` for why.
3. Open questions live in `CONSIDERATIONS.md`.
