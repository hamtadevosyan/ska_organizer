#!/usr/bin/env bash
set -euo pipefail
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
if [[ "${1:-}" == ai-check ]]; then
  shift
  exec bash "$repo/scripts/activity-ai-check.sh" "$@"
fi
exec python3 "$repo/scripts/ubuntu.py" "$@"
