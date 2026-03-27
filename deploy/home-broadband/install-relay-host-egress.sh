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

install_packages() {
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y tinyproxy wireguard-tools
}

write_tinyproxy_config() {
  local conf="/etc/tinyproxy/${PROXY_SERVICE_NAME}.conf"
  cat >"$conf" <<EOF
User ${PROXY_USER}
Group tinyproxy
Port ${PROXY_PORT}
Listen ${PROXY_LISTEN}
Timeout ${PROXY_TIMEOUT}
DefaultErrorFile "/usr/share/tinyproxy/default.html"
StatFile "/usr/share/tinyproxy/stats.html"
LogFile "/var/log/tinyproxy/${PROXY_SERVICE_NAME}.log"
LogLevel Info
PidFile "/run/tinyproxy/${PROXY_SERVICE_NAME}.pid"
MaxClients ${PROXY_MAX_CLIENTS}
Allow 127.0.0.1
Allow ::1
EOF
}

write_tinyproxy_service() {
  local unit="/etc/systemd/system/${PROXY_SERVICE_NAME}.service"
  cat >"$unit" <<EOF
[Unit]
Description=Tinyproxy (Claude egress) HTTP Proxy
After=network.target
Documentation=man:tinyproxy(8) man:tinyproxy.conf(5)

[Service]
Type=simple
ExecStart=/usr/bin/tinyproxy -d -c /etc/tinyproxy/${PROXY_SERVICE_NAME}.conf
ExecReload=/bin/kill -USR1 \$MAINPID
PrivateDevices=yes
KillMode=process
KillSignal=SIGTERM
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
EOF
}

write_wireguard_config() {
  local uid
  uid="$(id -u "${PROXY_USER}")"
  local conf="/etc/wireguard/${WG_INTERFACE}.conf"

  grep -Eq "^[[:space:]]*${WG_ROUTE_TABLE_ID}[[:space:]]+claude_egress$" /etc/iproute2/rt_tables 2>/dev/null ||
    echo "${WG_ROUTE_TABLE_ID} claude_egress" >> /etc/iproute2/rt_tables

  cat >"$conf" <<EOF
[Interface]
Address = ${WG_ADDRESS}
PrivateKey = ${WG_PRIVATE_KEY}
Table = off
PostUp = ip rule add uidrange ${uid}-${uid} table ${WG_ROUTE_TABLE_ID}; ip route add default dev ${WG_INTERFACE} table ${WG_ROUTE_TABLE_ID}
PostDown = ip rule del uidrange ${uid}-${uid} table ${WG_ROUTE_TABLE_ID}; ip route del default dev ${WG_INTERFACE} table ${WG_ROUTE_TABLE_ID}

[Peer]
PublicKey = ${WG_PEER_PUBLIC_KEY}
AllowedIPs = ${WG_ALLOWED_IPS}
Endpoint = ${WG_ENDPOINT}
PersistentKeepalive = ${WG_PERSISTENT_KEEPALIVE}
EOF
}

main() {
  require_root

  : "${PROXY_SERVICE_NAME:=tinyproxy-claude}"
  : "${PROXY_USER:=claudeproxy}"
  : "${PROXY_PORT:=18443}"
  : "${PROXY_LISTEN:=127.0.0.1}"
  : "${PROXY_TIMEOUT:=600}"
  : "${PROXY_MAX_CLIENTS:=100}"
  : "${WG_INTERFACE:=wg-claude}"
  : "${WG_ROUTE_TABLE_ID:=184}"
  : "${WG_ALLOWED_IPS:=0.0.0.0/0}"
  : "${WG_PERSISTENT_KEEPALIVE:=25}"

  require_cmd apt-get
  install_packages

  id "${PROXY_USER}" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin "${PROXY_USER}"
  getent group tinyproxy >/dev/null 2>&1 || groupadd --system tinyproxy

  mkdir -p /etc/tinyproxy /var/log/tinyproxy
  chown root:root /etc/tinyproxy
  write_tinyproxy_config
  write_tinyproxy_service

  if [[ -n "${WG_ADDRESS:-}" && -n "${WG_PRIVATE_KEY:-}" && -n "${WG_PEER_PUBLIC_KEY:-}" && -n "${WG_ENDPOINT:-}" ]]; then
    mkdir -p /etc/wireguard
    write_wireguard_config
    chmod 600 "/etc/wireguard/${WG_INTERFACE}.conf"
    systemctl enable --now "wg-quick@${WG_INTERFACE}"
  else
    echo "Skipping WireGuard client config because WG_* variables are incomplete"
  fi

  systemctl daemon-reload
  systemctl enable --now "${PROXY_SERVICE_NAME}.service"

  cat <<EOF

Relay-host egress installed.

Proxy URL:
  http://${PROXY_LISTEN}:${PROXY_PORT}

Claude Code:
  export HTTPS_PROXY=http://${PROXY_LISTEN}:${PROXY_PORT}
  export HTTP_PROXY=\$HTTPS_PROXY

Verify:
  systemctl status ${PROXY_SERVICE_NAME}.service --no-pager
  systemctl status wg-quick@${WG_INTERFACE}.service --no-pager
EOF
}

main "$@"
