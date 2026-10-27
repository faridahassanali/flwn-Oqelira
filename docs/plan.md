# PRODUCT STATUS

# Oqelira is ready for the next security gate.

Oqelira is a multi-user coding-agent platform for Web, Desktop, CLI, and VS Code. It is not yet approved for production deployment: the runner isolation gate must be validated first.

## What is built.

| Area | Status | Included |
| --- | --- | --- |
| Shared agent core | Done | Provider boundary, Foundry adapter, streamed loop, context compaction, explicit approvals, reversible file changes. |
| Web and Desktop | Done | Shared Flwn-branded UI, project/workspace views, streamed runs, reconnect, diff review and revert. |
| Server mode | Done | PostgreSQL persistence, durable run events, interrupted-run recovery, project memory, quotas, tenant and team authorization. |
| Accounts | Done | Better Auth, verification and password recovery flows, SMTP outbox, Google/GitHub identity-provider configuration, organization roles. |
| CLI | Done | Foundry-backed interactive and one-shot modes, local durable session history, safe `/clear`, and opt-out with `--no-history`. |
| VS Code | Done | Same core, trusted-workspace guard, SecretStorage credentials, native diff review and packaged VSIX. |

## Next gate: runner isolation.

The next engineering step is a real Linux validation environment. It must prove Docker plus gVisor behavior, container-escape resistance, disk quotas, backup/restore drills, and the complete Azure PostgreSQL + runner + Foundry stack. Until that gate passes, production signup remains deliberately disabled and multi-replica API deployment is not supported.

## Deliberately deferred.

| Item | Why it is deferred |
| --- | --- |
| Azure apply and live-stack testing | Needs deployment approval and the runner isolation gate. |
| Production signup and API replicas | Depend on verified runner isolation and cross-replica approval routing. |
| Flwn context and Flwn SSO | Wait for Flwn Data Engine and Auth contracts. |
| Repo import and GitHub credentials | Needs a credential-storage and import-policy decision. |
| Semantic memory | Needs an approved embedding deployment and retention policy; current project notes are textual and explicitly untrusted. |
| Billing | Needs product and payment-provider decisions. |
| Signed Desktop installer and extension publishing | Need signing certificate and marketplace publisher access. |
| ACP interoperability | Needs the target ACP compatibility contract. |
