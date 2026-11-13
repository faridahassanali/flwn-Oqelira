# Sync identity and conflicts

Issue #6 defines the contract used by the sync API (#5) and engine client (#4).

## Identity

- A Git-backed project uses `SHA-256("oqelira-repository-v1\\0" + canonicalRemote)` as its repository key. The raw remote is never sent as the key.
- Canonical remotes discard protocol, Git username, a trailing slash, and `.git`; HTTPS, SSH, and SCP spellings of the same host/path therefore match.
- A project with no Git remote must receive an explicit local project id. It is hashed with a distinct namespace and cannot collide with a Git-backed key.
- Each install has one random UUID outside every checkout (`~/.oqelira/device-id`). It identifies the writer, not the user or the device hardware.
- The server scopes every repository key to the authenticated user or organization. A matching remote never crosses account boundaries.

## Merge rules

Messages are append-only. Each has a UUID, a content hash, a device id, and a timestamp. Push is idempotent by UUID; a repeated batch creates no duplicate. Pull unions UUIDs and orders messages by timestamp then UUID. A reused UUID with a different hash is rejected.

Snapshots are versioned history. The active snapshot is last-writer-wins by `updatedAt`, then `deviceId`, then UUID. Losing snapshots remain in history and are never silently overwritten.

## Offline behavior

Local writes commit first. The engine later sends unsynced rows, pulls rows it has not seen, and applies the merge rules above. A failed network request changes neither local rows nor their pending state.

## Test matrix

| Situation | Expected result |
| --- | --- |
| Two clones of one remote, same account | Same repository key; records merge. |
| HTTPS versus SSH/SCP spelling | Same repository key. |
| No remote | Sync is refused until an explicit local project id is supplied. |
| Same remote, different account | API denies cross-account read and write. |
| Two devices offline, distinct messages | Both messages appear once after reconnect. |
| Same message batch resent | No duplicate rows. |
| Simultaneous snapshots | Deterministic current snapshot; both remain in history. |
| Same UUID, different hash | Request is rejected as corrupted/conflicting. |
