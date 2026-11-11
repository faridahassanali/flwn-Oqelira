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
| Windows core run | Six platform-specific failures in home-directory handling and SQLite file cleanup; Linux run above passes |

Live smoke results: [prompt-eval-gvisor-smoke.md](prompt-eval-gvisor-smoke.md).

## Remaining decision

The complete easy/hard A/B comparison was attempted but not completed reliably: the runner returned HTTP 429 capacity errors under concurrent evaluation. These interrupted attempts are not evidence of prompt quality and are not published as a completed comparison. A later serial smoke passed 2/2. Repeat the full comparison with appropriate scheduling before making any new prompt-quality claim.

GitHub reports PR #34 conflicts with its `main` base. No merge was performed.
