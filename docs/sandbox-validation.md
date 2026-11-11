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
- UID/GID 1000, a 64-process limit, one CPU, and 512 MB memory.
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

## GitHub import and pull (`POST /git`): validation status

Implemented in `packages/server/src/git-sync.ts` (import and pull only; nothing
is ever pushed). Verified by automated tests with a local bare repository and
the real volume scripts run against a temp directory: validation, clone, pull
fast-forward, refusal on dirty or diverged trees (nothing changed), hooks not
run, submodules not materialised, symlinks kept as symlinks, token absent from
`.git` and logs, size cap, per-project 409, global cap, cleanup on failure.

Verified only by reading, to be run on the target VM before enabling:

1. The Docker volume step (`dockerVolumeExec`, `dockerGitArgs`): `--network none`,
   uid 1000, gVisor, bind-mounted read-only source, `sh` entrypoint override of
   the worker image. Confirm the image has `git` and `sh`, files land owned by
   1000:1000, and a clone into a brand-new volume is counted by the XFS project
   quota and inode watcher (the volume is created first; check the watcher
   catches it before the data lands, otherwise an oversized clone is only
   bounded by the 1 GiB cap).
2. Outbound HTTPS from the runner host to github.com with a real token: fetch
   works, a bad token gives a 403 with a safe message, the token is absent from
   `ps -ef`, `/proc/*/cmdline`, journal logs and the volume.
3. The runner service runs as an unprivileged user without docker group
   membership beyond what it already needs, and `/tmp` is not shared.
4. A repository with a malicious `.gitattributes`, case-colliding paths and a
   large history, cloned and pulled, with hooks and symlinks inert.
