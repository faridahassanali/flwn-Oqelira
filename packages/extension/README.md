# Oqelira by Flwn

Open a trusted local project, then use **Oqelira: Configure Foundry** and **Oqelira: Ask** from the command palette.
Keys are stored in VS Code SecretStorage. Deployment names come from your configuration.
Read tools run automatically; writes and commands require an explicit Allow once.
Approved shell commands run on your computer and can access outside the project.
**Oqelira: Stop** cancels the current run. **Oqelira: New Conversation** clears in-memory history.
History lasts for the current extension-host session. This extension uses local core execution, not cloud team accounts.

For tracked text edits, the agent uses snapshot hashes and records the previous
content in the project's ignored `.oqelira/changes` directory. Revert refuses to
overwrite a newer edit. **Oqelira: Revert a File Change** previews and reviews a
recent tracked edit. Legacy edits, large files and arbitrary shell commands are
not automatically reversible.

From the repository root: `npm run extension:package` builds a Windows VSIX under
`outputs/`. Install it with **Extensions: Install from VSIX**. This is a local
build, not a Marketplace publication or a signed desktop installer.
