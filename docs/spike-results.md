# Foundry provider spike: results

Date: 2026-10-22. Route used by `spike.ts`: `https://aif-flwn-fc-01.services.ai.azure.com/openai/v1`.
SDK: ai 7.x, @ai-sdk/openai-compatible 3.x, @ai-sdk/openai 4.x. One run per cell (latencies are noisy).

## smoke.mjs (HTTP status)
All 3 models returned 200 on all 3 routes: A `openai.azure.com/openai/v1`,
B `services.ai.azure.com/openai/v1`, C legacy `/models`.
gpt-6-sol and gpt-6-luna require `max_completion_tokens` (not `max_tokens`).
Finding: the legacy route still works today, so the flwn-ai migration is debt, not an outage.

## spike.ts (4 tests: streaming, single tool call, 4-step tool loop, heavy-reasoning reply)

| Model | chat | chat-none | responses |
|---|---|---|---|
| MAI-Thinking-1 | 4/4 pass | 4/4 pass | 0/4 ("The requested operation is unsupported") |
| gpt-6-sol | 2/4 (tool tests fail) | 4/4 pass | 4/4 pass |
| gpt-6-luna | 2/4 (tool tests fail) | 4/4 pass | 4/4 pass |

gpt-6-* error on `chat`: "Function tools with reasoning_effort are not supported ... use /v1/responses
or set reasoning_effort to 'none'".

## Latency (ms)

| Model [variant] | first chunk | single tool call | 4-step loop |
|---|---|---|---|
| MAI-Thinking-1 [chat] | 7721 | 9251 | 10709 |
| MAI-Thinking-1 [chat-none] | 8376 | 9982 | 15182 |
| gpt-6-sol [chat-none] | 1330 | 3450 | 7615 |
| gpt-6-sol [responses] | 1196 | 4158 | 9489 |
| gpt-6-luna [chat-none] | 1807 | 2108 | 5312 |
| gpt-6-luna [responses] | 1047 | 2050 | 8432 |

## Conclusions
- No custom provider is needed. The per-model API mode is what differs.
- MAI-Thinking-1: chat only, slow (about 8s before the first token): use for planning/review, not the interactive loop.
- gpt-6-sol / gpt-6-luna: fast; use `responses` (reasoning + tools) by default, `chat-none` as fast mode.
- `chat-none` was slightly faster than `responses` in this single run; whether it costs quality on hard coding tasks is untested.
