# The Foundry Endpoint Problem: flwn-ai and the New Coding Agent

*Status as of October 17, 2026. Findings come from the Microsoft docs page screenshot and the flwn-ai codebase. Anything not verified against a real Foundry endpoint is marked as such.*

---

## 1. The components and how they relate

Two codebases need to talk to the same models.

```
flwn-ai (Python, exists today)          Coding agent (TypeScript, new)
  Planner / Executor / Reviewer           CLI + VS Code extension
  → foundry/client.py                     → Vercel AI SDK + a "provider"
              \                                  /
               \                                /
                ▼                              ▼
                  Azure AI Foundry (your models)
         MAI-Thinking-1, gpt-6-sol, gpt-6-luna, Cohere rerank
```

- **Azure AI Foundry** hosts your model deployments. You get an endpoint, a key, and a deployment name per model.
- **flwn-ai** is the Python backend. All model calls go through `foundry/client.py`.
- **The coding agent** is the new standalone product. It runs its own agent loop locally and calls models directly.
- **Vercel AI SDK** is a TypeScript library that provides one API for streaming, tool calling, and multi-step agent loops across many model vendors. It does not talk to a model by itself. It needs a **provider**, a small adapter for each service.

Both problems below come from the same root: **how to talk to Foundry the right way.**

---

## 2. How Foundry can be called

The Microsoft page lists three routes, which match the names in the Azure portal:

| Portal name | Route on the docs page | Purpose |
|---|---|---|
| `…openai.azure.com/` | OpenAI v1-compatible route (`/openai/v1/`) | Apps that expect the OpenAI API shape |
| `…services.ai.azure.com/` | Foundry endpoint (`/api/`) | Stateless calls such as model inference |
| `…services.ai.azure.com/api/projects/…` | Project endpoint | Stateful APIs: Agents, Evaluations |

There is also an older fourth route, **`/models`** (the Azure AI Inference API), with its own SDK, `azure-ai-inference`. The warning box on the page says:

> Don't use the Foundry Model Inference API (`/models` path) for new integrations. The Azure AI Inference beta SDK retired on August 26, 2026. Use the OpenAI v1-compatible route instead.

Today is October 17, 2026, so that retirement was about seven weeks ago.

---

## 3. Problem A: flwn-ai is built on the retired route

The current code depends on exactly what was retired:

| File | Dependency |
|---|---|
| `requirements.txt` | Pins `azure-ai-inference>=1.0.0b9` |
| `foundry/client.py` | Builds its endpoint by appending `/models`; uses `ChatCompletionsClient` |
| `foundry/client.py` (`rerank`) | Calls `/models/rerank` directly over REST |
| `app/tools/coding_agent.py` | Uses LiteLLM's `azure_ai/` provider, which its own comment says targets the same Inference API shape |

**What is not known:** whether the old route has actually been switched off. The page says not to use it for new work and that the SDK is retired. It does not say the route stopped responding. The code probably still runs, but on an unsupported SDK with no fixes, and it could stop working without warning. This is real technical debt, not necessarily an outage.

**Workarounds that must survive any migration.** `client.py` contains fixes for model quirks:

- `max_tokens` versus `max_completion_tokens` (some deployments accept one, some the other).
- Stripping `<|START_TEXT|>` / `<|END_TEXT|>` from replies.
- Empty replies when `tools` is dropped while the history still contains tool calls (observed on MAI-Thinking-1).
- Forcing a final answer after the tool-round budget is exhausted.

---

## 4. Problem B: the coding agent has no ready-made provider

The Vercel AI SDK itself is fine. The gap is the provider:

- The official Azure provider is designed for OpenAI models on Azure OpenAI, not for arbitrary Foundry models.
- A community "Azure AI" provider exists, but a Vercel forum post described it as immature and not handling `generateObject`. It is likely built on the old Inference API (not verified).
- The practical option is `@ai-sdk/openai-compatible`, pointed at the **OpenAI v1-compatible route** (`https://<resource>.openai.azure.com/openai/v1`).

