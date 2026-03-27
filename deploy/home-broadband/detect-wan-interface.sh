#!/usr/bin/env bash
set -euo pipefail

iface="$(ip route show default 2>/dev/null | awk '/default/ {print $5; exit}')"

if [[ -z "${iface}" ]]; then
  echo "Could not detect the default WAN interface." >&2
  echo "Run: ip route show default" >&2
  exit 1
fi

echo "${iface}"
