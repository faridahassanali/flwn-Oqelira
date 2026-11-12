#!/usr/bin/env bash
set -euo pipefail
docker() {
  case "$1 $2" in
    'volume ls') printf '%s\n' oq-project-11111111-1111-4111-8111-111111111111 oq-project-e7a1e7a1-e7a1-4000-8000-000000000001 oq-project-e7a1e7a1-e7a1-4000-8000-000000000002 oq-project-e7a1e7a1-e7a1-4000-8000-000000000003 oq-project-e7a1e7a1-e7a1-4000-8000-000000000004 ;;
    'volume inspect')
      if [[ "$4" == '{{.CreatedAt}}' ]]; then
        [[ "$5" == *000002 ]] && echo recent || echo old
      else
        [[ "$5" == *000004 ]] && echo deploy || echo .
      fi ;;
    'ps -aq') [[ "$4" == *000003 ]] && echo attached || true ;;
    'volume rm') echo "REMOVED:$4" ;;
    *) exit 99 ;;
  esac
}
date() { [[ "${1:-}" == +%s ]] && echo 200000 || { [[ "$2" == recent ]] && echo 199000 || echo 1000; }; }
stat() { [[ "$4" == deploy ]] && echo 199000 || echo 1000; }
export -f docker date stat
output=$(bash deploy/azure/cleanup-prompt-eval-volumes.sh --apply)
[[ "$output" == 'REMOVED:oq-project-e7a1e7a1-e7a1-4000-8000-000000000001' ]]
output=$(bash deploy/azure/cleanup-prompt-eval-volumes.sh)
[[ "$output" == 'Would remove evaluation volume: oq-project-e7a1e7a1-e7a1-4000-8000-000000000001' ]]
echo 'PASS: only expired, inactive evaluation volumes are removed'
