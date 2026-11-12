# Prompt evaluation isolation validation

Date: 2026-11-12 (Africa/Cairo).

## Implemented

- The harness requires a workspace factory. The live command supplies `RunnerWorkspace`; the local fixture implementation is imported only by controlled unit tests.
- Every live fixture operation and executable check uses the existing authenticated HTTPS `/execute` endpoint. A fixed kernel probe verifies gVisor before fixture code runs. Foundry credentials remain in the evaluator process and are not sent to the worker.
- Each attempt has a separate evaluation project identity in the reserved `e7a1e7a1-e7a1-` namespace. `reset(files)` clears `/workspace` inside gVisor before seeding; disposal clears it again. Cleanup failures fail the cell and cannot be hidden by a successful retry.
- Missing-file checks accommodate the deployed runner's masked HTTP 503 errors by checking existence inside gVisor. A failed read of a file that exists remains an error.
- Removed the project-volume deletion API and the additional runtime endpoint introduced in the previous commit. The existing runner service needs no application update for this client.
- VM-only garbage collection matches only the reserved evaluation volume namespace, requires at least 24 hours since creation and fixture activity, skips attached volumes, and uses non-forced Docker removal. Dry-run is the script default. The daily systemd timer was installed on the existing runner VM and verified active.
- Runner URL and token were read from the existing Container App configuration and mapped to `PROMPT_EVAL_RUNNER_URL` / `PROMPT_EVAL_RUNNER_TOKEN` in process memory. No secret values were committed or printed.

## Validation

| Check | Result |
| --- | --- |
| All-workspace TypeScript check | PASS |
| Core unit tests on Linux / Node 24, no internet or credentials in the test container | 68/68 PASS |
| Prompt evaluation tests, including transport, reset, retries, concurrency and masked missing-file errors | 18/18 PASS |
| VM garbage collector mock test, apply and dry-run | PASS |
| Existing gVisor runner, `failing-test`, one configured model, baseline and current prompts | 2/2 PASS |
| Core unit tests on Windows / Node 24 | 68/68 PASS after fixing home-directory isolation and SQLite handle cleanup |

Live smoke after the core test fixes: [smoke-after-core-fixes.md](smoke-after-core-fixes.md).

## Core failures and CI follow-up

The earlier agent-loop and permission failures came from blocked loopback connections in the restricted test environment. Re-running with local test connections enabled confirmed those checks pass without changing the agent loop or the permission policy. The supported `afterTool` hook was retained unchanged.

The six remaining Windows failures were fixed: environment fixtures now isolate both `HOME` and `USERPROFILE`, and local memory provides an idempotent `close()` so tests release every SQLite handle before removing their directories. The persistence test now closes and reopens the database; POSIX permission-bit assertions remain on Linux, while Windows continues testing path confinement and memory behavior.

`.github/workflows/core-ci.yml` now runs core tests and types on Linux and Windows with Node 22 and 24, plus an all-workspace typecheck. Push triggers cover the PR branch so CI can run even while the PR has merge conflicts. Current results are available in [PR #34 checks](https://github.com/faridahassanali/flwn-Oqelira/pull/34/checks).

## GC review on the existing VM

- Installed script SHA256 matches this repository: `833f7966b82db7c2829e93f3656cdbdd5fa016b4776ad6e4627855ca57aa3601`.
- Bash syntax and both systemd units passed verification. The timer is enabled and active.
- Dry-run passed both directly and inside a transient unit with the production service's filesystem and privilege restrictions; exit status was 0.
- The audit requested no volume deletion. The collector remains limited to expired, unattached evaluation volumes and keeps its 24-hour creation/activity safeguards.
- No large A/B run was started during this follow-up.

## Remaining decision

The complete easy/hard A/B comparison was attempted but not completed reliably: the runner returned HTTP 429 capacity errors under concurrent evaluation. These interrupted attempts are not evidence of prompt quality and are not published as a completed comparison. A later serial smoke passed 2/2. Repeat the full comparison with appropriate scheduling before making any new prompt-quality claim.

GitHub reports PR #34 conflicts with its `main` base. No merge was performed.
