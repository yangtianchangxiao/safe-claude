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
  require_cmd nginx
  require_cmd systemctl

  : "${DOMAIN:?DOMAIN is required}"
  : "${SITE_NAME:=safe-claude}"

  local script_dir available enabled rendered
  script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
  rendered="${script_dir}/rendered/${SITE_NAME}.conf"
  available="/etc/nginx/sites-available/${SITE_NAME}.conf"
  enabled="/etc/nginx/sites-enabled/${SITE_NAME}.conf"

  mkdir -p "${script_dir}/rendered"
  "${script_dir}/render-nginx-site.sh" "${rendered}"

  cp "${rendered}" "${available}"
  ln -sfn "${available}" "${enabled}"

  nginx -t
  systemctl reload nginx

  cat <<EOF2
Nginx site installed.

Domain:
  ${DOMAIN}

Installed config:
  ${available}

Enabled symlink:
  ${enabled}

Next:
  1. Test http://${DOMAIN}/health
  2. If HTTP works, issue TLS cert with issue-certbot-certificate.sh
  3. Set ENABLE_TLS=true and re-run this script
EOF2
}

main "$@"
