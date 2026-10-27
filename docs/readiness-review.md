# Agent readiness review.

Review date: 2026-10-27. This separates implemented code, runtime evidence and
proposed work. Azure resource creation and chargeable deployment remain deferred
at the user's request. Flwn authentication is not ready, as confirmed by the user.

## Current evidence.

| Area | Implemented | Missing or unverified |
| --- | --- | --- |
| Runner isolation | No network, read-only root, non-root UID, capability removal, CPU/RAM/PID/time/output limits; production runtime/image checks | Docker engine unavailable during this review; no live gVisor evidence, adversarial boundary validation or enforced persistent disk quotas |
| Azure | Foundation Bicep compiled; earlier what-if reviewed; existing Foundry provider connection checked separately | Foundation not applied; API/runner deployment absent from template; no Azure PG + runner + Foundry end-to-end test |
| Context | Durable server transcript, project notes, context size rejection | No summarization/compaction; size rejection is not context management |
| Diffs | Server Git status and read-only diff; file-write/edit previews | No versioned change ledger, transactional patch Apply/Revert or stale-file conflict checks |
| Reconnection | Database checkpoints and recovery of unknown tool outcomes | Response disconnect aborts the run; no durable event journal, replay cursor, reconnectable execution or cross-replica approval routing |
| VS Code | Shared core, CLI and Web/Desktop renderer | No extension package or editor integration |
| Accounts | Better Auth password accounts, sessions, quotas and per-user ownership | Email delivery/verification/recovery, social sign-in, organizations, invitations and team roles not wired |
| Flwn identity | Requirement established; future integration must use one gateway | Flwn auth/issuer does not exist yet; no SSO or verified membership contract available |

Tests of Docker command arguments and file path confinement do not establish
container-escape resistance. PostgreSQL test coverage uses PGlite and adapted pg
transport; it does not establish Azure connectivity, availability or recovery.

## Immediate change from this review.

Production now rejects `OQELIRA_ALLOW_SIGNUP=true` at configuration time. Existing
controlled accounts remain available with signup disabled. Local fixture signup
continues to work for development tests. This gate must only be removed in a
reviewed change delivering verification/recovery and controlled enrollment; a
checkbox or an environment assertion is not evidence those features work.

## Runner validation and storage.

This work can be done on a dedicated local Linux test host independently of Azure
approval. Docker was installed but its Linux engine endpoint was unavailable in
this session. gVisor and persistent quotas therefore remain unverified. Do not
silently substitute the ordinary Docker runtime for a failing production runsc.

Prepare a disposable Linux host with a supported gVisor runtime, a digest-pinned
worker image and a quota-capable storage backend. The persistent project volume
needs enforced byte **and inode** quotas. CPU/RAM limits and a read-only container
root do not bound the writable named project volume. An application `du` check
alone is not a quota because a command can allocate space between checks.

Required runtime evidence before accepting untrusted workloads:

| Check | Expected evidence |
| --- | --- |
| Effective launch settings | Inspect running container runtime, digest, UID, capabilities, namespaces, root mounts, CPU/RAM/PID limits and network namespace |
| Network denial | No DNS/egress or access to metadata, API, PostgreSQL, Foundry or runner; use controlled fixtures without retrieving real credentials |
| Filesystem boundary | No Docker socket/host directories, traversal or symlink/hardlink access to another project; no access to a host sentinel |
| Privilege boundary | Mount/namespace/privileged operations denied; no host PID namespace or inherited service credentials |
| Resource exhaustion | Bounded memory/PIDs/CPU/output; killed requests remove their containers and cannot leave child processes |
| Persistent quotas | Writes fail at configured byte/inode limits; another project's writes still succeed; limits remain enforced after restart |
| Lifecycle | Container cleanup after API disconnect/timeout, runner restart, expired lease and repeated cancellation |
| Data recovery | Restore a project and database from backup, proving tenant separation and documented recovery behavior |

Record host/kernel/runtime/image versions and actual outputs. These regression
probes are boundary checks, not a proof against unknown container escape exploits.
A separate security assessment remains necessary for public hostile workloads.

## Agent features: implementation order and acceptance.

1. **Context compaction.** Preserve the full durable transcript separately from the
   model request. Build a bounded, versioned summary of older completed turns;
   retain recent turns, user intent, changed paths, test results and unresolved
   work. Keep tool calls/results paired and never summarize pending approvals into
   permission. Summaries are context, not higher-priority instructions. Model calls
   stay in providers; deployment names and budgets come from config. Test long
   conversations, summary failure, restart, limits and prompt-injection attempts.
