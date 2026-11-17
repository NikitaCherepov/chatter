#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_PATH="${BASH_SOURCE[0]:-}"
PROJECT_DIR=""
if [[ -n "$SCRIPT_PATH" && -f "$SCRIPT_PATH" ]]; then
  PROJECT_DIR="$(cd -- "$(dirname -- "$SCRIPT_PATH")" && pwd)"
fi
CONFIG_DIR="${CHATTER_CONFIG_DIR:-/var/lib/chatter}"
INSTALL_DIR="${CHATTER_INSTALL_DIR:-/opt/chatter}"
SOURCE_REF="${CHATTER_SOURCE_REF:-main}"
SOURCE_BASE_URL="https://raw.githubusercontent.com/NikitaCherepov/chatter/${SOURCE_REF}"
RESET_ADMIN=0
GATEWAY_ENABLED=""
FIREWALL_MODE=auto
HTTPS_PORT="${CHATTER_HTTPS_PORT:-}"

log() {
  printf '\n[chatter] %s\n' "$1"
}

fail() {
  printf '\n[chatter] ERROR: %s\n' "$1" >&2
  exit 1
}

if [[ "$EUID" -ne 0 ]]; then
  sudo_options=(--preserve-env=CHATTER_CONFIG_DIR,CHATTER_INSTALL_DIR,CHATTER_SOURCE_REF,CHATTER_IMAGE_PREFIX,CHATTER_IMAGE_TAG,CHATTER_PUBLIC_HOST,CHATTER_PUBLIC_URL,CHATTER_HTTPS_PORT,GH_TOKEN,GH_USERNAME,SSH_CONNECTION)
  if [[ -n "$PROJECT_DIR" ]]; then
    exec sudo "${sudo_options[@]}" bash "$SCRIPT_PATH" "$@"
  fi
  # stdin is already being consumed by Bash. Elevate a fresh download.
  exec sudo "${sudo_options[@]}" bash -c '
    set -e
    installer="$(mktemp)"
    trap '\''rm -f -- "$installer"'\'' EXIT
    curl_args=(-fsSL --retry 3 --connect-timeout 10)
    if [[ -n "${GH_TOKEN:-}" ]]; then curl_args+=(-H "Authorization: Bearer ${GH_TOKEN}"); fi
    curl "${curl_args[@]}" "$1/install.sh" -o "$installer"
    shift
    CHATTER_BOOTSTRAP_FROM_STDIN=1 bash "$installer" "$@"
  ' bash "$SOURCE_BASE_URL" "$@"
fi

for arg in "$@"; do
  case "$arg" in
    --reset-admin) RESET_ADMIN=1 ;;
    --gateway) GATEWAY_ENABLED=1 ;;
    --no-gateway) GATEWAY_ENABLED=0 ;;
    --enable-ufw) FIREWALL_MODE=enable ;;
    --skip-firewall) FIREWALL_MODE=skip ;;
    --https-port=*) HTTPS_PORT="${arg#*=}"; [[ -n "$HTTPS_PORT" ]] || fail "Specify --https-port=PORT." ;;
    *) fail "Unknown option: $arg" ;;
  esac
done

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
  local temp
  temp="$(mktemp "${file}.XXXXXX")"
  printf '%s\n' "$@" > "$temp"
  mv -f -- "$temp" "$file"
}

