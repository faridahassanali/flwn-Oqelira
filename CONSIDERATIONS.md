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

## Open: things the spike did not cover
- Streaming **together with** tools (`streamText` + tool calls). The spike streamed text only and
  ran tools with `generateText`. The real agent streams tool calls; test this before milestone 1 ends.
- Parallel tool calls, large tool outputs, long contexts, request abort/cancel.
- `/responses` storage: set `store: false` explicitly so code is not retained server-side;
  verify the provider default and Azure behavior.
- Pick one route (A `openai.azure.com` is the documented one; the spike ran on B
  `services.ai.azure.com`). Re-run on A before locking config.
- Latency numbers are single runs; repeat before using them for role assignment.

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
