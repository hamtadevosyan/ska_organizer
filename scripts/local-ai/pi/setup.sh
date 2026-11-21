#!/usr/bin/env bash
set -euo pipefail
script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'FAIL: Node.js 22 or newer is required for private AI setup.' >&2
  exit 1
fi
exec node "$script_directory/setup.cjs" "$@"