find_free_port() {
  local candidate
  for _ in $(seq 1 100); do
    candidate="$(shuf -i 18000-40000 -n 1)"
    if [[ "$candidate" != "$HTTPS_PORT" && "$candidate" != "$BACKEND_PORT" && -z "$(ss -Hltn "sport = :${candidate}")" ]]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

valid_port() {
  [[ "$1" =~ ^[1-9][0-9]{0,4}$ ]] && (( $1 <= 65535 ))
}

install_compose_plugin() {
  local package plan changes
  apt-get update
  for package in docker-compose-v2 docker-compose-plugin docker-compose; do
    if [[ "$package" == docker-compose && "$(apt-cache policy "$package" | awk '/Candidate:/{print $2}')" != 2.* ]]; then
      continue
    fi
    plan="$(LC_ALL=C apt-get -s --no-remove install "$package" 2>/dev/null)" || continue
    changes="$(awk '$1 == "Inst" { sub(/:.*/, "", $2); print $2 }' <<<"$plan")"
    if grep -q '^Remv ' <<<"$plan" ||
      grep -Exq 'docker|docker\.io|docker-engine|docker-ce(-cli|-rootless-extras)?|docker-desktop|containerd(\.io)?|runc|moby-(engine|cli|containerd|runc)' <<<"$changes"; then
      continue
    fi
    log "Installing Compose v2 for the existing Docker Engine"
    apt-get install -y --no-remove "$package"
    docker compose version >/dev/null 2>&1 && return 0
  done
  fail "Docker is already installed. Install or repair its Compose v2 plugin and rerun Chatter's installer."
}

check_docker() {
  local fresh_install="$1"
  if docker -H unix:///var/run/docker.sock info >/dev/null 2>&1; then
    return 0
  fi
  if [[ "$fresh_install" == 1 ]] && journalctl -u docker.service -b -n 40 --no-pager |
    grep -F 'no sockets found via socket activation' >/dev/null; then
    log "Recovering Docker socket activation"
    systemctl daemon-reload &&
      systemctl stop docker.service docker.socket &&
      systemctl reset-failed docker.service docker.socket &&
      systemctl enable --now docker.socket &&
      systemctl enable --now docker.service || true
  fi
  docker -H unix:///var/run/docker.sock info >/dev/null 2>&1 ||
    fail "Docker is not responding on /var/run/docker.sock. Check: systemctl status docker.service docker.socket; journalctl -u docker.service -b"
}

install_docker() {
  if command -v docker >/dev/null 2>&1; then
    check_docker 0
    docker compose version >/dev/null 2>&1 || install_compose_plugin
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
  apt-get install -y --no-remove docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker.service || true
  check_docker 1
  docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 did not start."
}

check_port() {
  local port="$1" service="$2" listeners name project owner published target host
  local filter="sport = :${port}"
  local owned=0
  if [[ "$service" != gateway ]]; then
    filter+=" and ( src 127.0.0.1 or src 0.0.0.0 or src :: )"
  fi
  listeners="$(ss -Hltnp "$filter")" || fail "Could not check TCP port ${port}."
  if [[ -n "${RUNNING_CONTAINERS:-}" ]]; then
    while IFS='|' read -r name project owner published target host; do
      [[ "$published" == "$port" && "$target" == */tcp ]] || continue
      if [[ "$service" != gateway && "$host" != 127.0.0.1 && "$host" != 0.0.0.0 && "$host" != :: ]]; then
        continue
      fi
      if [[ "$project" == chatter && "$owner" == "$service" ]]; then
        owned=1
      else
        printf 'TCP port %s for %s is already published by Docker container %s.\n' "$port" "$service" "${name#/}" >&2
        return 1
      fi
    done <<<"$RUNNING_CONTAINERS"
  fi
  if [[ -n "$listeners" ]]; then
    if [[ "$owned" == 1 ]]; then
      listeners="$(sed '/users:(("docker-proxy",/d' <<<"$listeners")"
    fi
    if [[ -n "$listeners" ]]; then
      printf 'TCP port %s for %s is already in use:\n%s\n' "$port" "$service" "$listeners" >&2
      return 1
    fi
  fi
}

running_container_ports() {
  local ids
  local -a container_ids
  if command -v docker >/dev/null 2>&1; then
    ids="$(docker ps -q 2>/dev/null)" || ids=""
    if [[ -n "$ids" ]]; then
      mapfile -t container_ids <<<"$ids"
      docker inspect --format '{{range $port, $bindings := .NetworkSettings.Ports}}{{range $bindings}}{{$.Name}}|{{index $.Config.Labels "com.docker.compose.project"}}|{{index $.Config.Labels "com.docker.compose.service"}}|{{.HostPort}}|{{$port}}|{{.HostIp}}{{println}}{{end}}{{end}}' "${container_ids[@]}" 2>/dev/null || true
    fi
  fi
}

prompt_gateway_port_conflict() {
  local port="$1" terminal choice replacement suggestion=8443
  if [[ "$HTTPS_PORT" == 8443 ]]; then suggestion=9443; fi
  if ! { exec {terminal}<>/dev/tty; } 2>/dev/null; then
    if [[ "$port" == 80 ]]; then
      fail "Free TCP port 80 for certificate validation or rerun with --no-gateway."
    fi
    fail "Free TCP port ${port}, or rerun with --https-port=${suggestion} or --no-gateway."
  fi

  while true; do
    printf '\nHow should Chatter proceed?\n' >&"$terminal"
    if [[ "$port" == 80 ]]; then
      printf 'The built-in gateway uses TCP port 80 for HTTP and certificate validation.\n' >&"$terminal"
    else
      printf '  p) Choose a different HTTPS port\n' >&"$terminal"
    fi
    printf '  n) Continue without the built-in gateway\n  r) Recheck the port\n  q) Quit\n> ' >&"$terminal"
    IFS= read -r choice <&"$terminal" || fail "Installation cancelled."
    case "$choice" in
      p|P)
        [[ "$port" != 80 ]] || continue
        printf 'HTTPS port [%s]: ' "$suggestion" >&"$terminal"
        IFS= read -r replacement <&"$terminal" || fail "Installation cancelled."
        replacement="${replacement:-$suggestion}"
        if valid_port "$replacement" && [[ "$replacement" != 80 && "$replacement" != "$BACKEND_PORT" && "$replacement" != "$ADMIN_PORT" ]]; then
          HTTPS_PORT="$replacement"
          break
        fi
        printf 'Choose a port from 1 to 65535 that is not reserved by Chatter.\n' >&"$terminal"
        ;;
      n|N) GATEWAY_ENABLED=0; break ;;
      r|R) break ;;
      q|Q) fail "Installation cancelled." ;;
    esac
  done
  exec {terminal}>&-
}

