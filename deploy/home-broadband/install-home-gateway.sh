#!/usr/bin/env bash
set -euo pipefail

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    echo "Run as root" >&2
    exit 1
  fi
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

main() {
  require_root
  require_cmd apt-get
  require_cmd python3

  : "${WG_INTERFACE:=wg-home}"
  : "${WG_LISTEN_PORT:=51820}"

  if [[ -z "${WG_ADDRESS:-}" || -z "${WG_PRIVATE_KEY:-}" || -z "${WG_CLIENT_PUBLIC_KEY:-}" || -z "${WG_CLIENT_ALLOWED_IP:-}" || -z "${WAN_INTERFACE:-}" ]]; then
    echo "WG_ADDRESS, WG_PRIVATE_KEY, WG_CLIENT_PUBLIC_KEY, WG_CLIENT_ALLOWED_IP, and WAN_INTERFACE are required" >&2
    exit 1
  fi

  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y wireguard-tools iptables

  local conf="/etc/wireguard/${WG_INTERFACE}.conf"
  local subnet
  subnet="$(python3 - <<'PY'
import ipaddress, os
print(ipaddress.ip_interface(os.environ["WG_ADDRESS"]).network)
PY
)"

  mkdir -p /etc/wireguard
  cat >"$conf" <<EOF
[Interface]
Address = ${WG_ADDRESS}
PrivateKey = ${WG_PRIVATE_KEY}
ListenPort = ${WG_LISTEN_PORT}
PostUp = sysctl -w net.ipv4.ip_forward=1; iptables -t nat -A POSTROUTING -s ${subnet} -o ${WAN_INTERFACE} -j MASQUERADE
PostDown = iptables -t nat -D POSTROUTING -s ${subnet} -o ${WAN_INTERFACE} -j MASQUERADE

[Peer]
PublicKey = ${WG_CLIENT_PUBLIC_KEY}
AllowedIPs = ${WG_CLIENT_ALLOWED_IP}
EOF

  chmod 600 "$conf"
  systemctl enable --now "wg-quick@${WG_INTERFACE}"

  cat <<EOF

Home-gateway egress installed.

Make sure your router forwards UDP ${WG_LISTEN_PORT} to this host if this machine is behind NAT.

Verify:
  systemctl status wg-quick@${WG_INTERFACE}.service --no-pager
  wg show ${WG_INTERFACE}
EOF
}

main "$@"
