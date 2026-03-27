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
  require_cmd certbot

  : "${DOMAIN:?DOMAIN is required}"
  : "${CERTBOT_EMAIL:?CERTBOT_EMAIL is required}"

  certbot --nginx -d "${DOMAIN}" --non-interactive --agree-tos -m "${CERTBOT_EMAIL}" --redirect

  cat <<EOF2
Certificate request finished for ${DOMAIN}.

If you are using nginx-site.env, now set:
  ENABLE_TLS=true
  TLS_CERT_PATH=/etc/letsencrypt/live/${DOMAIN}/fullchain.pem
  TLS_KEY_PATH=/etc/letsencrypt/live/${DOMAIN}/privkey.pem

Then re-run install-nginx-site.sh.
EOF2
}

main "$@"
