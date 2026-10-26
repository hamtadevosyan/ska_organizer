#!/usr/bin/env bash
# Local statement reading for Ubuntu/Debian on ARM64 and x86_64.
set -euo pipefail
if ! command -v apt-get >/dev/null; then
  printf '%s\n' 'Install Poppler utilities and Tesseract with English language data on your server.' >&2
  exit 1
fi
if [ "$(id -u)" -ne 0 ]; then
  exec sudo -- bash "$0"
fi
apt-get --error-on=any update
apt-get -o DPkg::Lock::Timeout=600 install -y --no-install-recommends poppler-utils tesseract-ocr tesseract-ocr-eng util-linux python3-pil
for tool in pdfinfo pdftotext pdftoppm pdfimages tesseract prlimit python3; do
  command -v "$tool" >/dev/null
done
if ! python3 -c 'from PIL import Image, ImageOps' >/dev/null 2>&1; then
  printf '%s\n' 'Local photo orientation support was not found. Check the python3-pil installation above.' >&2
  exit 1
fi
if ! tesseract --list-langs 2>/dev/null | grep -qx 'eng'; then
  printf '%s\n' 'English OCR language data was not found. Check the package installation above.' >&2
  exit 1
fi
printf '%s\n' 'Local PDF and image reading is installed. No server restart is needed.'
