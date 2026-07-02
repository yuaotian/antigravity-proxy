#!/usr/bin/env bash
set -euo pipefail

CLASH_DIR_DEFAULT="$HOME/Library/Application Support/io.github.clash-verge-rev.clash-verge-rev"
CLASH_CONFIG_DEFAULT="$CLASH_DIR_DEFAULT/clash-verge.yaml"
VERGE_CONFIG_DEFAULT="$CLASH_DIR_DEFAULT/verge.yaml"
LOG_DIR_DEFAULT="$HOME/Library/Logs/antigravity-proxy-macos"

NO_PROXY_DEFAULT="localhost,127.0.0.1,::1,*.local,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"
CHROMIUM_BYPASS_DEFAULT="<local>;localhost;127.0.0.1;::1;*.local;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.20.*;172.21.*;172.22.*;172.23.*;172.24.*;172.25.*;172.26.*;172.27.*;172.28.*;172.29.*;172.30.*;172.31.*;192.168.*"

usage() {
  cat <<'EOF'
Usage:
  scripts/macos-antigravity-proxy.sh doctor [--app antigravity|ide|/path/App.app]
  scripts/macos-antigravity-proxy.sh launch [--app antigravity|ide|/path/App.app] [-- extra-antigravity-args...]
  scripts/macos-antigravity-proxy.sh restart [--app antigravity|ide|/path/App.app] [--force-kill] [-- extra-antigravity-args...]
  scripts/macos-antigravity-proxy.sh env
  scripts/macos-antigravity-proxy.sh system-proxy on|off|status
  scripts/macos-antigravity-proxy.sh clash-verge use-system-proxy

Environment overrides:
  ANTIGRAVITY_APP            Default: antigravity. Use ide for /Applications/Antigravity IDE.app
  ANTIGRAVITY_APP_PATH       Explicit app path. Overrides ANTIGRAVITY_APP.
  ANTIGRAVITY_PROXY_HOST     Default: Clash Verge proxy_host or 127.0.0.1
  ANTIGRAVITY_PROXY_PORT     Default: Clash Verge mixed-port/verge_mixed_port
  ANTIGRAVITY_PROXY_SCHEME   Default: http
  CLASH_VERGE_CONFIG         Default: ~/Library/Application Support/.../clash-verge.yaml
  CLASH_VERGE_APP_CONFIG     Default: ~/Library/Application Support/.../verge.yaml
  CLASH_VERGE_MIHOMO_SOCKET  Default: /tmp/verge/verge-mihomo.sock
EOF
}

log() {
  printf '[antigravity-proxy-macos] %s\n' "$*"
}

die() {
  printf '[antigravity-proxy-macos] ERROR: %s\n' "$*" >&2
  exit 1
}

plist_value() {
  local plist="$1"
  local key="$2"
  /usr/libexec/PlistBuddy -c "Print :$key" "$plist" 2>/dev/null || true
}

