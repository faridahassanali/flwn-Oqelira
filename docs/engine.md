# Engine architecture: the CLI is the product

The engine owns config, providers, tools, memory, rules, permissions, history, limits and
compaction. Every surface is an interface to it: the terminal CLI, the web host, the desktop app
and the VS Code extension render events and send requests, nothing else.

Packages:

- `@oqelira/engine` - headless. `oqelira-engine` speaks the protocol on stdio. No terminal UI.
- `@oqelira/cli` - the `oqelira` terminal interface (prompt, colors, approvals). Depends on the engine.
- `@oqelira/host` and the VS Code extension depend on the engine only.

Installing the CLI installs the engine and the terminal interface. Installing the host or the
extension installs the engine, never the terminal interface. Installing the CLI installs neither
the host nor the extension. `packages/engine/test/isolation.test.ts` enforces this.

```
 Web UI ──HTTP──▶ host ──┐
 VS Code ext ────────────┼─ stdio NDJSON ─▶ oqelira-engine
 oqelira (terminal CLI) ─┘  (in-process)         │
                                                ▼
                                   core: providers · tools · memory
```

## Protocol (`packages/protocol`, `ENGINE_PROTOCOL = 1`)

Newline-delimited JSON. Requests in: `hello`, `run`, `approval`, `cancel`, `clear`.
Messages out: `ready`, then `HostEvent`s (`started`, `text`, `tool-call`, `tool-result`,
`approval`, `context-compacted`, `notice`, `done`, `error`) and `cleared`.
stdout carries protocol only; diagnostics go to stderr. Credentials travel in the engine's
environment, never in a message. Approvals fail closed: unanswered, cancelled, or stdin closed = denied.

## Sessions and context

Every session is stored by the engine in SQLite at `~/.oqelira/projects/<hash of project path>/sessions.sqlite`
(0600; outside the repo). `OQELIRA_HOME` moves that root; it is read from the real environment before any
`.env` loads, so a project cannot redirect it.

- `messages`: the full history, append-only, one row per message, credentials redacted before storage.
- `context_snapshots`: the latest compact version (a model-written summary plus `covers_through`, the number
  of leading messages it replaces). Versions are kept.
- Rows carry UUIDs, a `content_hash`, `device_id` and a nullable `synced_at`, so syncing later is a plain copy.

When a request grows past `--context-chars` (default 80000), the engine folds older whole turns into a new
snapshot (one extra model call) and sends `summary + recent turns`. If the summary call fails it falls back to
truncated excerpts, so a run never dies on compaction. On resume the saved snapshot is used as-is, and the
protocol's `sessions` and `history` requests return the list and the full transcript for display.
After the step limit the engine continues by itself up to `--max-continues` times (default 3).

## Automatic project memory

When a session ends (`/exit`, `/clear`, end of a one-shot, a protocol `end` request, or the interface closing
the engine's stdin) the engine asks the model for up to five durable facts from the messages not yet mined
(decisions and why, conventions, gotchas, unfinished work) and saves them to project memory as `kind: summary`.
Saving is gated like the `save_memory` tool, because saved text is injected into future prompts and model
text can relay injected content: the facts are shown and the user approves them (a `write` approval, skipped
only when writes are auto-allowed with `--yes`/`--yolo`). When nobody can be asked (the interface is closing the
engine) the facts are stored as `pending`: listed by `/memory`, never recalled until `/memory approve <id|all>`.
Declining stores nothing and is not asked again for the same messages. Recalled auto-saved facts are labeled
`(auto-saved)` in the prompt. Further safeguards:

- only user and assistant text is mined; tool results (file contents, web pages) never are;
- facts that look like credentials or like instructions to an AI are dropped, near-duplicates of existing
  memory are skipped, and everything saved is printed with an id (`/memory`, `/memory forget <id>`);
- recalled memory is always presented to the model as untrusted data;
- `--no-auto-memory` turns it off; it is also off whenever memory itself is off.

The pattern filter is a backstop, not a guarantee. Sessions are marked as mined only after a successful
extraction, so a failure retries next time.

## Phases

1. **Done:** `createEngine` ([engine.ts](../packages/engine/src/engine.ts)), the terminal CLI on top of it,
   and `oqelira-engine` ([serve.ts](../packages/engine/src/serve.ts)) with tests.
2. **Done - Host:** `packages/host` spawns `oqelira-engine` ([engine-client.ts](../packages/host/src/engine-client.ts))
   and bridges it to the browser. The browser API is unchanged; the host keeps only HTTP security,
   session ids and approval bookkeeping, and masks engine errors. One engine, one active run.
3. **VS Code:** spawn the engine; keep native diff review and SecretStorage, pass the key via env.
4. **Packaging:** the engine (not the CLI) is a dependency of the host and the extension (bundled in the VSIX).
   Decide how the extension finds a Node runtime with `node:sqlite` (memory degrades without it).
5. **Cleanup:** delete the duplicated tool/rules/permission wiring in host and extension.

Everything new (usage limits, compaction summaries, memory sync, MCP, hooks) is added to the
engine once.
