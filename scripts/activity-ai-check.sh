#!/usr/bin/env bash
# Read-only local AI diagnostics. Does not install, pull models or use sudo.
set -euo pipefail
if (($#)); then
  printf 'Usage: bash SKAO.sh ai-check\nChecks the checkout configuration and local AI runtime without changing anything.\n' >&2
  exit 2
fi
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
exec node "$repo/server/scripts/check-activity-ai.js"
