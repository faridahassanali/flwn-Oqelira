# Sandbox validation record

This record distinguishes preliminary WSL validation from the production gate.
It does not authorize exposing the cloud runner to untrusted users.

## WSL2 preliminary validation

The worker image was built locally and run with Docker Engine 29.9.3 in an
Ubuntu 24.04 WSL2 distribution. gVisor `runsc` release-20261102.0 was installed,
registered with Docker, and verified by the `Starting gVisor...` kernel message.

The worker was then run with the same controls constructed by
`packages/server/src/sandbox.ts`:

- `--runtime=runsc`, `--network=none`, a read-only root filesystem, no Linux
  capabilities, and `no-new-privileges`.
- UID/GID 1000, a 64-process limit, one CPU, and 1 GiB memory (default; runner-only
  `OQELIRA_WORKER_MEMORY`). gVisor counts file cache as container memory: on the
  3.9 GiB runner VM a buffered 1.9 GiB write was OOM-killed at 512m and passed at
  768m, while `npm ci`, a vite build and an 854 MiB clone passed at 512m. The
  runner admits at most 3 concurrent jobs (`OQELIRA_RUNNER_MAX_JOBS`) and refuses
  to start if memory x jobs exceeds `OQELIRA_RUNNER_MEMORY_BUDGET` (default 3g).
- A 64 MB `noexec` tmpfs at `/tmp`, plus a per-project named volume at
  `/workspace`.

Observed results:

| Check | Result |
| --- | --- |
| Worker file write inside the project volume | Passed |
| gVisor runtime | Passed |
| Docker socket available in worker | Absent |
| Write outside `/workspace` | Denied by the read-only root filesystem |
| Network request to GitHub | Blocked; hostname could not be resolved |
| `/tmp` quota | Enforced at 64 MB (`No space left on device`) |
| Project-volume backup and restore | Passed; a restored worker read the original test file |

## Required production validation

The WSL2 result is not a production isolation proof. Before production:

1. Run the same checks on the target Linux VM, using a digest-pinned worker
   image and the intended Docker/gVisor versions.
2. Apply and test a persistent quota for every project volume. The current
   named Docker volume has no size limit; the 64 MB tmpfs quota only protects
   temporary files. Use filesystem project quotas or an equivalent bounded
   storage layer on the Linux host.
3. Run a documented container-escape test suite, including host metadata,
   Docker socket, sibling-volume, device, mount, and credential-path probes.
4. Back up and restore both project volumes and PostgreSQL; verify data,
   ownership, and a clean worker start after restore.
5. Record image digest, host OS/kernel, Docker and gVisor versions, commands,
   timestamps, and results. Treat any failed check as a deployment blocker.
