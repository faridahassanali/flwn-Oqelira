# Sandbox runner VM

Infrastructure as code for the single Linux VM that runs `packages/server/src/runner.ts`
so the production API (`OQELIRA_RUNNER_URL` must be https) can run cloud coding.
Target: resource group `flwn-ai-engine`. Deployed to Sweden Central as `oqelira-runner`; validation results are in the table at the end.

## Status: deployed and validated in Sweden Central

France Central did not offer a usable VM SKU for this subscription, so the live runner is deliberately in
Sweden Central. The VM, 64 GB XFS data disk, gVisor runtime, project quotas, HTTPS endpoint, managed-identity
Blob backup/restore path, and runner service were validated on 2026-11-12. Re-run `az deployment group what-if`
before any future infrastructure change; a live VM is evidence for this configuration, not a substitute for review.

## What it creates

- Ubuntu 24.04 LTS VM, `Standard_B2ls_v2`, SSH key only, system-assigned identity, 64 GB StandardSSD_LRS data disk.
- Standard static public IP with DNS label; NSG: 443 from internet, 22 only from `adminIp`, deny the rest inbound.
- Storage account (Standard_LRS, Cool, TLS 1.2, no public blob access), private `backups` container,
  30-day delete lifecycle rule, VM identity = Storage Blob Data Contributor on the container.