check_ports() {
  local RUNNING_CONTAINERS
  while true; do
    RUNNING_CONTAINERS="$(running_container_ports)"
    if [[ "$GATEWAY_ENABLED" != 1 ]]; then
      break
    elif ! check_port 80 gateway; then
      prompt_gateway_port_conflict 80
    elif ! check_port "$HTTPS_PORT" gateway; then
      prompt_gateway_port_conflict "$HTTPS_PORT"
    else
      break
    fi
  done
  check_port "$BACKEND_PORT" backend || fail "Free the backend port and retry."
  check_port "$ADMIN_PORT" chatter-manager || fail "Free the manager port and retry."
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
  [[ "$FIREWALL_MODE" != skip ]] || return 0
  [[ "$GATEWAY_ENABLED" == 1 || "$FIREWALL_MODE" == enable ]] || return 0
  local status

  if ! command -v ufw >/dev/null 2>&1; then
    [[ "$FIREWALL_MODE" == enable ]] || return 0
    log "Installing UFW"
    apt-get update
    apt-get install -y ufw
  fi

  status="$(LC_ALL=C ufw status)"
  if [[ "$status" != "Status: active"* ]]; then
    [[ "$FIREWALL_MODE" == enable ]] || return 0
    ufw allow "$(detect_ssh_port)/tcp" comment 'SSH' >/dev/null
    ufw default deny incoming >/dev/null
    ufw default allow outgoing >/dev/null
  fi
  if [[ "$GATEWAY_ENABLED" == 1 ]]; then
    log "Allowing TCP ports 80 and ${HTTPS_PORT} through UFW"
    ufw allow 80/tcp comment 'Chatter HTTP' >/dev/null
    ufw allow "${HTTPS_PORT}/tcp" comment 'Chatter HTTPS' >/dev/null
  fi
  if [[ "$status" != "Status: active"* ]]; then
    ufw --force enable >/dev/null
  fi
}