yaml_value() {
  local key="$1"
  local file="$2"
  [[ -f "$file" ]] || return 0
  awk -F: -v key="$key" '
    $1 ~ "^[[:space:]]*" key "[[:space:]]*$" {
      value=$0
      sub(/^[^:]*:/, "", value)
      sub(/[[:space:]]+#.*$/, "", value)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      gsub(/^"|"$/, "", value)
      print value
      exit
    }
  ' "$file"
}

APP_SELECTOR="${ANTIGRAVITY_APP:-${ANTIGRAVITY_TARGET:-antigravity}}"
PARSED_ARGS=()
PARSED_FORCE_KILL=0

parse_app_selector() {
  local selector="$1"
  case "$selector" in
    ""|antigravity|ag|main|stable)
      printf '%s\n' "antigravity"
      ;;
    ide|antigravity-ide|"Antigravity IDE")
      printf '%s\n' "ide"
      ;;
    auto)
      printf '%s\n' "auto"
      ;;
    /*|*.app)
      printf '%s\n' "$selector"
      ;;
    *)
      die "Unknown app selector: $selector (use antigravity, ide, auto, or /path/App.app)"
      ;;
  esac
}

parse_common_flags() {
  PARSED_ARGS=()
  while (($#)); do
    case "$1" in
      --app)
        [[ -n "${2:-}" ]] || die "--app requires a value"
        APP_SELECTOR="$(parse_app_selector "$2")"
        shift 2
        ;;
      --app=*)
        APP_SELECTOR="$(parse_app_selector "${1#--app=}")"
        shift
        ;;
      --ide)
        APP_SELECTOR="ide"
        shift
        ;;
      --antigravity)
        APP_SELECTOR="antigravity"
        shift
        ;;
      --)
        shift
        PARSED_ARGS+=("$@")
        break
        ;;
      *)
        PARSED_ARGS+=("$1")
        shift
        ;;
    esac
  done
}

parse_launch_flags() {
  PARSED_ARGS=()
  PARSED_FORCE_KILL=0
  while (($#)); do
    case "$1" in
      --force-kill)
        PARSED_FORCE_KILL=1
        shift
        ;;
      --app)
        [[ -n "${2:-}" ]] || die "--app requires a value"
        APP_SELECTOR="$(parse_app_selector "$2")"
        shift 2
        ;;
      --app=*)
        APP_SELECTOR="$(parse_app_selector "${1#--app=}")"
        shift
        ;;
      --ide)
        APP_SELECTOR="ide"
        shift
        ;;
      --antigravity)
        APP_SELECTOR="antigravity"
        shift
        ;;
      --)
        shift
        PARSED_ARGS+=("$@")
        break
        ;;
      *)
        PARSED_ARGS+=("$1")
        shift
        ;;
    esac
  done
}

detect_app() {
  if [[ -n "${ANTIGRAVITY_APP_PATH:-}" ]]; then
    [[ -d "$ANTIGRAVITY_APP_PATH" ]] || die "ANTIGRAVITY_APP_PATH does not exist: $ANTIGRAVITY_APP_PATH"
    printf '%s\n' "$ANTIGRAVITY_APP_PATH"
    return
  fi

  local candidate
  local selector
  selector="$(parse_app_selector "$APP_SELECTOR")"

  case "$selector" in
    antigravity)
      for candidate in "/Applications/Antigravity.app"; do
        if [[ -d "$candidate" ]]; then
          printf '%s\n' "$candidate"
          return
        fi
      done
      if command -v mdfind >/dev/null 2>&1; then
        candidate="$(mdfind "kMDItemCFBundleIdentifier == 'com.google.antigravity'" | head -n 1 || true)"
        if [[ -n "$candidate" && -d "$candidate" ]]; then
          printf '%s\n' "$candidate"
          return
        fi
      fi
      ;;
    ide)
      for candidate in "/Applications/Antigravity IDE.app"; do
        if [[ -d "$candidate" ]]; then
          printf '%s\n' "$candidate"
          return
        fi
      done
      if command -v mdfind >/dev/null 2>&1; then
        candidate="$(mdfind "kMDItemCFBundleIdentifier == 'com.google.antigravity-ide'" | head -n 1 || true)"
        if [[ -n "$candidate" && -d "$candidate" ]]; then
          printf '%s\n' "$candidate"
          return
        fi
      fi
      ;;
    auto)
      for candidate in "/Applications/Antigravity.app" "/Applications/Antigravity IDE.app"; do
        if [[ -d "$candidate" ]]; then
          printf '%s\n' "$candidate"
          return
        fi
      done
      ;;
    /*|*.app)
      [[ -d "$selector" ]] || die "App path does not exist: $selector"
      printf '%s\n' "$selector"
      return
      ;;
  esac

  die "Cannot find app for selector '$selector'. Use --app /path/App.app or set ANTIGRAVITY_APP_PATH."
}

app_executable_path() {
  local app="$1"
  local plist="$app/Contents/Info.plist"
  local executable
  executable="$(plist_value "$plist" "CFBundleExecutable")"
  [[ -n "$executable" ]] || die "Cannot read CFBundleExecutable from $plist"
  printf '%s/Contents/MacOS/%s\n' "$app" "$executable"
}

app_bundle_id() {
  local app="$1"
  plist_value "$app/Contents/Info.plist" "CFBundleIdentifier"
}

detect_proxy_host() {
  local verge_config="${CLASH_VERGE_APP_CONFIG:-$VERGE_CONFIG_DEFAULT}"
  local host="${ANTIGRAVITY_PROXY_HOST:-}"
  if [[ -z "$host" ]]; then
    host="$(yaml_value "proxy_host" "$verge_config")"
  fi
  printf '%s\n' "${host:-127.0.0.1}"
}

port_is_open() {
  local host="$1"
  local port="$2"
  nc -z -w 1 "$host" "$port" >/dev/null 2>&1
}

detect_proxy_port() {
  local host="$1"
  local clash_config="${CLASH_VERGE_CONFIG:-$CLASH_CONFIG_DEFAULT}"
  local verge_config="${CLASH_VERGE_APP_CONFIG:-$VERGE_CONFIG_DEFAULT}"
  local port="${ANTIGRAVITY_PROXY_PORT:-}"

  if [[ -z "$port" ]]; then
    port="$(yaml_value "mixed-port" "$clash_config")"
  fi
  if [[ -z "$port" ]]; then
    port="$(yaml_value "verge_mixed_port" "$verge_config")"
  fi
  if [[ -n "$port" ]]; then
    printf '%s\n' "$port"
    return
  fi

  local candidate
  for candidate in 7897 7890 7891 1080 10808; do
    if port_is_open "$host" "$candidate"; then
      printf '%s\n' "$candidate"
      return
    fi
  done

  die "Cannot detect Clash/Mihomo proxy port. Set ANTIGRAVITY_PROXY_PORT=7897"
}

proxy_scheme() {
  printf '%s\n' "${ANTIGRAVITY_PROXY_SCHEME:-http}"
}

proxy_url() {
  local host="$1"
  local port="$2"
  printf '%s://%s:%s\n' "$(proxy_scheme)" "$host" "$port"
}

app_slug() {
  local app="$1"
  basename "$app" .app |
    tr '[:upper:]' '[:lower:]' |
    tr -cs '[:alnum:]' '-' |
    sed 's/^-//; s/-$//'
}

export_proxy_env() {
  local host="$1"
  local port="$2"
  local http_url
  http_url="http://$host:$port"

  export HTTP_PROXY="$http_url"
  export HTTPS_PROXY="$http_url"
  export http_proxy="$http_url"
  export https_proxy="$http_url"
  export ALL_PROXY="socks5h://$host:$port"
  export all_proxy="$ALL_PROXY"
  export GRPC_PROXY="$http_url"
  export GRPC_PROXY_EXP="$http_url"
  export NO_PROXY="${ANTIGRAVITY_NO_PROXY:-$NO_PROXY_DEFAULT}"
  export no_proxy="$NO_PROXY"
}

running_pids() {
  local exec_path="$1"
  ps -axo pid=,command= | awk -v path="$exec_path" '
    {
      command=$0
      sub(/^[[:space:]]*[0-9]+[[:space:]]+/, "", command)
    }
    index(command, path) == 1 {
      print $1
    }
  '
}

wait_for_exit() {
  local exec_path="$1"
  local i
  for ((i = 0; i < 40; i++)); do
    if [[ -z "$(running_pids "$exec_path")" ]]; then
      return 0
    fi
    sleep 0.25
  done
  return 1
}

wait_for_start() {
  local exec_path="$1"
  local i
  for ((i = 0; i < 40; i++)); do
    if [[ -n "$(running_pids "$exec_path")" ]]; then
      return 0
    fi
    sleep 0.25
  done
  return 1
}

quit_app() {
  local app="$1"
  local exec_path="$2"
  local bundle_id
  bundle_id="$(app_bundle_id "$app")"
  if [[ -n "$bundle_id" ]]; then
    osascript -e "tell application id \"$bundle_id\" to quit" >/dev/null 2>&1 || true
  fi
  wait_for_exit "$exec_path"
}

force_kill_app() {
  local exec_path="$1"
  local pid
  while read -r pid; do
    [[ -n "$pid" ]] || continue
    kill "$pid" >/dev/null 2>&1 || true
  done < <(running_pids "$exec_path")
}

test_proxy() {
  local host="$1"
  local port="$2"

  port_is_open "$host" "$port" || die "Proxy port is not listening: $host:$port"
  curl -fsS --max-time 8 -x "http://$host:$port" https://www.gstatic.com/generate_204 -o /dev/null
}

launch_app() {
  local app="$1"
  local exec_path="$2"
  local host="$3"
  local port="$4"
  shift 4

  test_proxy "$host" "$port"
  export_proxy_env "$host" "$port"

  local log_dir="${ANTIGRAVITY_PROXY_LOG_DIR:-$LOG_DIR_DEFAULT}"
  mkdir -p "$log_dir"
  local slug
  slug="$(app_slug "$app")"
  local log_file="$log_dir/$slug-$(date +%Y%m%d-%H%M%S).log"

  local chrome_proxy
  chrome_proxy="$(proxy_url "$host" "$port")"
  local bypass="${ANTIGRAVITY_CHROMIUM_BYPASS:-$CHROMIUM_BYPASS_DEFAULT}"

  log "Starting $app"
  log "Proxy: $chrome_proxy"
  log "Log: $log_file"

  if (open --help 2>&1 || true) | grep -q -- '--env'; then
    local stderr_file="${log_file%.log}.stderr.log"
    open \
      --stdout "$log_file" \
      --stderr "$stderr_file" \
      --env "HTTP_PROXY=$HTTP_PROXY" \
      --env "HTTPS_PROXY=$HTTPS_PROXY" \
      --env "http_proxy=$http_proxy" \
      --env "https_proxy=$https_proxy" \
      --env "ALL_PROXY=$ALL_PROXY" \
      --env "all_proxy=$all_proxy" \
      --env "GRPC_PROXY=$GRPC_PROXY" \
      --env "GRPC_PROXY_EXP=$GRPC_PROXY_EXP" \
      --env "NO_PROXY=$NO_PROXY" \
      --env "no_proxy=$no_proxy" \
      "$app" \
      --args \
      "--proxy-server=$chrome_proxy" \
      "--proxy-bypass-list=$bypass" \
      "$@"

    if ! wait_for_start "$exec_path"; then
      die "$app did not stay running. Check logs: $log_file $stderr_file"
    fi
    log "Started pid(s): $(running_pids "$exec_path" | tr '\n' ' ')"
    return
  fi

  nohup "$exec_path" \
    "--proxy-server=$chrome_proxy" \
    "--proxy-bypass-list=$bypass" \
    "$@" >>"$log_file" 2>&1 &

  local pid=$!
  sleep 1
  if ! kill -0 "$pid" >/dev/null 2>&1; then
    die "$app process exited immediately. Check log: $log_file"
  fi
  log "Started pid=$pid"
}

print_env() {
  local host
  local port
  host="$(detect_proxy_host)"
  port="$(detect_proxy_port "$host")"
  export_proxy_env "$host" "$port"

  printf 'export HTTP_PROXY=%q\n' "$HTTP_PROXY"
  printf 'export HTTPS_PROXY=%q\n' "$HTTPS_PROXY"
  printf 'export ALL_PROXY=%q\n' "$ALL_PROXY"
  printf 'export NO_PROXY=%q\n' "$NO_PROXY"
  printf 'export GRPC_PROXY=%q\n' "$GRPC_PROXY"
  printf 'export GRPC_PROXY_EXP=%q\n' "$GRPC_PROXY_EXP"
}

doctor() {
  local app
  local exec_path
  local host
  local port
  app="$(detect_app)"
  exec_path="$(app_executable_path "$app")"
  host="$(detect_proxy_host)"
  port="$(detect_proxy_port "$host")"

  log "App selector: $(parse_app_selector "$APP_SELECTOR")"
  log "App path: $app"
  log "Executable: $exec_path"
  log "Bundle id: $(app_bundle_id "$app")"
  log "Clash config: ${CLASH_VERGE_CONFIG:-$CLASH_CONFIG_DEFAULT}"
  log "Clash app config: ${CLASH_VERGE_APP_CONFIG:-$VERGE_CONFIG_DEFAULT}"
  log "Detected proxy: $host:$port"

  if port_is_open "$host" "$port"; then
    log "Proxy port: open"
  else
    log "Proxy port: closed"
  fi

  if curl -fsS --max-time 8 -x "http://$host:$port" https://www.gstatic.com/generate_204 -o /dev/null; then
    log "Proxy HTTP CONNECT test: ok"
  else
    log "Proxy HTTP CONNECT test: failed"
  fi

  local pids
  local pids_csv
  pids="$(running_pids "$exec_path")"
  if [[ -n "$pids" ]]; then
    pids_csv="$(printf '%s\n' "$pids" | paste -sd, -)"
    log "Running app pid(s): $(printf '%s\n' "$pids" | tr '\n' ' ')"
    ps -p "$pids_csv" -o pid=,command= | sed 's/^/[antigravity-proxy-macos] /'
  else
    log "Running app pid(s): none"
  fi

  log "System proxy summary:"
  scutil --proxy | sed 's/^/[antigravity-proxy-macos] /'
}

network_services() {
  networksetup -listallnetworkservices |
    tail -n +2 |
    sed 's/^\*//' |
    awk 'length($0) > 0 { print }'
}

