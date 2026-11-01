#!/usr/bin/env bash
set -euo pipefail
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
if [[ "${1:-}" == ai-check ]]; then
  shift
  exec bash "$repo/scripts/activity-ai-check.sh" "$@"
fi
if [[ "${1:-}" == ai-setup ]]; then
  shift
  exec bash "$repo/scripts/local-ai/pi/setup.sh" "$@"
fi
if [[ "${1:-}" == ai-diagnose ]]; then
  shift
  exec bash "$repo/scripts/local-ai/pi/setup.sh" --diagnose "$@"
fi
exec python3 "$repo/scripts/ubuntu.py" "$@"
