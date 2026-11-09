# AGENTS.md - conventions for humans and AI coding agents in this repo

- TypeScript, `strict` on. Node >= 22.12. This matches the runtime requirements
  of the model SDK and Electron tooling, and guarantees `node:sqlite` for durable
  local session history and memory. Electron and current VS Code use Node 24.
- **Model calls only go through `packages/core/src/providers/`.** No other file imports
  `ai` or `@ai-sdk/*`. The agent loop depends on our own `ModelProvider` interface.
- Provider quirks (token param name, empty replies, special tokens) live inside the
  provider adapter, never in the agent loop.
- Model names are Foundry *deployment names* and come from config, never hardcoded.
- No secrets in the repo. `.env` is ignored; keep `.env.example` current.
- Anything that needs Flwn context (memory, ledger, tickets) goes through one gateway
  module, so the integration can change in one place.
- UI changes follow `.agents/skills/flwn-design/SKILL.md`, pinned from the official
  Flwn design repository. Use its tokens and original assets; do not invent colors or logos.
