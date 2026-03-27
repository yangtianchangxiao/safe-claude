#!/usr/bin/env bash
set -euo pipefail

OUT_PATH="${1:-}"

: "${DOMAIN:?DOMAIN is required}"
: "${SITE_NAME:=safe-claude}"
: "${UPSTREAM_HOST:=127.0.0.1}"
: "${UPSTREAM_PORT:=3000}"
: "${CLIENT_MAX_BODY_SIZE:=50M}"
: "${PROXY_CONNECT_TIMEOUT:=60s}"
: "${PROXY_SEND_TIMEOUT:=300s}"
: "${PROXY_READ_TIMEOUT:=300s}"
: "${ENABLE_TLS:=false}"
: "${TLS_CERT_PATH:=/etc/letsencrypt/live/${DOMAIN}/fullchain.pem}"
: "${TLS_KEY_PATH:=/etc/letsencrypt/live/${DOMAIN}/privkey.pem}"
: "${LETSENCRYPT_OPTIONS_PATH:=/etc/letsencrypt/options-ssl-nginx.conf}"
: "${LETSENCRYPT_DHPARAM_PATH:=/etc/letsencrypt/ssl-dhparams.pem}"

render_http_only() {
  cat <<EOF2
server {
    listen 80;
    server_name ${DOMAIN};

    client_max_body_size ${CLIENT_MAX_BODY_SIZE};

    location / {
        proxy_pass http://${UPSTREAM_HOST}:${UPSTREAM_PORT};
        proxy_buffering off;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
        proxy_connect_timeout ${PROXY_CONNECT_TIMEOUT};
        proxy_send_timeout ${PROXY_SEND_TIMEOUT};
        proxy_read_timeout ${PROXY_READ_TIMEOUT};
    }
}
EOF2
}

render_https() {
  cat <<EOF2
server {
    listen 80;
    server_name ${DOMAIN};

    client_max_body_size ${CLIENT_MAX_BODY_SIZE};

    return 301 https://\$host\$request_uri;
}

server {
    listen 443 ssl http2;
    server_name ${DOMAIN};

    client_max_body_size ${CLIENT_MAX_BODY_SIZE};

    ssl_certificate ${TLS_CERT_PATH};
    ssl_certificate_key ${TLS_KEY_PATH};
    include ${LETSENCRYPT_OPTIONS_PATH};
    ssl_dhparam ${LETSENCRYPT_DHPARAM_PATH};

    location / {
        proxy_pass http://${UPSTREAM_HOST}:${UPSTREAM_PORT};
        proxy_buffering off;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
        proxy_connect_timeout ${PROXY_CONNECT_TIMEOUT};
        proxy_send_timeout ${PROXY_SEND_TIMEOUT};
        proxy_read_timeout ${PROXY_READ_TIMEOUT};
    }
}
EOF2
}

if [[ -n "${OUT_PATH}" ]]; then
  mkdir -p "$(dirname "${OUT_PATH}")"
  if [[ "${ENABLE_TLS}" == "true" ]]; then
    render_https > "${OUT_PATH}"
  else
    render_http_only > "${OUT_PATH}"
  fi
else
  if [[ "${ENABLE_TLS}" == "true" ]]; then
    render_https
  else
    render_http_only
  fi
fi
