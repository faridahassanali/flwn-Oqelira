# Considerations - open questions and decisions

## Decided
- TypeScript core; CLI and VS Code extension are thin shells over it.
- Agent loop runs locally on the developer's machine; tools execute locally.
- Vercel AI SDK (`ai`) + `@ai-sdk/openai-compatible`, wrapped behind our own provider interface.
- Start with Azure AI Foundry only; add providers later behind the same interface.

## Decided: Foundry route and per-model API mode (spike, 2026-10-22)
All three models answer on the OpenAI v1-compatible route, so `@ai-sdk/openai-compatible` /
`@ai-sdk/openai` are enough; no custom provider is needed. But the *API mode* differs per model:

| Model | Works with tools on | Fails on | Latency (first token / 4-step loop) |
|---|---|---|---|
| MAI-Thinking-1 | `/chat/completions` | `/responses` ("operation unsupported") | ~8s / 11-15s |
| gpt-6-sol | `/responses`, or `/chat/completions` + `reasoning_effort=none` | `/chat/completions` with default reasoning | ~1.2-1.4s / 7.6-9.5s |
| gpt-6-luna | `/responses`, or `/chat/completions` + `reasoning_effort=none` | `/chat/completions` with default reasoning | ~1.0-1.8s / 5.3-8.4s |

Decision: the model registry carries an `api: 'chat' | 'responses'` field (and optional
`reasoningEffort`) per model. MAI-Thinking-1 -> chat. gpt-6-* -> responses (keeps reasoning
with tools); `chat-none` is the fallback / fast mode. The agent loop never knows which.
Details: `docs/spike-results.md`.

## Done: validated on real Foundry (2026-10-23, Windows)
`npm run live` passed 12/12 (3 models x 4 scenarios) on `openai.azure.com/openai/v1`: streaming + tools
together (incl. `/responses` for gpt-6-*), approved write, denied write (no retry loop), edit + run_command.
The Foundry provider question is closed. Remaining items below are hardening, not blockers.

## Done: CLI (`packages/cli`)
Interactive session + one-shot, streaming output, tool call trace, write/edit previews (- / +) with
y/n/always approval, `--yes` (writes only) and `--yolo`, history across turns, `/model` `/clear` `/exit`,
Ctrl+C interrupt, project rules from OQELIRA.md / AGENTS.md. 13 tests drive the real binary against a mock model.

## Not built yet (be explicit about these)
- **Flwn context** (memory recall, decision ledger, tickets): the product's differentiator. Plan: a `recall_context`
  tool that mints a workspace token at the data engine (`/auth/tokens`) and calls `memory_recall` over `/mcp`,
  the same way `flwn-ai/agents/memory_steward/mcp_link.py` does. `check_conflict` needs an endpoint in flwn-ai.
- **VS Code extension**, **ACP mode**, **backend / login / team-managed keys**.

## Open: validate on real Foundry (remaining hardening)
`packages/core` has the provider interface, registry, Foundry adapter, agent loop, tools and permissions.
12 mock-server tests pass (streamed text, streamed tool-call args, max_tokens fallback, multi-turn shape,
permissions, workspace/symlink confinement, edit_file, run_command env scrubbing, maxSteps).
Still unverified until `npm run live` is run against Foundry:
- **Streaming together with tools** on each model, especially `/responses` (the mock only speaks chat completions).
- Edit + run_command flow driven by a real model.
- Parallel tool calls, large tool outputs, long contexts, abort/cancel.
- `/responses` runs with `store: false` (set in the adapter). Because we drop reasoning items between steps,
  the model re-reasons every step; check whether that costs latency/quality on long tasks.
- Pick one route (A `openai.azure.com` is the documented one; the spike ran on B `services.ai.azure.com`).
- Latency numbers are single runs.
- Tests were run on Linux; confirm on Windows (shell quoting in the run_command test, symlink test skips without privilege).

## Open: flwn-ai still depends on the retired route
`foundry/client.py`, `requirements.txt`, rerank, and `app/tools/coding_agent.py` (LiteLLM
`azure_ai/`). Needs its own ticket in the flwn-ai repo. Rerank's new route is unknown.

## Open: conflict checks
`check_conflict` logic lives in flwn-ai (Decision Ledger). Either expose a small endpoint
there or reimplement here. Memory `recall` can use the data engine's `/mcp` directly.

## Open: auth and key custody
Team-managed keys behind our backend proxy vs BYOK in the OS keychain. Plan to support both.

## Open: IDE coverage
CLI works in any IDE terminal. ACP (Agent Client Protocol) for deeper integration -
verify current support before committing.