networksetup_or_warn() {
  if ! networksetup "$@" >/dev/null 2>&1; then
    log "Warning: networksetup $* failed"
    return 1
  fi
  return 0
}

system_proxy_on() {
  local host="$1"
  local port="$2"
  local bypass="${ANTIGRAVITY_SYSTEM_BYPASS:-localhost 127.0.0.1 ::1 *.local 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16}"
  local service
  while IFS= read -r service; do
    log "Enable system proxy for: $service"
    networksetup_or_warn -setwebproxy "$service" "$host" "$port" || true
    networksetup_or_warn -setsecurewebproxy "$service" "$host" "$port" || true
    networksetup_or_warn -setsocksfirewallproxy "$service" "$host" "$port" || true
    networksetup_or_warn -setwebproxystate "$service" on || true
    networksetup_or_warn -setsecurewebproxystate "$service" on || true
    networksetup_or_warn -setsocksfirewallproxystate "$service" on || true
    # shellcheck disable=SC2086
    networksetup_or_warn -setproxybypassdomains "$service" $bypass || true
  done < <(network_services)
}

system_proxy_off() {
  local service
  while IFS= read -r service; do
    log "Disable system proxy for: $service"
    networksetup_or_warn -setwebproxystate "$service" off || true
    networksetup_or_warn -setsecurewebproxystate "$service" off || true
    networksetup_or_warn -setsocksfirewallproxystate "$service" off || true
  done < <(network_services)
}

