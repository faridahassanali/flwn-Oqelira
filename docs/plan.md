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

## Next engineering work.

The next engineering step is runner hardening: Docker plus gVisor validation on a real Linux environment, container-escape tests, disk quotas, and backup/restore drills. Docker Desktop is installed on the current workstation but its daemon is not running, so the real-container verification cannot be claimed yet. This does not block implementing the remaining product work.

| Active work | Constraint |
| --- | --- |
| Runner hardening and backup/restore drills | Requires Docker/gVisor to be running on a Linux-capable host. |
| Replica-safe approvals | Requires a shared approval/event channel instead of the current stream-owning process. |
| Repo import and GitHub credentials | Implementation can proceed; private access needs a GitHub App or OAuth client supplied at integration time. |
| Semantic memory | Implementation can proceed with an approved embedding model/configuration and retention defaults. |
| Billing | Implementation can proceed once the payment provider is selected. |
| Desktop installer, extension publishing, ACP | Implementation can proceed; release/signing or marketplace publication needs the corresponding account access. |

## Deliberately deferred.

| Item | Why it is deferred |
| --- | --- |
| Azure apply and live-stack testing | Needs deployment approval. |
| Flwn context and Flwn SSO | Wait for Flwn Data Engine and Auth contracts. |
