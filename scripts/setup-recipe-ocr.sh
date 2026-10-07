#!/usr/bin/env bash
# Optional local recipe-photo reader. Works on Ubuntu/Debian ARM64 and x86_64.
set -euo pipefail
if ! command -v apt-get >/dev/null; then
  printf '%s\n' 'This installer needs Ubuntu or Debian. Install Tesseract with English language data on your server.' >&2
  exit 1
fi
if [ "$(id -u)" -ne 0 ]; then
  exec sudo -- bash "$0"
fi
apt-get --error-on=any update
apt-get -o DPkg::Lock::Timeout=600 install -y --no-install-recommends tesseract-ocr tesseract-ocr-eng
tesseract --version
tesseract --list-langs
printf '%s\n' 'Recipe photo reading is installed. No server restart is needed. Open Meals > Meal Setup > Import recipe photo.'