set_top_yaml_value() {
  local file="$1"
  local key="$2"
  local value="$3"

  [[ -f "$file" ]] || die "Config file does not exist: $file"
  if grep -Eq "^[[:space:]]*$key[[:space:]]*:" "$file"; then
    perl -0pi -e "s/^([ \\t]*\\Q$key\\E[ \\t]*:).*$/\$1 $value/m" "$file"
  else
    printf '\n%s: %s\n' "$key" "$value" >>"$file"
  fi
}

configure_clash_verge_system_proxy() {
  local verge_config="${CLASH_VERGE_APP_CONFIG:-$VERGE_CONFIG_DEFAULT}"
  [[ -f "$verge_config" ]] || die "Cannot find Clash Verge app config: $verge_config"

  local backup="$verge_config.bak.$(date +%Y%m%d-%H%M%S)"
  cp "$verge_config" "$backup"
  set_top_yaml_value "$verge_config" "enable_tun_mode" "false"
  set_top_yaml_value "$verge_config" "enable_system_proxy" "true"
  set_top_yaml_value "$verge_config" "enable_proxy_guard" "true"
  disable_generated_clash_tun
  log "Updated Clash Verge app config: $verge_config"
  log "Backup: $backup"
  disable_mihomo_tun_runtime
  log "If Clash Verge UI still shows the old state, restart Clash Verge or toggle System Proxy once."
}

