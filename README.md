# flwn-oqelira

**Oqelira** - the AI coding agent by Flwn. A standalone product (CLI + IDE extension) that
reads the team's context (memory, decision ledger, tickets) from Flwn and helps members
write code instead of writing it manually.

Status: **core + CLI foundation; Web and Desktop UI preview**. Flwn memory and auth are deferred.

## Web and Desktop

    npm install
    npm run web          # local Vite preview
    npm run build        # production web bundle
    npm run desktop      # build shared renderer and launch Electron
    npm run typecheck    # all TypeScript workspaces

`packages/ui` owns the shared responsive workspace, pastel visual theme, conversation,
preview tasks and context/files panels. `packages/web` mounts it with Vite;
`packages/desktop` loads that exact built renderer in a sandboxed Electron window
with Node integration disabled. No provider keys are exposed to either renderer.

This first slice is an **in-memory interactive preview**, not a connected coding agent.
Messages add preview tasks; no model requests, filesystem access, shell commands or
Git actions run from the UI. Refreshing or creating a new session clears preview data.
Explorer, Terminal, Git and Settings explain their pending host integration.
Next: a typed host transport to core with streamed events and approval handling.
All model calls must remain in `packages/core/src/providers/`. Flwn memory and auth
remain deferred; future Flwn integrations must use one gateway.

## Layout

    spikes/foundry-provider/   throwaway tests: which Foundry route/models work (start here)
    docs/                      design notes and decisions
    packages/core/             provider interface, Foundry adapter, agent loop, tools, permissions
    packages/cli/              the `oqelira` command: interactive session + one-shot, approvals, previews
    packages/ui/               shared Web + Desktop workspace UI
    packages/web/              Vite browser entry point
    packages/desktop/          sandboxed Electron shell
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
