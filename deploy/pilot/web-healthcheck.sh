#!/bin/sh
set -eu

: "${PILOT_HOST:?PILOT_HOST is required for the HTTPS readiness check}"
ca_file="${XDG_DATA_HOME:-/data}/caddy/pki/authorities/local/root.crt"
if [ ! -s "$ca_file" ]; then
    printf 'Web readiness: the local CA certificate is not available yet.\n' >&2
    exit 1
fi

# Resolve inside this container while retaining the configured TLS identity.
# Show TLS/connection errors in Docker's health history; never print the body.
status=$(curl --fail --silent --show-error --noproxy '*' \
    --connect-timeout 3 --max-time 12 \
    --cacert "$ca_file" \
    --resolve "${PILOT_HOST}:8443:127.0.0.1" \
    --output /dev/null --write-out '%{http_code}' \
    "https://${PILOT_HOST}:8443/api/ready")
if [ "$status" != '200' ]; then
    printf 'Web readiness: expected HTTP 200, received %s.\n' "$status" >&2
    exit 1
fi
