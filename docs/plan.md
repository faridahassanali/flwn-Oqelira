# Plan

Current scope: standalone **multi-user Azure server** with the shared Web/Desktop
client. Implemented: Better Auth, PostgreSQL persistence, project memory, owner
checks, checkpoint recovery, quotas, Explorer/Git reads and private runner transport.
See `docs/server.md` for tested behavior and explicit remaining product work.
Azure deployment, gVisor/Docker integration and a complete production security
review are pending; do not interpret this as a finished production coding agent.

0. **Spike (done):** results in `docs/spike-results.md`.
1a. **Core slice (done, live-validated 2026-10-23):** `packages/core`.
1b. **CLI (done):** `packages/cli`.
1c. **Web + Desktop (connected local slice):** shared UI in `packages/ui`, Vite web entry,
    sandboxed Electron shell, typed host transport, streamed core events and explicit tool approvals.
    Next: browsable Explorer, Git diff/revert views, persistent sessions and desktop packaging.
    Flwn memory and auth are deferred per current product scope.
1. **Foundation (rest):** monorepo (`packages/core`, `packages/cli`), provider interface + Foundry
   adapter, minimal agent loop (read/edit files, run commands, permission prompts).
2. **Usable CLI:** sessions, diffs, context management.
3. **Backend + auth:** Flwn login, LLM proxy, BYOK mode.
4. **Flwn context:** recall from the data engine, tickets, `check_conflict`.
5. **VS Code extension** over the same core.
6. **ACP mode** for other IDEs.
