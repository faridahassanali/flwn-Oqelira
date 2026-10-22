# AGENTS.md - conventions for humans and AI coding agents in this repo

- TypeScript, `strict` on. Node >= 20.6.
- **Model calls only go through `packages/core/src/providers/`.** No other file imports
  `ai` or `@ai-sdk/*`. The agent loop depends on our own `ModelProvider` interface.
- Provider quirks (token param name, empty replies, special tokens) live inside the
  provider adapter, never in the agent loop.
- Model names are Foundry *deployment names* and come from config, never hardcoded.
- No secrets in the repo. `.env` is ignored; keep `.env.example` current.
- Anything that needs Flwn context (memory, ledger, tickets) goes through one gateway
  module, so the integration can change in one place.
