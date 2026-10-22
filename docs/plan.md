# Plan

0. **Spike (now):** `spikes/foundry-provider` - smoke.sh, then npm run spike.
1. **Foundation:** monorepo (`packages/core`, `packages/cli`), provider interface + Foundry
   adapter, minimal agent loop (read/edit files, run commands, permission prompts).
2. **Usable CLI:** sessions, diffs, context management.
3. **Backend + auth:** Flwn login, LLM proxy, BYOK mode.
4. **Flwn context:** recall from the data engine, tickets, `check_conflict`.
5. **VS Code extension** over the same core.
6. **ACP mode** for other IDEs.
