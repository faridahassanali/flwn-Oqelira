# Engine architecture: the CLI is the product

The CLI is the engine. It owns config, providers, tools, memory, rules, permissions,
history, limits and compaction. The web host, desktop app and VS Code extension are
interfaces: they render events and send requests, nothing else.

Installing an interface installs the CLI with it. Installing the CLI installs no interface.

```
 Web UI ──HTTP──▶ host ──┐
 VS Code ext ────────────┼─ stdio NDJSON ─▶ oqelira serve (engine)
 oqelira (terminal) ─────┘                      │
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

1. **Done:** `createEngine` ([engine.ts](../packages/cli/src/engine.ts)), the terminal CLI on top of it,
   and `oqelira serve` ([serve.ts](../packages/cli/src/serve.ts)) with tests.
2. **Host:** replace the in-process `runAgent` in `packages/host` with a spawned `oqelira serve`
   bridge (HTTP/NDJSON for the browser stays; the agent code goes).
3. **VS Code:** spawn the engine; keep native diff review and SecretStorage, pass the key via env.
4. **Packaging:** the CLI is a dependency of the host and the extension (bundled in the VSIX).
   Decide how the extension finds a Node runtime with `node:sqlite` (memory degrades without it).
5. **Cleanup:** delete the duplicated tool/rules/permission wiring in host and extension.

Everything new (usage limits, compaction summaries, memory sync, MCP, hooks) is added to the
engine once.
