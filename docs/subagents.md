# Delegating bounded research.

`delegate_task` lets Oqelira split a focused research task away from the main agent without sharing the whole conversation.

## Boundary

Each subagent receives only its task and optional, explicitly supplied context. It does not receive the parent conversation history, project memory, approval rules, or a way to create another subagent.

The available tools are a fixed read-only subset: `read_file`, `list_dir`, `search_text`, `glob`, `grep`, and `file_snapshot`. The main agent may narrow that set further. A subagent cannot edit files, run shell commands, use network tools, or call `delegate_task` recursively.

## Budget and result

A delegated task is capped at eight model steps; the default is four. It has its own context and model request, and only its final concise summary is returned to the parent agent. Tool output and intermediate messages remain inside the subagent.

If the subagent reaches its limit, is cancelled, or asks for a disallowed tool, its status is included in the returned summary. The parent agent decides what to do next.
