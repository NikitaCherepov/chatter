#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$SCRIPT_DIR"
CONFIG_DIR="${CHATTER_CONFIG_DIR:-/var/lib/chatter}"
AUTH_WAS_PRESENT=0
[[ -f "$CONFIG_DIR/auth.json" ]] && AUTH_WAS_PRESENT=1
RESET_ADMIN=0

if [[ "${EUID}" -ne 0 ]]; then
  exec sudo --preserve-env=CHATTER_CONFIG_DIR,CHATTER_IMAGE_PREFIX,CHATTER_IMAGE_TAG,CHATTER_PUBLIC_HOST,SSH_CONNECTION bash "$0" "$@"
fi

log() {
  printf '\n[chatter] %s\n' "$1"
}

fail() {
  printf '\n[chatter] ERROR: %s\n' "$1" >&2
  exit 1
}

if [[ "${1:-}" == "--reset-admin" ]]; then
  RESET_ADMIN=1
elif [[ $# -gt 0 ]]; then
  fail "Unknown option: $1"
fi

random_hex() {
  openssl rand -hex "${1:-32}"
}

env_get() {
  local file="$1"
  local key="$2"
  [[ -f "$file" ]] || return 0
  sed -n "s/^${key}=//p" "$file" | tail -n 1
}

write_private_file() {
  local file="$1"
  shift
  umask 077
  printf '%s\n' "$@" > "$file"
  chmod 600 "$file"
}

find_free_port() {
  local candidate
  for _ in $(seq 1 100); do
    candidate="$(shuf -i 18000-40000 -n 1)"
    if ! ss -ltnH | awk '{print $4}' | grep -Eq "[:.]${candidate}$"; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

install_docker() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    return
  fi

  log "Installing Docker Engine and Compose plugin"
  . /etc/os-release
  [[ "$ID" == "ubuntu" || "$ID" == "debian" ]] || fail "The first installer version supports Ubuntu and Debian only."

  apt-get update
  apt-get install -y ca-certificates curl gnupg openssl iproute2
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/${ID}/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  local arch
  arch="$(dpkg --print-architecture)"
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' "$arch" "$ID" "$VERSION_CODENAME" > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
}

detect_ssh_port() {
  local port=""
  if [[ -n "${SSH_CONNECTION:-}" ]]; then
    port="$(awk '{print $4}' <<<"$SSH_CONNECTION")"
  elif command -v sshd >/dev/null 2>&1; then
    port="$(sshd -T 2>/dev/null | awk '$1 == "port" { print $2; exit }')"
  fi
  [[ "$port" =~ ^[0-9]+$ ]] || port=22
  printf '%s' "$port"
}

configure_firewall() {
  local ssh_port
  ssh_port="$(detect_ssh_port)"

  if ! command -v ufw >/dev/null 2>&1; then
    log "Installing UFW"
    apt-get update
    apt-get install -y ufw
  fi

  log "Allowing SSH, HTTP and HTTPS through UFW"
  if ! ufw status | grep -q '^Status: active'; then
    ufw default deny incoming >/dev/null
    ufw default allow outgoing >/dev/null
  fi
  ufw allow "${ssh_port}/tcp" comment 'SSH' >/dev/null
  ufw allow 80/tcp comment 'Chatter HTTP' >/dev/null
  ufw allow 443/tcp comment 'Chatter HTTPS' >/dev/null
  ufw --force enable >/dev/null

  # Older Chatter installers exposed the random manager port publicly.
  mapfile -t legacy_rules < <(
    ufw status numbered |
      sed -n 's/^\[[[:space:]]*\([0-9][0-9]*\)\].*Chatter Admin.*$/\1/p' |
      sort -rn
  )
  local rule
  for rule in "${legacy_rules[@]:-}"; do
    [[ -n "$rule" ]] && ufw --force delete "$rule" >/dev/null
  done
}

[[ -f "$PROJECT_DIR/docker-compose.yml" ]] || fail "Run install.sh from the cloned Chatter repository."
. /etc/os-release
[[ "$ID" == "ubuntu" || "$ID" == "debian" ]] || fail "The first installer version supports Ubuntu and Debian only."
command -v openssl >/dev/null 2>&1 || { apt-get update && apt-get install -y openssl; }
command -v ss >/dev/null 2>&1 || { apt-get update && apt-get install -y iproute2; }
command -v curl >/dev/null 2>&1 || { apt-get update && apt-get install -y ca-certificates curl; }
install_docker

install -d -m 700 "$CONFIG_DIR"

COMPOSE_ENV="$CONFIG_DIR/compose.env"
MANAGER_ENV="$CONFIG_DIR/manager.env"
BOOTSTRAP_PASSWORD_FILE="$CONFIG_DIR/admin.bootstrap"
BACKEND_ENV="$CONFIG_DIR/backend.env"
TELEGRAM_ENV="$CONFIG_DIR/telegram.env"
VOICE_ENV="$CONFIG_DIR/voice.env"
IMAGE_PREFIX="${CHATTER_IMAGE_PREFIX:-ghcr.io/nikitacherepov/chatter}"
IMAGE_TAG="${CHATTER_IMAGE_TAG:-latest}"

ADMIN_PORT="$(env_get "$COMPOSE_ENV" ADMIN_PORT)"
[[ "$ADMIN_PORT" =~ ^[0-9]+$ ]] || ADMIN_PORT="$(find_free_port)"

ADMIN_USERNAME="$(env_get "$MANAGER_ENV" ADMIN_USERNAME)"
[[ -n "$ADMIN_USERNAME" ]] || ADMIN_USERNAME="admin"

if [[ "$RESET_ADMIN" -eq 1 ]]; then
  rm -f "$CONFIG_DIR/auth.json" "$BOOTSTRAP_PASSWORD_FILE"
  AUTH_WAS_PRESENT=0
fi

ADMIN_PASSWORD=""
if [[ "$AUTH_WAS_PRESENT" -eq 0 ]]; then
  if [[ -s "$BOOTSTRAP_PASSWORD_FILE" ]]; then
    ADMIN_PASSWORD="$(<"$BOOTSTRAP_PASSWORD_FILE")"
  else
    ADMIN_PASSWORD="$(random_hex 16)"
    write_private_file "$BOOTSTRAP_PASSWORD_FILE" "$ADMIN_PASSWORD"
  fi
fi

SERVER_IP="${CHATTER_PUBLIC_HOST:-}"
[[ -n "$SERVER_IP" ]] || SERVER_IP="$(curl -4 -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
if [[ ! "$SERVER_IP" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
  SERVER_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
fi
[[ "$SERVER_IP" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || fail "Could not detect the public IPv4 address. Retry with CHATTER_PUBLIC_HOST=1.2.3.4."

if [[ ! -s "$CONFIG_DIR/tls.crt" || ! -s "$CONFIG_DIR/tls.key" ]]; then
  log "Creating an encrypted self-signed HTTPS endpoint"
  openssl req -x509 -nodes -newkey rsa:2048 -days 365 \
    -keyout "$CONFIG_DIR/tls.key" \
    -out "$CONFIG_DIR/tls.crt" \
    -subj "/CN=${SERVER_IP}" \
    -addext "subjectAltName=IP:${SERVER_IP}" >/dev/null 2>&1
  chmod 600 "$CONFIG_DIR/tls.key" "$CONFIG_DIR/tls.crt"
fi

if [[ ! -f "$BACKEND_ENV" ]]; then
  INTERNAL_TOKEN="$(random_hex 32)"
  write_private_file "$BACKEND_ENV" \
    "API_JWT_SECRET=$(random_hex 32)" \
    "BACKEND_INTERNAL_TOKEN=${INTERNAL_TOKEN}" \
    "ENCRYPTION_KEY=$(random_hex 32)" \
    "TIMEWEB_API_KEY=" \
    "TIMEWEB_BASE_URL=https://openrouter.ai/api/v1" \
    "TELEGRAM_TOKEN=" \
    "VOICE_TRANSCRIBE_URL=" \
    "VOICE_TRANSCRIBE_TOKEN="
else
  INTERNAL_TOKEN="$(env_get "$BACKEND_ENV" BACKEND_INTERNAL_TOKEN)"
  [[ -n "$INTERNAL_TOKEN" ]] || fail "BACKEND_INTERNAL_TOKEN is missing from ${BACKEND_ENV}."
fi

if [[ ! -f "$TELEGRAM_ENV" ]]; then
  write_private_file "$TELEGRAM_ENV" \
    "TELEGRAM_TOKEN=" \
    "BACKEND_INTERNAL_TOKEN=${INTERNAL_TOKEN}" \
    "NOTES_WEBAPP_URL=https://${SERVER_IP}/notes"
fi

if [[ ! -f "$VOICE_ENV" ]]; then
  write_private_file "$VOICE_ENV" \
    "VOICE_TRANSCRIBE_TOKEN=$(random_hex 32)" \
    "VOICE_API_PORT=3030" \
    "VOICE_TRANSCRIBE_LANGUAGE=auto" \
    "TTS_DEFAULT_LANGUAGE=ru" \
    "TTS_RU_PROVIDER=silero" \
    "TTS_EN_PROVIDER=piper"
fi

write_private_file "$MANAGER_ENV" \
  "ADMIN_USERNAME=${ADMIN_USERNAME}" \
  "ADMIN_TLS=1" \
  "ADMIN_TLS_CERT=/config/tls.crt" \
  "ADMIN_TLS_KEY=/config/tls.key"

write_private_file "$COMPOSE_ENV" \
  "BACKEND_ENV_FILE=${BACKEND_ENV}" \
  "TELEGRAM_ENV_FILE=${TELEGRAM_ENV}" \
  "VOICE_ENV_FILE=${VOICE_ENV}" \
  "CHATTER_MANAGER_ENV_FILE=${MANAGER_ENV}" \
  "CHATTER_CONFIG_DIR=${CONFIG_DIR}" \
  "CHATTER_PROJECT_DIR=${PROJECT_DIR}" \
  "CHATTER_DOCKER_CONFIG_DIR=/root/.docker" \
  "CHATTER_IMAGE_PREFIX=${IMAGE_PREFIX}" \
  "CHATTER_IMAGE_TAG=${IMAGE_TAG}" \
  "CHATTER_PULL_IMAGES=1" \
  "CHATTER_PUBLIC_HOST=${SERVER_IP}" \
  "CHATTER_PUBLIC_URL=https://${SERVER_IP}" \
  "ADMIN_BIND=127.0.0.1" \
  "ADMIN_PORT=${ADMIN_PORT}"

configure_firewall

log "Downloading ready-to-run Chatter images"
if ! docker compose --project-name chatter --env-file "$COMPOSE_ENV" --profile admin --profile gateway pull backend admin-panel chatter-manager gateway; then
  fail "Could not download Chatter images. While GHCR packages are private, run 'sudo docker login ghcr.io' and retry."
fi

log "Starting Chatter behind the HTTPS gateway"
docker compose --project-name chatter --env-file "$COMPOSE_ENV" --profile admin --profile gateway up -d --no-build backend admin-panel chatter-manager gateway

if [[ "$RESET_ADMIN" -eq 1 ]]; then
  docker compose --project-name chatter --env-file "$COMPOSE_ENV" --profile admin up -d --no-build --force-recreate chatter-manager
fi

for _ in $(seq 1 60); do
  if curl -kfsS --resolve "${SERVER_IP}:443:127.0.0.1" "https://${SERVER_IP}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
curl -fsS --resolve "${SERVER_IP}:443:127.0.0.1" "https://${SERVER_IP}/health" >/dev/null 2>&1 || fail "The HTTPS gateway did not become ready. Ensure provider firewalls allow TCP 80/443, then rerun install.sh. Logs: docker compose --project-name chatter --env-file ${COMPOSE_ENV} --profile gateway logs gateway"

printf '\nChatter is ready.\n\n'
printf '  URL:      https://%s\n' "$SERVER_IP"
if [[ "$AUTH_WAS_PRESENT" -eq 0 ]]; then
  printf '  Login:    %s\n' "$ADMIN_USERNAME"
  printf '  Password: %s\n\n' "$ADMIN_PASSWORD"
else
  printf '  Admin credentials were preserved from the existing installation.\n\n'
fi
printf 'Caddy manages the public IP certificate and renews it automatically.\n'
printf 'After login, configure the AI provider, Telegram and Voice in the panel.\n\n'