- Optional daily auto-shutdown (`enableAutoShutdown`, default off; the API needs the runner up).
- On first boot (`cloud-init.yaml`): Docker, gVisor `runsc` as a Docker runtime, Node 24, Caddy, azcopy; XFS+prjquota
  data disk at `/var/lib/oqelira` (Docker data-root moved there); `oqelira` service user; random token in
  `/etc/oqelira/runner.env` (0600 root; generated on the VM, never in cloud-init text, bicep or outputs);
  hardened `oqelira-runner.service` bound to `127.0.0.1:4321`; Caddy TLS (Let's Encrypt) on 443 accepting only
  `POST /execute` with a 1.2 MB body cap; nftables per-IP new-connection cap on 443; quota timer; nightly backup timer.

Used as is: the runner reads `OQELIRA_RUNNER_TOKEN`, `OQELIRA_RUNNER_HOST` (default 127.0.0.1), `OQELIRA_RUNNER_PORT`
(4321), `OQELIRA_CONTAINER_RUNTIME`, `OQELIRA_WORKER_IMAGE`; auth is `Authorization: Bearer <token>`.
Production mode requires `runsc` and an `@sha256:` image reference. `oqelira-install.sh` builds the worker image from
`packages/worker/Dockerfile`, pushes it to a throwaway loopback registry only to obtain a RepoDigest, and writes that
reference into `runner.env`. Workers use volumes `oq-project-<id>` under `/var/lib/oqelira/docker/volumes`.

## Cost (Sweden Central, verify before relying on it)

B2ls_v2 is $0.0472/hour, about $34.46/month always on. Extra and small: 64 GB StandardSSD (a few dollars), 128 GB-class
OS disk, Standard static IP (about $3.65/month), Cool LRS storage (cents per GB). Auto-shutdown saves compute but
takes the runner offline.

## Security tradeoff

443 is open to the whole internet. The API runs on Container Apps consumption, which has no fixed outbound IP, so
an IP allow-list is impossible without a VNet, NAT gateway or private endpoints (more cost, explicitly out of scope).
The controls instead: TLS from Let's Encrypt, a 32-byte random bearer token compared in constant time, Caddy
exposing only `POST /execute` with size/time limits, an nftables connection-rate cap, the runner's 3-job cap, and
gVisor with `--network none` workers. SSH is limited to `adminIp`. If the token leaks, anyone can run sandboxed
code and burn compute; rotate by editing `runner.env`, restarting the unit and updating the Container Apps secret.
The runner user is in the `docker` group, which is root-equivalent on this VM; the host runs nothing else.
Workers have no network, so they cannot reach the metadata service, but the host can (azcopy uses it).

## Deploy

`deploy/azure/runner/deploy.sh` builds the code tarball with `git archive` and prints the exact `what-if`, `create`,
`scp`, install and token-reading commands. The token is read once over SSH and put into a Container Apps secret.
The API then needs:

```
OQELIRA_RUNNER_URL=https://oqelira-runner.swedencentral.cloudapp.azure.com
OQELIRA_RUNNER_TOKEN=<secretref from the Container Apps secret>
```

The pinned worker image is configured on the VM (`OQELIRA_WORKER_IMAGE` in `runner.env`), not on the API.

## Validation boundaries and known limits

The current VM has the configured 2 GiB block limit and 1,000,000 inode limit on every existing project volume.
The quota watcher applies both limits when a volume is created; this PR also makes it reapply them to existing
volumes. A running VM does not automatically receive changes to `cloud-init.yaml`, so deploy the revised host script
through the normal change procedure before depending on changed defaults.

Backups are live tars rather than crash-consistent snapshots. Quota covers project volumes only; Docker images and
logs share the 64 GB disk. The production recovery drill still needed before closing #25 is Azure PostgreSQL recovery;
that requires its own production-safe runbook and database authority. The actual 30-day lifecycle deletion cannot be
proven until the retention period elapses.

## Validate issue #25 on the real VM

Record host kernel, Docker and runsc versions, worker image digest, commands and timestamps in
`docs/sandbox-validation.md`. Any failure blocks production.

| Check | How | Expected | Result |
| --- | --- | --- | --- |
| Runtime is gVisor | `docker run --rm --runtime=runsc <image> dmesg` | "Starting gVisor" | PASS 2026-11-10: guest kernel reports `4.19.0-gvisor` (runsc release-20261102.0) |
| No Docker socket | worker: `ls /var/run/docker.sock` | absent | PASS 2026-11-10: `/var/run/docker.sock` and `/run/docker.sock` absent |
| Metadata blocked | worker: fetch `169.254.169.254` | no network | PASS 2026-11-10: fetch to 169.254.169.254 fails with ENETUNREACH |
| Sibling volume | worker: look for other `/var/lib/oqelira` or `oq-project-*` | not visible | PASS 2026-11-10: no `/var/lib/oqelira` or `/var/lib/docker`; only `/workspace` is an `oq-project` mount |
| Devices/mounts | worker: `ls /dev`, `cat /proc/mounts`, `mount` attempt | minimal, denied | PASS 2026-11-10: `/dev` has the standard gVisor set (it also lists `fuse` and `net`, unusable with no capabilities); `mount` refused; all capability sets are 0 |
| Credential paths | worker: read `/etc/oqelira`, `/root`, host env | not visible | PASS 2026-11-10: `/etc/oqelira` absent, `/root` denied, no secret-looking environment variables |
| Write outside workspace | worker: `touch /x` | read-only error | PASS 2026-11-10: `/x` and `/etc/x` give Permission denied |
| Quota enforced | in a worker `dd if=/dev/zero of=/workspace/big bs=1M count=3000` | stops at 2 GiB | PASS 2026-11-10 with synchronous writes: stopped at 2048 MiB, report shows 2.0G of 2G hard. NOTE: buffered writes (`bs=1M count=3000`) are OOM-killed at the 512 MiB worker memory limit (about 550 MiB written, exit 137) before the quota is reached; large legitimate installs may hit this |
| Quota gap | time from first volume creation to quota applied (`xfs_quota -x -c 'report -p' /var/lib/oqelira`) | at most 60 s | FAIL then PASS 2026-11-10. Before the fix, `gap.sh <uuid>` (first worker run, then `xfs_quota -x -c 'report -p -N'` polled every 0.2 s, 5 volumes, random timer phase): quota first visible 12.3, 19.2, 20.0, 24.7 and 21.9 s after the first `docker run`. Exploitable: 4 parallel `fdatasync` writers (8 MiB writes, `node`) had 4194048 KiB (4 GiB) in a 2 GiB project when the quota landed at 21.9 s; final usage 4161408 KiB against a 2097152 KiB hard limit (the overshoot stays, the limit only blocks new writes). Fix: `oqelira-quota-watch.service` (`docker events --filter type=volume --filter event=create` runs the quota script, which now takes a `flock`); the timer stays as fallback. Re-test after the fix, 3 volumes at random timer phases, same 4 writers: quota visible 0.30, 0.23 and 0.27 s after `docker run` with 0 KiB used; final usage 2097152 KiB = hard limit in all three (writers got ENOSPC) |
| Auth | `curl` /execute without token / wrong token / GET | 401 / 401 / 401 or 404 | PASS 2026-11-10T19:03Z. Token read on the VM inside one `sudo bash` script (`. /etc/oqelira/runner.env`, never printed or copied), https endpoint: wrong token POST 401, empty `Bearer ` 401, empty header 401, no header 401, GET without / with wrong / with right token 404 (Caddy only passes `POST /execute`), right token with `text/plain` 404, right token with project `../etc` 400, right token `run_command` (`echo hello-from-sandbox; id -u; uname -r`) 200 `{"output":"hello-from-sandbox\n1000\n4.19.0-gvisor\n\n[exit code 0]"}`, right token with a 2 MB body 413, plain http on port 80 no connection |
| TLS | `curl -v https://<host>` | valid Let's Encrypt cert | PASS 2026-11-10: Let's Encrypt cert for the cloudapp.azure.com name, valid to 2027-02-08 |
| Backup | `sudo systemctl start oqelira-backup.service`; list `backups/<date>/` | blob per volume | PASS 2026-11-10: blob `<date>/oq-project-<uuid>.tar.zst` written via managed identity |
| Restore drill | delete a test volume, `sudo oqelira-restore.sh <uuid> <date>`, run a worker | data and owner (1000:1000) intact | PASS 2026-11-10 after fixing the restore mount target: data intact, owner 1000:1000 |
| Reboot | reboot VM | disk mounted by UUID, runner and Caddy up | PASS 2026-11-10: `sudo reboot` at 19:01:06Z, booted 19:01:12, SSH back about 25 s later. `findmnt /var/lib/oqelira` = xfs `rw,relatime,inode64,...,prjquota`, fstab entry `UUID=d4260f21-... /var/lib/oqelira xfs defaults,prjquota,nofail`, `docker info` root `/var/lib/oqelira/docker`, runtime `runsc` listed; docker, runner (active 19:01:25, listening 127.0.0.1:4321), caddy, nftables and `oqelira-quota-watch` active; `oqelira-quota.timer` and `oqelira-backup.timer` enabled and scheduled; no-token https POST 401. Surprise: the data disk came back as `/dev/sdb` (was `/dev/sda`), so the UUID mount matters. A test volume kept `marker.txt` and the 940 KB probe binary (sha256 identical before and after), owner 1000:1000, quota still applied (952 KiB used of 2097152 KiB). `/tmp` is wiped on reboot |
| Lifecycle | confirm rule exists (`az storage account management-policy show`) | 30-day delete | PASS 2026-11-10T19:02Z: `az storage account management-policy show -g flwn-ai-engine --account-name oqrunaz4bsazq7dm4i` (read only) gives rule `expire-backups`, enabled, `baseBlob.delete.daysAfterModificationGreaterThan` 30, blockBlob, `prefixMatch` `backups/`. Layout confirmed from the VM with its managed identity: `azcopy ls https://oqrunaz4bsazq7dm4i.blob.core.windows.net/backups` shows `2026-11-10/oq-project-<uuid>.tar.zst`. Not testable now: the deletion itself at 30 days (the lifecycle engine runs about once a day) |
| Escape probes: syscalls and capabilities | static C binary `probe` (sha256 `b7e4dcc2685692e71e1e929c3dcf6997a9bf61f13fdd0ebe5b124c008b673ee5`, built on the VM host in `gcc:14@sha256:a6f425a380ee03e682df3b436fc9077c544fb0fea0a9cab943c3b8320db10765`; own source, no third-party checker was used), piped into `/workspace` of a production-flag worker (`--entrypoint /bin/sh`, every other flag as `sandbox.ts`), run 2026-11-10T18:36:29Z | every privileged call refused | PASS with notes. DENIED (EPERM/ENOSYS/ENODEV): `mount`, `unshare(NEWNS)`, `ptrace(ATTACH pid 1)`, `keyctl` (ENOSYS), `add_key`, `perf_event_open` (ENODEV), `bpf(MAP_CREATE)`, `reboot`, `chroot`, `sethostname`, `init_module`, `kexec_load`, `mknod` block 8:0 and char 1:1, `open_by_handle_at`, raw ICMP / IPPROTO_RAW / AF_PACKET sockets, NETLINK_NETFILTER. ALLOWED: `socket(AF_NETLINK, NETLINK_ROUTE)` (gVisor netstack, empty network) and `unshare(CLONE_NEWUSER)`. After `unshare(NEWUSER)` in the same process `unshare(NEWNS)`, `unshare(NEWNET)` and `chroot("/proc")` succeed, but raw sockets and `mount tmpfs` stay denied. These are gVisor-internal namespaces and never touch the host; recorded as exposed sentry attack surface, not a breakout |
| Escape probes: /proc, /sys, /dev | shell script `probe.sh` in the same worker, 18:36:29Z | no host data, no writes | PASS. `/proc/sysrq-trigger` and `/sys/kernel/uevent_helper` EACCES; `core_pattern`, `drop_caches`, `kcore`, `kallsyms`, `sched_debug`, `/dev/mem`, `/dev/kmsg`, `/dev/sda`, `/sys/class/net` do not exist; `/sys/fs/cgroup` is the gVisor view (`cpu cpuacct cpuset devices job memory pids`) and `release_agent`, `mkdir`, `memory.max` writes fail with read-only file system. Visible but harmless: `/proc/1/root` is the sandbox own root, `/proc/1/environ` holds only the container env (`PATH`, `HOSTNAME`, `NODE_VERSION`...), the root mount is 9p `ro`. `/dev` lists `fuse`, `net/tun`, `ptmx`; they open but cannot be used without mount or network capabilities |
| Escape probes: links | same script, in `/workspace` | no host path reachable | PASS. Symlinks to `/etc/shadow` (permission denied), `/proc/1/root` and `/` resolve inside the sandbox root only; no `/var/lib/oqelira`, `/var/lib/docker`, `/host` or `/run/containerd`; `ln /etc/passwd` and `ln /proc/self/exe` give EXDEV (volume is another filesystem); `../../../var/lib/oqelira` does not exist |
| Escape probes: sockets and egress | same script | none | PASS. `getaddrinfo example.com` EAI_AGAIN, `fetch https://example.com` EAI_AGAIN, IPv6 literal `[2606:4700:4700::1111]` ENETUNREACH, connect `1.1.1.1:443` and UDP to `168.63.129.16:53` ENETUNREACH, `/proc/net/route` empty; connect to `/var/run/docker.sock` ENOENT, abstract unix socket ECONNREFUSED; a unix socket inside `/workspace` works (expected) |
| Runner file tools: path traversal | `packages/worker/runner.mjs` run in the worker with real tool JSON (`trav.sh`), 18:36:59Z and 18:37:15Z | nothing outside `/workspace` | PARTIAL, one FAIL. Blocked correctly: `..`, `sub/../..`, absolute `/etc/passwd`, `/workspace/../etc`, symlink to a file, relative symlink, directory symlink, symlink to `/proc/1/root`, write and edit through symlinks, `.env`, `.ENV`, `*.pem`, `.git`, `file_snapshot` of a symlink and of `../..`, NUL in path. FAIL (low impact): a dangling symlink escapes the check. `ln -s /tmp/dang_target dang`, then `write_file {"path":"dang"}` returned `wrote dang` and created `/tmp/dang_target` containing `pwned` (`inside()` falls back to the parent when `realpath` gives ENOENT, then `fs.writeFile` follows the link). A link to `/etc/...` failed only because `/etc` is read-only. Reach is limited to the worker own writable paths (`/tmp`, `/dev/shm`), where `run_command` already gives a shell. Fix: `lstat` the final component or open with `O_NOFOLLOW`. Not changed here |
| Resource limits | `res.sh` and `ino.js` in production-flag workers, 18:38:10Z and 18:39:15Z | bounded | PARTIAL, one FAIL. pids: 150 `spawn` attempts, 14 succeeded, 136 failed (limit 64 counts threads); `/tmp` tmpfs stops at 64 MiB (ENOSPC) and is noexec; `/dev/shm` also 64 MiB; CPU: fixed 6e8-iteration loop 5.4 s alone, 20.3 s as 2 parallel processes (`--cpus 1` holds). FAIL, no per-project inode limit: 300000 empty files created in 35 s with `df -i` going from 60 to 300361 used of 33554432; the project quota counted 10816 KiB (`report -p`) and `report -p -i` shows ihard 0, but deleting the volume freed 157 MiB of real disk (1445 to 1288 MiB used), about 15 times the counted amount. A hostile project can fill the 64 GB disk with inode metadata outside its 2 GiB quota. Fix: `oqelira-quota.sh` now passes `isoft=` and `ihard=` (default 1000000, parameter `projectInodeLimit`, written to `quota.env`). Syntax tested 2026-11-10 on a scratch directory under `/var/lib/oqelira` with a private projects file (`xfs_quota -D/-P`, installed scripts and /etc/projects untouched, deleted afterwards) at `ihard=5000`: file creation stopped with ENOSPC after 4999 files plus the directory itself (5000 inodes, `report -p -i` 5000/5000/5000). Not yet re-run through the installed script: the VM needs the script redeployed |
| Worker memory limit | npm ci, build, git clone, buffered write in production-flag workers, only `--memory` changed (`mt.sh`), 18:50 to 19:00Z | recommendation | see the section "Worker memory limit" below |

## Worker memory limit (`--memory 512m`), measured 2026-11-10

gVisor counts the sandbox file cache as container memory. Production flags, only `--memory` varied, volume on the XFS
data disk, no network (so dependencies and the repo were fetched on the host into the volume, then used offline):

| Workload | 512m | 768m | 1g |
| --- | --- | --- | --- |
| `npm ci --offline` of a 363-package React/Vite/Vitest/ESLint project (254 MiB `node_modules`) | pass, 36 s | not run | pass, 33 s |
| `tsc -b && vite build` of the same project | pass, 22 s | pass, 19 s | not run |
| `git clone --no-local` of nodejs/node depth 1 (126 MiB pack, 854 MiB checkout) | pass, 39 s | pass, 39 s | not run |
| `tar -czf` of the 854 MiB checkout | pass | pass | not run |
| buffered `dd bs=1M count=1900` to `/workspace` | OOM-killed (exit 137) after 13 s | pass | pass (also pass at 1536m) |

`docker stats` is not usable for this: it showed 11 MiB during the 1.9 GiB write because the cache lives inside the gVisor
sentry. Ordinary installs, builds and clones fit in 512m (peak about 430 MiB by docker stats, no OOM). What fails at 512m
is any large buffered write (big download, archive extraction, build artifact): the cache fills the limit before the
2 GiB quota is reached (earlier run: kill at about 550 MiB).

Recommendation: 1 GiB (`--memory 1g`). 768m is the smallest value tested that completed a quota-sized write; 1 GiB adds
margin for the two 64 MiB tmpfs mounts (also memory) and for Node heaps. Capacity check before changing it: the VM has
3.9 GiB RAM, so 8 concurrent jobs at 1 GiB can overcommit; lower the runner cap (`active >= 8`) to 3 or move to an
8 GiB VM size. `packages/server/src/sandbox.ts` was not changed.
