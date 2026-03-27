#!/usr/bin/env bash
set -euo pipefail

PROXY_PORT="${PROXY_PORT:-18443}"
PROXY_HOST="${PROXY_HOST:-127.0.0.1}"
PROXY_URL="http://${PROXY_HOST}:${PROXY_PORT}"
TARGET_URL="${TARGET_URL:-https://ifconfig.me}"

echo "Proxy: ${PROXY_URL}"
echo "Target: ${TARGET_URL}"
echo
curl --proxy "${PROXY_URL}" --connect-timeout 10 --max-time 20 -fsSL "${TARGET_URL}"
echo
