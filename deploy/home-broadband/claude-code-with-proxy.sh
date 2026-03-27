#!/usr/bin/env bash
set -euo pipefail

PROXY_PORT="${PROXY_PORT:-18443}"
PROXY_HOST="${PROXY_HOST:-127.0.0.1}"
PROXY_URL="http://${PROXY_HOST}:${PROXY_PORT}"

export HTTPS_PROXY="${HTTPS_PROXY:-$PROXY_URL}"
export HTTP_PROXY="${HTTP_PROXY:-$PROXY_URL}"

if [[ "$#" -eq 0 ]]; then
  echo "Usage: $0 <command> [args...]" >&2
  echo "Example: $0 claude" >&2
  exit 1
fi

exec "$@"
