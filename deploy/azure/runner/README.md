# Runner VM notes

## `POST /git`: GitHub import and pull

`Authorization: Bearer <runner token>` (same check as `/execute`), JSON
`{ action: "clone"|"pull", project, repo: "owner/name", branch?, token }`.
Answers `{ ok, branch, commit, changed?, bytes? }` or `{ error }` with a message
safe to show a user. Import and pull only; nothing is pushed.

- The networked `git fetch` runs on the host as the runner's unprivileged user
  into a throwaway bare repo (0700 temp dir, removed in `finally`). It never reads
  the project volume. Only `https://github.com/<owner>/<repo>.git` is built by the
  runner; other protocols, redirects, hooks, filters, submodules and fsmonitor are
  disabled, and `fetch.fsckObjects` is on.
- The token goes only into that git process's environment (`GIT_CONFIG_COUNT`,
  scoped to the github.com origin), not argv, not disk, not the worker
  containers, not logs or responses. The stored remote is the plain URL.
- Files are placed into `oq-project-<uuid>` by a `--network none`, read-only,
  uid 1000, no-capability container (gVisor when configured), so ownership, the
  XFS quota and the inode limit apply. The volume is created first.
- Clone needs an empty volume and wipes it on failure. Pull is fetch plus
  fast-forward only: dirty or diverged trees are refused and nothing changes.
- Limits: 5 minute timeout, 1 GiB cap (polled during fetch, re-checked after),
  `--depth 50` (a pull deepens only if the local commit is not in that window),
  one job per project (409), at most 2 git jobs, counted in the runner's 8 slots.
- Files imported by the worker image are copied by name in
  `packages/worker/Dockerfile`; this endpoint needs no new worker file (it uses
  the image's `git` and `sh`).
- The bare repo reaches the container as a tar stream on stdin, extracted into a
  staging dir inside the project volume (`/tmp` is only 64 MB), and removed before
  the final size is taken. Staging counts against the quota while it exists.
- A per-project lock is shared by `/execute` and `/git`: a git job is exclusive
  (409 if a tool run is active; `/execute` answers 409 during a git job).
- Output of the volume scripts is untrusted (the model can write `.git`): the host
  validates every parsed line, and pull refuses a `.git/config` with keys outside
  a small allowlist.
