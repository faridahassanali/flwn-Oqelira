#!/usr/bin/env bash
# VM-only garbage collection. Reserve e7a1e7a1-e7a1-* exclusively for prompt evaluation.
# Dry-run by default. The timer calls --apply; normal project volumes never match.
set -euo pipefail
mode="${1:---dry-run}"
[[ "$mode" == --apply || "$mode" == --dry-run ]] || exit 2
now=$(date +%s)
while IFS= read -r volume; do
  [[ "$volume" =~ ^oq-project-e7a1e7a1-e7a1-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || continue
  created=$(docker volume inspect --format '{{.CreatedAt}}' "$volume")
  created_epoch=$(date -d "$created" +%s)
  (( now - created_epoch >= 86400 )) || continue
  # An attached volume is never removed. Docker also rejects a concurrent attachment.
  [[ -z "$(docker ps -aq --filter "volume=$volume")" ]] || continue
  mountpoint=$(docker volume inspect --format '{{.Mountpoint}}' "$volume")
  # Keep volumes with fixture activity within the last day, even if created earlier.
  [[ -d "$mountpoint" ]] || continue
  modified=$(stat -c %Y -- "$mountpoint")
  (( now - modified >= 86400 )) || continue
  if [[ "$mode" == --apply ]]; then
    docker volume rm -- "$volume" || printf 'Skipped attached or unavailable evaluation volume: %s\n' "$volume" >&2
  else
    printf 'Would remove evaluation volume: %s\n' "$volume"
  fi
done < <(docker volume ls --format '{{.Name}}')