2. **Diff Apply/Revert.** Store project-scoped before/after hashes and a durable
   change record. Preview the exact patch and require explicit approval. Reject
   absolute/traversal/credential/internal paths, symlinks and unsupported patch
   forms. Apply only when the before hash matches; revert only when the current
   file still matches the recorded after hash. Never overwrite subsequent human
   edits or promise to undo arbitrary shell commands. Test stale previews,
   concurrent edits, failed writes, tenant checks and restart recovery.
3. **Reconnection.** Give execution its own lifecycle and a durable owner-scoped
   event journal with monotonically increasing cursors. Separate explicit Stop
   from stream disconnect; replay events without re-executing tools. Restore
   pending approvals with the same IDs/deadlines and fresh authorization checks.
   Expired/revoked sessions must lose access. Test dropped connections, duplicate
   events, service restart, leases and exactly-once decision consumption. Database
   checkpoints alone do not deliver this behavior.
4. **VS Code extension.** Reuse the core/protocol. Require Workspace Trust before
   execution; scope multi-root workspaces explicitly. Keep secrets in VS Code
   SecretStorage, never the webview. Use a restricted webview CSP and validated
   messages; show native diff previews and explicit approvals. Package and test
   the extension in a development host before claiming installable support.

## Identity and team contract.

Two entry paths share one Oqelira authorization model:

- **Inside Flwn:** the member uses their existing Flwn identity after Flwn auth is
  delivered. Use a verified OIDC/OAuth integration or another reviewed server
  identity exchange, behind one Flwn gateway. No second password is required for
  that path. Embedded UI state, a supplied email, a team ID or a browser header is
  never proof of identity or membership.
- **Standalone Web/Desktop:** an Oqelira email/password account, or Google/GitHub
  sign-in. "Gmail" means Google identity, not inbox access. Request only identity
  scopes; GitHub login must not imply repository access. Provider registration,
  callback URLs and secrets are required before these methods can be activated.

Identify external accounts by provider/issuer and immutable subject, not email
alone. Link identities only through a verified, authenticated flow with explicit
user intent; do not merge accounts solely because emails match. Protect provider
callbacks with state/PKCE/nonce and issuer/audience/redirect validation. Desktop
and VS Code need an external-browser callback flow; the current Electron shell
blocks arbitrary navigation, so adding social-login buttons alone will not work.
Never place provider client secrets in desktop, extension or browser code.

Team access must be checked on every project, file, memory, conversation, run,
replay and approval operation. Current `user_id` ownership cannot simply be
replaced by a client-supplied `team_id`. Proposed organization roles:

| Role | Proposed access |
| --- | --- |
| Owner | Organization lifecycle and ownership transfer, plus administrator access |
| Admin | Members/invitations and project administration |
| Member | Authorized projects and agent execution with normal tool approvals |
| Viewer | Read authorized projects/history; no run, write or approval authority |

Organization roles do not bypass tool approval. Invitations need expiry,
single-use acceptance and a verified intended recipient. Removing a member must
revoke their project access and outstanding approval/replay access. A role stored
in an identity token is not automatically authoritative until Flwn defines and
implements a verifiable membership contract.

Email/password readiness requires a configured transactional mail sender, verified
origin/domain and delivery tests, verified-email enforcement, expiring single-use
recovery tokens, safe invalid-token responses and session revocation after reset.
Test account enumeration behavior, rate limits, callback redirects, delivery
failure and unlinking the last usable login method. Keep production signup closed
until these behaviors and the team enrollment policy are tested.

## Deferred dependencies.

- Azure apply, hosted images, networking and full-stack validation: deferred for
  the user's deployment/cost approval. No Azure resources were changed here.
- Flwn SSO and authoritative team mapping: blocked on Flwn auth implementation.
- Google/GitHub activation: needs registered applications and approved callback
  origins. The code must not pretend those connections are configured.
- Verification/recovery delivery: needs a selected mail sender and domain setup.
- Live gVisor/quota validation: needs an available dedicated Linux test runner.

Agent context/diff/replay features, an extension and local auth fixtures do not
inherently require Azure approval. The order above is a reviewed implementation
sequence, not a statement that these features have already been built.

## Primary references.

- [gVisor installation and Docker runtime](https://gvisor.dev/docs/user_guide/install/)
- [gVisor filesystem boundaries](https://gvisor.dev/docs/user_guide/filesystem/)
- [Docker persistent volumes](https://docs.docker.com/engine/storage/volumes/)
- [Better Auth email verification and recovery](https://better-auth.com/docs/concepts/email)
- [Better Auth account linking](https://better-auth.com/docs/concepts/users-accounts)
- [Better Auth organization roles](https://better-auth.com/docs/plugins/organization)
- [Better Auth OIDC/OAuth provider integration](https://better-auth.com/docs/plugins/generic-oauth)
- [VS Code Workspace Trust](https://code.visualstudio.com/api/extension-guides/workspace-trust)
- [VS Code webview security](https://code.visualstudio.com/api/extension-guides/webview)
