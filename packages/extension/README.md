# Oqelira by Flwn

Open a trusted local project, then use **Oqelira: Configure Foundry** and **Oqelira: Ask** from the command palette.
Keys are stored in VS Code SecretStorage. Deployment names come from your configuration.
Read tools run automatically; writes and commands show a native diff or prompt: Allow once, Always allow in this project, or Deny.
Approved shell commands run on your computer and can access outside the project.
**Oqelira: Stop** cancels the current run. **Oqelira: New Conversation** ends the chat (the engine may propose project memories for you to approve) and clears it. **Oqelira: Review Project Memory** approves or forgets saved memories.

This extension is an interface to `oqelira-engine`, which runs in VS Code's own runtime (no separate Node install). Sessions, summaries, memory and permission rules live in the engine under `~/.oqelira`. Set `oqelira.enginePath` in your user settings to use a different engine; workspace settings cannot change it.

For tracked text edits, the agent uses snapshot hashes and records the previous
content in the project's ignored `.oqelira/changes` directory. Revert refuses to
overwrite a newer edit. **Oqelira: Revert a File Change** previews and reviews a
recent tracked edit. Legacy edits, large files and arbitrary shell commands are
not automatically reversible.

From the repository root: `npm run extension:package` builds a Windows VSIX under
`outputs/`. Install it with **Extensions: Install from VSIX**. This is a local
build, not a Marketplace publication or a signed desktop installer.
