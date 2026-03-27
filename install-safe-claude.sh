#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_NAME="safe-claude"
SERVICE_NAME="${SERVICE_NAME:-safe-claude}"
APP_USER="${SUDO_USER:-$(id -un)}"
NODE_MAJOR_REQUIRED=18

log() {
  echo "[$APP_NAME] $*"
}

run_as_app_user() {
  if [ "$(id -un)" = "$APP_USER" ]; then
    bash -lc "cd '$APP_DIR' && $*"
  else
    sudo -u "$APP_USER" bash -lc "cd '$APP_DIR' && $*"
  fi
}

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    exec sudo -E bash "$0" "$@"
  fi
}

install_system_packages() {
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y ca-certificates curl gnupg redis-server
}

ensure_system_node() {
  local need_install=1

  if command -v /usr/bin/node >/dev/null 2>&1; then
    local major
    major=$(/usr/bin/node -p 'process.versions.node.split(".")[0]')
    if [ "$major" -ge "$NODE_MAJOR_REQUIRED" ]; then
      need_install=0
    fi
  fi

  if [ "$need_install" -eq 1 ]; then
    log "Installing Node.js ${NODE_MAJOR_REQUIRED}+"
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
  else
    log "Node.js is already good enough"
  fi
}

ensure_env_file() {
  if [ ! -f "$APP_DIR/.env" ]; then
    cp "$APP_DIR/.env.example" "$APP_DIR/.env"
    log "Created .env from .env.example"
  fi

  if grep -q '^JWT_SECRET=your-jwt-secret-here$' "$APP_DIR/.env"; then
    sed -i "s#^JWT_SECRET=.*#JWT_SECRET=$(openssl rand -hex 64)#" "$APP_DIR/.env"
  fi

  if grep -q '^ENCRYPTION_KEY=your-encryption-key-here$' "$APP_DIR/.env"; then
    sed -i "s#^ENCRYPTION_KEY=.*#ENCRYPTION_KEY=$(openssl rand -hex 32)#" "$APP_DIR/.env"
  fi
}

install_node_modules() {
  chown -R "$APP_USER":"$APP_USER" "$APP_DIR"
  if [ -f "$APP_DIR/package-lock.json" ]; then
    run_as_app_user "npm ci --omit=dev"
  else
    run_as_app_user "npm install --omit=dev"
  fi
}

initialize_app() {
  if [ ! -f "$APP_DIR/data/init.json" ]; then
    log "Running first-time setup"
    run_as_app_user "npm run setup"
  else
    log "data/init.json already exists, skipping setup"
  fi
}

write_service_file() {
  local npm_bin node_bin unit_file
  npm_bin="$(command -v npm)"
  node_bin="$(command -v node)"
  unit_file="/etc/systemd/system/${SERVICE_NAME}.service"

  cat > "$unit_file" <<UNIT
[Unit]
Description=Safe Claude
After=network.target redis-server.service
Wants=redis-server.service

[Service]
Type=simple
User=${APP_USER}
WorkingDirectory=${APP_DIR}
Environment=NODE_ENV=production
ExecStart=${npm_bin} start
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT

  log "Wrote systemd unit: ${unit_file}"
  log "Using Node at: ${node_bin}"
}

start_services() {
  systemctl enable redis-server >/dev/null 2>&1 || true
  systemctl restart redis-server
  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME"
  systemctl restart "$SERVICE_NAME"
}

show_result() {
  local ip
  ip=$(hostname -I 2>/dev/null | awk '{print $1}')
  echo
  log "Install finished"
  echo
  echo "Open these URLs:"
  echo "  Admin : http://${ip:-YOUR_IP}:3000/admin-next/"
  echo "  API   : http://${ip:-YOUR_IP}:3000/api/v1/messages"
  echo "  Health: http://${ip:-YOUR_IP}:3000/health"
  echo
  echo "Useful commands:"
  echo "  sudo systemctl status ${SERVICE_NAME}"
  echo "  sudo journalctl -u ${SERVICE_NAME} -f"
  echo
  echo "Next steps:"
  echo "  1. Log in to the admin UI"
  echo "  2. Add a Claude account"
  echo "  3. Create a cr_... API key"
  echo "  4. Point Claude Code to http://YOUR_IP:3000/api or your domain"
}

main() {
  require_root "$@"
  log "Installing ${APP_NAME} from ${APP_DIR}"
  install_system_packages
  ensure_system_node
  ensure_env_file
  install_node_modules
  initialize_app
  write_service_file
  start_services
  show_result
}

main "$@"
