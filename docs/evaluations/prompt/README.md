# Prompt evaluation records

This directory holds reproducible records for prompt evaluation.

- [validation.md](validation.md) explains the gVisor isolation design and validation evidence.
- [smoke.md](smoke.md) records the initial live runner smoke test.
- [smoke-after-core-fixes.md](smoke-after-core-fixes.md) records the smoke test after the cross-platform core fixes.
- [results/2026-11-12-smoke-gvisor.md](results/2026-11-12-smoke-gvisor.md) records the post-rate-limit-retry runner smoke test.

The task corpus and evaluator implementation live in `packages/core/eval/prompt/`. Run the live evaluator with `npm run prompt:eval`; it requires the runner settings described in `.env.example` and does not write result files unless `PROMPT_EVAL_OUT` is set.