disable_generated_clash_tun() {
  local clash_config="${CLASH_VERGE_CONFIG:-$CLASH_CONFIG_DEFAULT}"
  [[ -f "$clash_config" ]] || return 0

  local backup="$clash_config.bak.$(date +%Y%m%d-%H%M%S)"
  cp "$clash_config" "$backup"
  if perl -0pi -e 'exit 2 unless s/(^tun:\n(?:[ \t]+[^\n]*\n)*?[ \t]+enable:)[ \t]*(?:true|false)/$1 false/m' "$clash_config"; then
    log "Updated generated Clash config tun.enable=false: $clash_config"
    log "Generated config backup: $backup"
  else
    log "Warning: failed to update generated Clash config tun.enable: $clash_config"
  fi
}

mihomo_secret() {
  local clash_config="${CLASH_VERGE_CONFIG:-$CLASH_CONFIG_DEFAULT}"
  local secret
  secret="$(yaml_value "secret" "$clash_config")"
  printf '%s\n' "${secret:-set-your-secret}"
}

mihomo_socket() {
  printf '%s\n' "${CLASH_VERGE_MIHOMO_SOCKET:-/tmp/verge/verge-mihomo.sock}"
}

disable_mihomo_tun_runtime() {
  local socket
  local secret
  socket="$(mihomo_socket)"
  secret="$(mihomo_secret)"

  if [[ ! -S "$socket" ]]; then
    log "Mihomo socket not found; runtime TUN will change after Clash Verge reloads config: $socket"
    return 0
  fi

  if curl --unix-socket "$socket" -fsS --max-time 5 \
      -X PATCH \
      -H "Authorization: Bearer $secret" \
      -H "Content-Type: application/json" \
      --data '{"tun":{"enable":false}}' \
      http://unix/configs >/dev/null; then
    log "Disabled Mihomo runtime TUN via $socket"
  else
    log "Warning: failed to disable Mihomo runtime TUN via $socket"
  fi
}