**Open questions that can only be answered by testing against the real endpoint:**

1. Does the v1 route accept **MAI-Thinking-1** and the `gpt-6-*` models? MAI-Thinking-1 is a Microsoft model, not an OpenAI one, and may only be reachable on another route.
2. Is tool calling reliable on each model? A coding agent depends on it for everything.
3. Does streaming work properly?
4. Do the old quirks (token parameter name, empty replies) still appear?
5. Where does **Cohere rerank** live on the new routes? It is not OpenAI-shaped.

---

## 5. The solution, in order

### Step 1: Run the spike

A small TypeScript script (`foundry-spike/`) tests each model for:

1. Plain streaming
2. A single tool call with a final answer
3. A four-step tool loop (follow a chain of files `a.txt → d.txt`)
4. A non-empty reply under heavy reasoning

It type-checks against `ai@7.0.143` and `@ai-sdk/openai-compatible@3.0.71`. It has **not** been run against a real Foundry endpoint, so the results have to come from running it.

`.env`:

```bash
FOUNDRY_ENDPOINT=https://<resource>.openai.azure.com
FOUNDRY_KEY=<your key>
FOUNDRY_MODELS=MAI-Thinking-1,gpt-6-sol,gpt-6-luna
```

Use the host exactly as shown in the portal, with no path after `azure.com`; the script appends `/openai/v1`. Model names must be your **deployment names**.

Run:

```bash
npm install
npm run spike
```

Quick smoke test before the full spike:

```bash
curl https://<resource>.openai.azure.com/openai/v1/chat/completions \
  -H "api-key: $FOUNDRY_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-6-sol","messages":[{"role":"user","content":"hi"}],"max_completion_tokens":50}'
```

| Result | Likely cause |
|---|---|
| Normal reply | Good, run the full spike |
| 401 / 403 | Key or auth-header problem; try `Authorization: Bearer` instead of `api-key` |
| 404 on the model | Deployment name is wrong |
| Error about `max_tokens` / `max_completion_tokens` | Expected; the spike handles it automatically |

### Step 2: Decide from the results

- **All pass:** build milestone 1 on `@ai-sdk/openai-compatible`.
- **One model fails tool calling:** keep it out of agent roles; use it only for summaries, or choose another model.
- **MAI-Thinking-1 is not reachable on the v1 route:** try the Foundry endpoint (`…services.ai.azure.com/api/`), which may require a custom provider. The AI SDK allows writing one. This is also why the agent loop should depend on your own `ModelProvider` interface rather than on the SDK directly.

### Step 3: Open a separate ticket for flwn-ai

Migrate `foundry/client.py` from `azure-ai-inference` to the `openai` Python SDK, pointed at the same v1 route.

- Keep `structured_chat` and `structured_chat_with_tools` signatures unchanged so no agent has to change.
- Carry the workarounds listed in section 3 over.
- Find the new route for rerank (the migration guide linked from the docs page should say).
- Update the LiteLLM configuration in `coding_agent.py`.
- Remove `azure-ai-inference` from `requirements.txt`.
- Record it in `CONSIDERATIONS.md` as an open item.

### Priority

1. **Spike first.** It decides the coding agent's fate and tells you whether the v1 route works for your models.
2. **flwn-ai migration second.** It is larger, and not urgent as long as the old route still responds.

---

## 6. What is certain and what is not

| Certain (from the screenshot) | Certain (from the code) | Not certain |
|---|---|---|
| The three routes and their purposes | Where flwn-ai depends on the old route | Whether your models work on the v1 route |
| `/models` should not be used for new work | The workarounds `client.py` carries | Where rerank lives now |
| The SDK retirement date, August 26, 2026 | | Whether the old route still responds today |

**Next input needed:** the migration guide linked from the Microsoft page, to pin down exactly what changes in `client.py`.