download_source_file() {
  local source_path="$1"
  local destination="$2"
  local curl_args=(-fsSL --retry 3 --connect-timeout 10)

  if [[ -n "${GH_TOKEN:-}" ]]; then
    curl_args+=(-H "Authorization: Bearer ${GH_TOKEN}")
  fi

  curl "${curl_args[@]}" "${SOURCE_BASE_URL}/${source_path}" -o "$destination"
}

bootstrap_installation() {
  local staging_dir managed_path
  local -a managed_files=()
  staging_dir="$(mktemp -d)"
  trap 'rm -rf -- "$staging_dir"' EXIT

  log "Downloading Chatter installation files"
  install -d -m 755 "$staging_dir/deploy" "$INSTALL_DIR/deploy"
  download_source_file install.sh "$staging_dir/install.sh" || fail "Could not download install.sh from GitHub."
  download_source_file docker-compose.yml "$staging_dir/docker-compose.yml" || fail "Could not download docker-compose.yml from GitHub."
  download_source_file deploy/managed-files.txt "$staging_dir/deploy/managed-files.txt" || fail "Could not download the managed deployment file manifest from GitHub."

  while IFS= read -r managed_path || [[ -n "$managed_path" ]]; do
    managed_path="${managed_path%%#*}"
    managed_path="${managed_path#"${managed_path%%[![:space:]]*}"}"
    managed_path="${managed_path%"${managed_path##*[![:space:]]}"}"
    [[ -n "$managed_path" ]] || continue
    if [[ ! "$managed_path" =~ ^deploy/[A-Za-z0-9._/-]+$ ]] || [[ "$managed_path" == *"//"* || "$managed_path" == *"/./"* || "$managed_path" == *"/../"* ]] || [[ "$managed_path" == */. || "$managed_path" == */.. ]]; then
      fail "Invalid managed deployment path: ${managed_path}"
    fi
    managed_files+=("$managed_path")
    install -d -m 755 "$(dirname "$staging_dir/$managed_path")" "$(dirname "$INSTALL_DIR/$managed_path")"
    download_source_file "$managed_path" "$staging_dir/$managed_path" || fail "Could not download ${managed_path} from GitHub."
  done < "$staging_dir/deploy/managed-files.txt"

  install -m 755 "$staging_dir/install.sh" "$INSTALL_DIR/install.sh"
  install -m 644 "$staging_dir/docker-compose.yml" "$INSTALL_DIR/docker-compose.yml"
  install -m 644 "$staging_dir/deploy/managed-files.txt" "$INSTALL_DIR/deploy/managed-files.txt"
  for managed_path in "${managed_files[@]}"; do
    install -m 644 "$staging_dir/$managed_path" "$INSTALL_DIR/$managed_path"
  done

  log "Continuing installation from ${INSTALL_DIR}"
  rm -rf -- "$staging_dir"
  trap - EXIT
  exec env -u CHATTER_BOOTSTRAP_FROM_STDIN bash "$INSTALL_DIR/install.sh" "$@"
}

if [[ "${CHATTER_BOOTSTRAP_FROM_STDIN:-}" == 1 || -z "$PROJECT_DIR" || ! -f "$PROJECT_DIR/docker-compose.yml" ]]; then
  bootstrap_installation "$@"
fi

# Docker Compose resolves its default compose file from the current working
# directory. Bootstrap installations are executed from /opt/chatter while the
# caller may still be in $HOME, so always enter the installed project directory.
cd "$PROJECT_DIR"

. /etc/os-release
[[ "$ID" == "ubuntu" || "$ID" == "debian" ]] || fail "The first installer version supports Ubuntu and Debian only."
command -v openssl >/dev/null 2>&1 || { apt-get update && apt-get install -y openssl; }
command -v ss >/dev/null 2>&1 || { apt-get update && apt-get install -y iproute2; }
command -v curl >/dev/null 2>&1 || { apt-get update && apt-get install -y ca-certificates curl; }

install -d -m 700 "$CONFIG_DIR"
exec 9>"$CONFIG_DIR/install.lock"
flock -n 9 || fail "Another Chatter installation is using ${CONFIG_DIR}."

COMPOSE_ENV="$CONFIG_DIR/compose.env"
MANAGER_ENV="$CONFIG_DIR/manager.env"
BOOTSTRAP_PASSWORD_FILE="$CONFIG_DIR/admin.bootstrap"
PENDING_PASSWORD_FILE="$CONFIG_DIR/admin.pending"
BACKEND_ENV="$CONFIG_DIR/backend.env"
TELEGRAM_ENV="$CONFIG_DIR/telegram.env"
VOICE_ENV="$CONFIG_DIR/voice.env"
IMAGE_PREFIX="${CHATTER_IMAGE_PREFIX:-ghcr.io/nikitacherepov/chatter}"
IMAGE_TAG="${CHATTER_IMAGE_TAG:-latest}"

PREVIOUS_GATEWAY_ENABLED="$(env_get "$COMPOSE_ENV" CHATTER_GATEWAY_ENABLED)"
GATEWAY_ENABLED="${GATEWAY_ENABLED:-${PREVIOUS_GATEWAY_ENABLED:-1}}"
[[ "$GATEWAY_ENABLED" == 0 || "$GATEWAY_ENABLED" == 1 ]] || fail "Invalid saved gateway mode."
HTTPS_PORT="${HTTPS_PORT:-$(env_get "$COMPOSE_ENV" CHATTER_HTTPS_PORT)}"
HTTPS_PORT="${HTTPS_PORT:-443}"
valid_port "$HTTPS_PORT" ||
  fail "Invalid HTTPS port: ${HTTPS_PORT}. Use a port from 1 to 65535."

BACKEND_PORT="${BACKEND_PORT:-$(env_get "$COMPOSE_ENV" BACKEND_PORT)}"
BACKEND_PORT="${BACKEND_PORT:-3050}"
valid_port "$BACKEND_PORT" ||
  fail "Invalid backend port: ${BACKEND_PORT}."
ADMIN_PORT="$(env_get "$COMPOSE_ENV" ADMIN_PORT)"
valid_port "$ADMIN_PORT" ||
  ADMIN_PORT="$(find_free_port)" || fail "Could not find a free port for the manager."
[[ "$BACKEND_PORT" != "$ADMIN_PORT" ]] || fail "Backend and manager must use different ports."
if [[ "$GATEWAY_ENABLED" == 1 ]]; then
  for port in 80 "$BACKEND_PORT" "$ADMIN_PORT"; do
    [[ "$HTTPS_PORT" != "$port" ]] || fail "HTTPS port ${HTTPS_PORT} conflicts with another Chatter port."
  done
  [[ "$BACKEND_PORT" != 80 && "$ADMIN_PORT" != 80 ]] || fail "TCP port 80 is reserved for the gateway."
fi

# The deployment and manager both operate on the local Docker socket.
unset DOCKER_CONTEXT COMPOSE_PROFILES
export DOCKER_HOST=unix:///var/run/docker.sock
check_ports
install_docker
check_ports

if [[ -n "${GH_TOKEN:-}" ]]; then
  log "Signing in to the private GitHub container registry"
  printf '%s' "$GH_TOKEN" | docker login ghcr.io --username "${GH_USERNAME:-NikitaCherepov}" --password-stdin >/dev/null
fi

ADMIN_USERNAME="$(env_get "$MANAGER_ENV" ADMIN_USERNAME)"
[[ -n "$ADMIN_USERNAME" ]] || ADMIN_USERNAME="admin"

SERVER_IP="${CHATTER_PUBLIC_HOST:-}"
[[ -n "$SERVER_IP" ]] || SERVER_IP="$(env_get "$COMPOSE_ENV" CHATTER_PUBLIC_HOST)"
PREVIOUS_PUBLIC_URL="$(env_get "$COMPOSE_ENV" CHATTER_PUBLIC_URL)"
if [[ "$GATEWAY_ENABLED" == 1 ]]; then
  if [[ -z "$SERVER_IP" || "$SERVER_IP" == 127.0.0.1 ]]; then
    SERVER_IP="$(curl -4 -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
  fi
  if [[ ! "$SERVER_IP" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
    SERVER_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
  fi
  [[ "$SERVER_IP" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || fail "Could not detect the public IPv4 address. Retry with CHATTER_PUBLIC_HOST=1.2.3.4."
  PUBLIC_URL="https://${SERVER_IP}"
  [[ "$HTTPS_PORT" == 443 ]] || PUBLIC_URL+=":${HTTPS_PORT}"
else
  [[ "$SERVER_IP" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || SERVER_IP=127.0.0.1
  PUBLIC_URL="${CHATTER_PUBLIC_URL:-}"
  if [[ ! -v CHATTER_PUBLIC_URL && "$PREVIOUS_GATEWAY_ENABLED" == 0 ]]; then
    PUBLIC_URL="$PREVIOUS_PUBLIC_URL"
  fi
  [[ -z "$PUBLIC_URL" || "$PUBLIC_URL" =~ ^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?$ ]] ||
    fail "CHATTER_PUBLIC_URL must be an HTTPS origin, for example https://chatter.example.org."
fi
export CHATTER_GATEWAY_ENABLED="$GATEWAY_ENABLED" CHATTER_HTTPS_PORT="$HTTPS_PORT"
export CHATTER_PUBLIC_HOST="$SERVER_IP" CHATTER_PUBLIC_URL="$PUBLIC_URL" ADMIN_PORT BACKEND_PORT

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
    "BACKEND_SCHEDULER_ENABLED=1" \
    "TIMEWEB_API_KEY=" \
    "TIMEWEB_BASE_URL=https://openrouter.ai/api/v1" \
    "TELEGRAM_TOKEN=" \
    "VOICE_TRANSCRIBE_URL=" \
    "VOICE_TRANSCRIBE_TOKEN="
else
  INTERNAL_TOKEN="$(env_get "$BACKEND_ENV" BACKEND_INTERNAL_TOKEN)"
  [[ -n "$INTERNAL_TOKEN" ]] || fail "BACKEND_INTERNAL_TOKEN is missing from ${BACKEND_ENV}."
fi

NOTES_URL="${PUBLIC_URL:+${PUBLIC_URL}/notes}"
if [[ ! -f "$TELEGRAM_ENV" ]]; then
  write_private_file "$TELEGRAM_ENV" \
    "TELEGRAM_TOKEN=" \
    "BACKEND_INTERNAL_TOKEN=${INTERNAL_TOKEN}" \
    "NOTES_WEBAPP_URL=${NOTES_URL}"
else
  existing_notes_url="$(env_get "$TELEGRAM_ENV" NOTES_WEBAPP_URL)"
  if [[ "$existing_notes_url" != "$NOTES_URL" && ( -z "$existing_notes_url" || "$existing_notes_url" == "${PREVIOUS_PUBLIC_URL}/notes" ) ]]; then
    telegram_config="$(sed '/^NOTES_WEBAPP_URL=/d' "$TELEGRAM_ENV")"
    write_private_file "$TELEGRAM_ENV" "$telegram_config" "NOTES_WEBAPP_URL=${NOTES_URL}"
  fi
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
  "CHATTER_GATEWAY_ENABLED=${GATEWAY_ENABLED}" \
  "CHATTER_HTTPS_PORT=${HTTPS_PORT}" \
  "CHATTER_PUBLIC_HOST=${SERVER_IP}" \
  "CHATTER_PUBLIC_URL=${PUBLIC_URL}" \
  "BACKEND_PORT=${BACKEND_PORT}" \
  "ADMIN_BIND=127.0.0.1" \
  "ADMIN_PORT=${ADMIN_PORT}"

configure_firewall

COMPOSE=(docker compose --project-name chatter --env-file "$COMPOSE_ENV" -f "$PROJECT_DIR/docker-compose.yml")
PROFILES=(--profile admin)
if [[ "$GATEWAY_ENABLED" == 1 ]]; then
  PROFILES+=(--profile gateway)
fi

log "Downloading ready-to-run Chatter images"
if ! "${COMPOSE[@]}" "${PROFILES[@]}" pull; then
  fail "Could not download the deployment images. If a registry requires authentication, sign in with Docker and retry."
fi

if [[ "$RESET_ADMIN" == 1 ]]; then
  "${COMPOSE[@]}" --profile admin stop chatter-manager
  rm -f -- "$PENDING_PASSWORD_FILE" "$BOOTSTRAP_PASSWORD_FILE" "$CONFIG_DIR/auth.json"
fi
if [[ ! -s "$CONFIG_DIR/auth.json" ]]; then
  if [[ ! -s "$PENDING_PASSWORD_FILE" ]]; then
    if [[ -s "$BOOTSTRAP_PASSWORD_FILE" ]]; then
      write_private_file "$PENDING_PASSWORD_FILE" "$(<"$BOOTSTRAP_PASSWORD_FILE")"
    else
      write_private_file "$PENDING_PASSWORD_FILE" "$(random_hex 16)"
    fi
  fi
  write_private_file "$BOOTSTRAP_PASSWORD_FILE" "$(<"$PENDING_PASSWORD_FILE")"
fi
if [[ "$GATEWAY_ENABLED" == 0 ]]; then
  "${COMPOSE[@]}" --profile admin --profile gateway stop gateway
fi

log "Starting Chatter"
"${COMPOSE[@]}" "${PROFILES[@]}" up -d --no-build
if [[ -n "$("${COMPOSE[@]}" --profile telegram ps --status running -q telegram-bot)" ]]; then
  "${COMPOSE[@]}" --profile telegram up -d --no-deps --no-build telegram-bot
fi

LOCAL_URL="https://127.0.0.1:${ADMIN_PORT}"
HEALTH_ARGS=(-k "${LOCAL_URL}/health")
HEALTH_SERVICE=chatter-manager
if [[ "$GATEWAY_ENABLED" == 1 ]]; then
  HEALTH_ARGS=(--resolve "${SERVER_IP}:${HTTPS_PORT}:127.0.0.1" "${PUBLIC_URL}/health")
  HEALTH_SERVICE=gateway
fi

ready=0
for _ in $(seq 1 60); do
  if curl -fsS --noproxy '*' --max-time 5 "${HEALTH_ARGS[@]}" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 2
done
if [[ "$ready" == 0 ]]; then
  if [[ "$GATEWAY_ENABLED" == 1 ]]; then
    log "Check that TCP ports 80 and ${HTTPS_PORT} are reachable and Caddy can obtain its certificate."
  fi
  fail "${HEALTH_SERVICE} did not become ready. Logs: docker compose --project-name chatter --env-file ${COMPOSE_ENV} --profile admin --profile gateway logs ${HEALTH_SERVICE}"
fi

printf '\nChatter is ready.\n\n'
printf '  URL:      %s\n' "${PUBLIC_URL:-$LOCAL_URL}"
if [[ -s "$PENDING_PASSWORD_FILE" ]]; then
  ADMIN_PASSWORD="$(<"$PENDING_PASSWORD_FILE")"
  printf '  Login:    %s\n  Password: %s\n\n' "$ADMIN_USERNAME" "$ADMIN_PASSWORD"
  rm -f -- "$PENDING_PASSWORD_FILE" "$BOOTSTRAP_PASSWORD_FILE"
else
  printf '  Admin credentials were preserved. To reset them, rerun install.sh --reset-admin.\n\n'
fi
if [[ "$GATEWAY_ENABLED" == 1 ]]; then
  printf 'Caddy manages the public IP certificate and renews it automatically.\n'
else
  printf 'Manager is listening at %s on the server. Use your reverse proxy or ssh -L %s:127.0.0.1:%s user@server.\n' "$LOCAL_URL" "$ADMIN_PORT" "$ADMIN_PORT"
fi
printf 'After login, configure the AI provider, Telegram and Voice in the panel.\n\n'
