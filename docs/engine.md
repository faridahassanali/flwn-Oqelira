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
