# Prompt evaluation records

This directory holds reproducible records for prompt evaluation.

- [validation.md](validation.md) explains the gVisor isolation design and validation evidence.
- [smoke.md](smoke.md) records the initial live runner smoke test.
- [smoke-after-core-fixes.md](smoke-after-core-fixes.md) records the smoke test after the cross-platform core fixes.
- [results/2026-11-12-smoke-gvisor.md](results/2026-11-12-smoke-gvisor.md) records the post-rate-limit-retry runner smoke test.
- [results/issue-19-hard.md](results/issue-19-hard.md) records the completed corrected-corpus A/B run.
- [results/issue-19-luna-confirm.md](results/issue-19-luna-confirm.md) records the required independent follow-up run.

The task corpus and evaluator implementation live in `packages/core/eval/prompt/`. Run the live evaluator with `npm run prompt:eval`; it requires the runner settings described in `.env.example` and does not write result files unless `PROMPT_EVAL_OUT` is set.

For a long live comparison, use a durable JSON Lines journal and run short, disjoint shards. Each command skips cells that are already journaled; the last completed shard writes the Markdown report.

```powershell
$env:PROMPT_EVAL_SET = 'hard'
$env:PROMPT_EVAL_REPEATS = '4'
$env:PROMPT_EVAL_CONCURRENCY = '1'
$env:PROMPT_EVAL_JOURNAL = 'docs/evaluations/prompt/results/issue-19-hard.jsonl'
$env:PROMPT_EVAL_OUT = 'docs/evaluations/prompt/results/issue-19-hard.md'
$env:PROMPT_EVAL_SHARD = '1/30' # then 2/30 through 30/30
npm run prompt:eval -w @oqelira/core
```

Do not edit the journal by hand or reuse it with a different model list, task set, or repeat count.