main() {
  local command="${1:-}"
  [[ -n "$command" ]] || { usage; exit 1; }
  shift || true

  case "$command" in
    -h|--help|help)
      usage
      ;;
    doctor)
      parse_common_flags "$@"
      doctor
      ;;
    env)
      print_env
      ;;
    launch|restart)
      parse_launch_flags "$@"

      local app
      local exec_path
      local host
      local port
      app="$(detect_app)"
      exec_path="$(app_executable_path "$app")"
      host="$(detect_proxy_host)"
      port="$(detect_proxy_port "$host")"

      if [[ "$command" == "restart" ]]; then
        if [[ -n "$(running_pids "$exec_path")" ]]; then
          log "Quitting existing Antigravity instance..."
          if ! quit_app "$app" "$exec_path"; then
            if [[ "$PARSED_FORCE_KILL" == "1" ]]; then
              log "Graceful quit timed out; force killing existing process."
              force_kill_app "$exec_path"
              wait_for_exit "$exec_path" || true
            else
              die "$app is still running. Re-run with: restart --app $(parse_app_selector "$APP_SELECTOR") --force-kill"
            fi
          fi
        fi
      elif [[ -n "$(running_pids "$exec_path")" ]]; then
        die "$app is already running. Use 'restart --app $(parse_app_selector "$APP_SELECTOR")' so proxy env reaches child processes."
      fi

      if ((${#PARSED_ARGS[@]} > 0)); then
        launch_app "$app" "$exec_path" "$host" "$port" "${PARSED_ARGS[@]}"
      else
        launch_app "$app" "$exec_path" "$host" "$port"
      fi
      ;;
    system-proxy)
      local action="${1:-}"
      local host
      local port
      case "$action" in
        on)
          host="$(detect_proxy_host)"
          port="$(detect_proxy_port "$host")"
          test_proxy "$host" "$port"
          system_proxy_on "$host" "$port"
          scutil --proxy
          ;;
        off)
          system_proxy_off
          scutil --proxy
          ;;
        status)
          scutil --proxy
          ;;
        *)
          die "Usage: $0 system-proxy on|off|status"
          ;;
      esac
      ;;
    clash-verge)
      local action="${1:-}"
      case "$action" in
        use-system-proxy)
          configure_clash_verge_system_proxy
          ;;
        *)
          die "Usage: $0 clash-verge use-system-proxy"
          ;;
      esac
      ;;
    *)
      usage
      exit 1
      ;;
  esac
}

main "$@"
