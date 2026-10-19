# Merge-gate demo

Synthetic diffs for the `jev` CLI. Build first (`npm run build`), then from the
repo root run:

    node dist/src/cli.js check --diff examples/merge-gate/sample.diff --tests-passed
    node dist/src/cli.js check --diff examples/merge-gate/sample-risky.diff --tests-passed

- `sample.diff` — small safe change (greeting copy + its test). No rule hits,
  the mock judge allows → `allow`, exit code 0.
- `sample-risky.diff` — touches protected path `src/payments/charge.ts` and
  adds an obviously fake password literal (`FAKE_EXAMPLE_ONLY_123`); the
  value is a placeholder, never a real credential. Blocks → exit code 2.
  Protected-paths decides first (first hit wins); the secret line would also
  have tripped `secrets-in-diff`.
