# flwn-oqelira

**Oqelira** - the AI coding agent by Flwn. A standalone product (CLI + IDE extension) that
reads the team's context (memory, decision ledger, tickets) from Flwn and helps members
write code instead of writing it manually.

Status: **connected local mode plus an implemented multi-user server mode**.
Server mode adds standalone accounts, PostgreSQL conversations and project memory,
tenant-scoped APIs, and isolated runner transport. Azure deployment and container
isolation validation remain pending. Flwn integration remains separate.

## Multi-user server

See [server setup, capabilities and limits](docs/server.md) and the
[Azure deployment runbook](deploy/azure/README.md). Foundry is called through the
existing Vercel AI SDK provider; `npm run foundry:check` checks the real connection.
The local mode below remains a separate development option without cloud accounts.

## Web and Desktop

    npm install
    npm run web          # build and serve connected UI at http://127.0.0.1:4317
    npm run build        # production web bundle
    npm run desktop      # build shared renderer and launch Electron
    npm run typecheck    # all TypeScript workspaces

`packages/ui` owns the shared responsive workspace, pastel theme, conversation,
tool activity, tasks and context/files panels. `packages/web` bundles it with Vite;
`packages/host` serves that bundle and runs the existing core on loopback only.
Electron starts its own host on a free port and loads the same renderer with
sandboxing and context isolation enabled and Node integration disabled.

Configure `FOUNDRY_KEY` and `FOUNDRY_ENDPOINT` in the root `.env` before starting.
Provider keys stay in the host. The UI selects models from the host registry;
override it with `OQELIRA_MODELS_JSON` (see `.env.example`).
Set `OQELIRA_WORKSPACE` to choose a project; it is fixed for the life of the host.
The default workspace is this repository. `OQELIRA_PORT` overrides the browser port.

Chat replies and tool calls stream from core. Reads run automatically; each write,
edit or shell command requires an explicit Allow once / Deny decision in the UI.
Approval requests expire after two minutes. Stop/disconnect cancels the active run
and denies outstanding approvals. Already approved changes are not rolled back.
The host retains completed conversation history in memory for multi-turn tasks.
New session or refresh starts a new conversation; restarting the host loses history.
After an interrupted/failed run, the next request starts a fresh host conversation.

Terminal shows command activity; Files lists successful write/edit tool paths for the
current UI session (not a full Git diff). Browsable Explorer, Git diff/revert views,
session persistence and installers are still pending. This is a local single-user
development app, not a public server or packaged desktop distribution.
See [the architecture and next tasks](docs/architecture.md).
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
    packages/host/             local HTTP host, core runs and approval lifecycle
    packages/protocol/         shared browser-safe transport contracts
    packages/extension/        (next) VS Code extension - not created yet

## Quick start (Node >= 20.6)

    npm install            # at the repo root (npm workspaces)
    npm test               # core, CLI and host tests; local mock servers only
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
