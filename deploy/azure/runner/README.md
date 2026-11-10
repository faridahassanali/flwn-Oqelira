# Sandbox runner VM

Infrastructure as code for the single Linux VM that runs `packages/server/src/runner.ts`
so the production API (`OQELIRA_RUNNER_URL` must be https) can run cloud coding.
Target: resource group `flwn-ai-engine`, France Central. Nothing here has been deployed.

## Status: blocked on VM capacity in France Central

`az deployment group what-if` fails at VM preflight for this subscription:
`SkuNotAvailable - ... Capacity Restrictions: Standard_B2ls_v2 is currently not available in location 'FranceCentral'`.
The same error came back for `Standard_B2als_v2`, `B2s_v2`, `B2s`, `D2s_v5` and `D2as_v5`, so it looks like a
subscription-wide restriction rather than one SKU. Request access/quota (Portal: Help + support, "Service and
subscription limits", or `az vm list-skus -l francecentral`), or pick another region/size with `-p location=... vmSize=...`.
A copy of the template without the VM, role assignment and shutdown schedule produced 8 creates and no
modify/delete: public IP, NSG, VNet, NIC, storage account, blob service, `backups` container, lifecycle policy.

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

## Cost (France Central, list price, check before relying on it)

B2ls_v2 is $0.0472/hour, about $34.46/month always on. Extra and small: 64 GB StandardSSD (a few dollars), 128 GB-class
OS disk, Standard static IP (about $3.65/month), Cool LRS storage (cents per GB). Auto-shutdown saves compute but
takes the runner offline.

## Security tradeoff

443 is open to the whole internet. The API runs on Container Apps consumption, which has no fixed outbound IP, so
an IP allow-list is impossible without a VNet, NAT gateway or private endpoints (more cost, explicitly out of scope).
The controls instead: TLS from Let's Encrypt, a 32-byte random bearer token compared in constant time, Caddy
exposing only `POST /execute` with size/time limits, an nftables connection-rate cap, the runner's 8-job cap, and
gVisor with `--network none` workers. SSH is limited to `adminIp`. If the token leaks, anyone can run sandboxed
code and burn compute; rotate by editing `runner.env`, restarting the unit and updating the Container Apps secret.
The runner user is in the `docker` group, which is root-equivalent on this VM; the host runs nothing else.
Workers have no network, so they cannot reach the metadata service, but the host can (azcopy uses it).

## Deploy

`deploy/azure/runner/deploy.sh` builds the code tarball with `git archive` and prints the exact `what-if`, `create`,
`scp`, install and token-reading commands. The token is read once over SSH and put into a Container Apps secret.
The API then needs:

```
OQELIRA_RUNNER_URL=https://oqelira-runner.francecentral.cloudapp.azure.com
OQELIRA_RUNNER_TOKEN=<secretref from the Container Apps secret>
```

The pinned worker image is configured on the VM (`OQELIRA_WORKER_IMAGE` in `runner.env`), not on the API.

## UNTESTED (everything except `az bicep build` and a partial what-if)

- The VM, data disk, role assignment and shutdown schedule were never validated by what-if (capacity error above).
- All of `cloud-init.yaml`: apt repos (gVisor, Docker, Caddy copied from their docs on 2026-11-10), the
  `/dev/disk/azure/scsi1/lun0` path, `/usr/bin/runsc` discovery, Node tarball checksum, unpinned azcopy download,
  `npm ci --workspace=@oqelira/server` pulling what the runner needs, Let's Encrypt issuance via TLS-ALPN on 443 only.
- Digest pinning through the loopback registry, Caddy `request_body` syntax, the nftables dynamic-set rule.
- Quota timer, `azcopy` pipe upload/download, backup/restore scripts, systemd hardening vs Docker access.
- Whether Azure grants B2ls_v2 here at all.

Known limits: a new `oq-project-*` volume has no quota for up to about 30-60 s until the timer runs. Backups are
live tars, not snapshots. Quota covers project volumes only; Docker images and logs share the 64 GB disk.

## Validate issue #25 on the real VM

Record host kernel, Docker and runsc versions, worker image digest, commands and timestamps in
`docs/sandbox-validation.md`. Any failure blocks production.

| Check | How | Expected | Result |
| --- | --- | --- | --- |
| Runtime is gVisor | `docker run --rm --runtime=runsc <image> dmesg` | "Starting gVisor" | |
| No Docker socket | worker: `ls /var/run/docker.sock` | absent | |
| Metadata blocked | worker: fetch `169.254.169.254` | no network | |
| Sibling volume | worker: look for other `/var/lib/oqelira` or `oq-project-*` | not visible | |
| Devices/mounts | worker: `ls /dev`, `cat /proc/mounts`, `mount` attempt | minimal, denied | |
| Credential paths | worker: read `/etc/oqelira`, `/root`, host env | not visible | |
| Write outside workspace | worker: `touch /x` | read-only error | |
| Quota enforced | in a worker `dd if=/dev/zero of=/workspace/big bs=1M count=3000` | stops at 2 GiB | |
| Quota gap | time from first volume creation to quota applied (`xfs_quota -x -c 'report -p' /var/lib/oqelira`) | at most 60 s | |
| Auth | `curl` /execute without token / wrong token / GET | 401 / 401 / 401 or 404 | |
| TLS | `curl -v https://<host>` | valid Let's Encrypt cert | |
| Backup | `sudo systemctl start oqelira-backup.service`; list `backups/<date>/` | blob per volume | |
| Restore drill | delete a test volume, `sudo oqelira-restore.sh <uuid> <date>`, run a worker | data and owner (1000:1000) intact | |
| Reboot | reboot VM | disk mounted by UUID, runner and Caddy up | |
| Lifecycle | confirm rule exists (`az storage account management-policy show`) | 30-day delete | |
