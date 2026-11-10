# Extending a local Oqelira engine.

Custom slash commands and lifecycle hooks are loaded only from Oqelira's local state directory. A repository checkout is never treated as configuration, so cloning a project cannot execute a command on its own.

## Trusted files

User-wide configuration lives at `~/.oqelira/customizations.json`.

Project-specific configuration lives at `~/.oqelira/projects/<project-id>/customizations.json`. The project id is generated from the resolved project path; use the path reported by the engine when provisioning this file. It is intentionally outside the repository.

## Slash commands

```json
{
  "commands": [
    {
      "name": "review",
      "description": "Review a focused change",
      "prompt": "Review {{args}}. Inspect the relevant files and tests, then report only actionable findings."
    }
  ]
}
```

Run it in the terminal with `/review packages/core`. `{{args}}` is replaced by the text after the command. The engine expands trusted custom commands itself, so the same command works from the CLI, Desktop, and VS Code interfaces. Names use lowercase letters, digits and hyphens; built-in commands remain reserved by the interface.

## Lifecycle hooks

```json
{
  "hooks": [
    {
      "id": "check-format",
      "event": "after_tool",
      "tool": "write_file",
      "command": "npm run format:check",
      "timeoutSeconds": 120
    }
  ]
}
```

Supported events are `session_start`, `session_end`, `before_tool`, and `after_tool`. `tool` is optional; when present, the hook runs only around that tool.

Every hook command is treated as an `exec` operation and uses the same approval flow as `run_command`. A denied or failing before-hook prevents the tool. A failing after-hook is reported as a failed tool result; it is never hidden. Hooks run with a scrubbed environment and never inherit model credentials.
