#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="${ROUTER_CONFIG_FILE:-$ROOT_DIR/router.config.json}"
SERVER_FILE="$ROOT_DIR/server.mjs"
RUN_DIR="$ROOT_DIR/run"
LOG_DIR="$ROOT_DIR/logs"
PID_FILE="${ROUTER_PID_FILE:-$RUN_DIR/router.pid}"
LOG_FILE="${ROUTER_LOG_FILE:-$LOG_DIR/router.log}"
NODE_BIN="${NODE_BIN:-node}"

usage() {
  cat <<EOF
Usage: ./routerctl.sh {start|stop|restart|logs}

Commands:
  start    Run router in the background and write PID/log files
  stop     Stop the background router process
  restart  Stop then start the router
  logs     Show recent logs; use "logs -f" to follow

Optional environment variables:
  ROUTER_CONFIG_FILE  Default: $CONFIG_FILE
  ROUTER_PID_FILE     Default: $PID_FILE
  ROUTER_LOG_FILE     Default: $LOG_FILE
  NODE_BIN            Default: node
EOF
}

read_port() {
  "$NODE_BIN" -e '
const fs = require("fs");
const path = process.argv[1];
const config = JSON.parse(fs.readFileSync(path, "utf8"));
console.log(config.listen?.port || 8787);
' "$CONFIG_FILE"
}

is_pid_alive() {
  local pid="${1:-}"
  [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null
}

pid_from_file() {
  [[ -f "$PID_FILE" ]] && tr -d '[:space:]' < "$PID_FILE" || true
}

port_pids() {
  local port="$1"
  lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true
}

process_command() {
  local pid="$1"
  ps -p "$pid" -o command= 2>/dev/null || true
}

process_cwd() {
  local pid="$1"
  lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1
}

is_router_process() {
  local pid="$1"
  local command cwd
  command="$(process_command "$pid")"
  cwd="$(process_cwd "$pid")"

  [[ "$command" == *"node"* ]] &&
    [[ "$command" == *"server.mjs"* ]] &&
    { [[ "$command" == *"router.config.json"* ]] || [[ "$cwd" == "$ROOT_DIR" ]]; }
}

terminate_pid() {
  local pid="$1"
  local label="${2:-process}"

  if ! is_pid_alive "$pid"; then
    return 0
  fi

  echo "Stopping $label PID $pid ..."
  kill -TERM "$pid" 2>/dev/null || true
  # If the user suspended it with Ctrl+Z, continue it so SIGTERM can be handled immediately.
  kill -CONT "$pid" 2>/dev/null || true

  for _ in {1..30}; do
    if ! is_pid_alive "$pid"; then
      return 0
    fi
    sleep 0.2
  done

  echo "PID $pid did not exit after SIGTERM; forcing stop ..."
  kill -KILL "$pid" 2>/dev/null || true

  for _ in {1..10}; do
    if ! is_pid_alive "$pid"; then
      return 0
    fi
    sleep 0.2
  done

  echo "Failed to stop PID $pid."
  return 1
}

start_router() {
  if [[ ! -f "$CONFIG_FILE" ]]; then
    echo "Config file not found: $CONFIG_FILE"
    echo "Create it from router.config.example.json first."
    exit 1
  fi

  mkdir -p "$RUN_DIR" "$LOG_DIR"

  local old_pid port occupied
  old_pid="$(pid_from_file)"
  if is_pid_alive "$old_pid"; then
    echo "Router is already running with PID $old_pid."
    echo "Log file: $LOG_FILE"
    return 0
  fi

  port="$(read_port)"
  occupied="$(port_pids "$port")"
  if [[ -n "$occupied" ]]; then
    echo "Port $port is already in use:"
    for pid in $occupied; do
      echo "  PID $pid: $(process_command "$pid")"
    done
    echo "Run ./routerctl.sh stop if this is an old router process."
    exit 1
  fi

  : >> "$LOG_FILE"
  (
    cd "$ROOT_DIR"
    nohup "$NODE_BIN" "$SERVER_FILE" "$CONFIG_FILE" >> "$LOG_FILE" 2>&1 &
    echo "$!" > "$PID_FILE"
  )

  local pid
  pid="$(pid_from_file)"
  sleep 0.6

  if is_pid_alive "$pid"; then
    echo "Router started in background."
    echo "PID: $pid"
    echo "URL: http://127.0.0.1:$port"
    echo "Log file: $LOG_FILE"
    return 0
  fi

  echo "Router failed to start. Recent logs:"
  tail -n 80 "$LOG_FILE" || true
  rm -f "$PID_FILE"
  exit 1
}

stop_router() {
  local pid port found_any=0
  pid="$(pid_from_file)"

  if is_pid_alive "$pid"; then
    terminate_pid "$pid" "router"
    found_any=1
  elif [[ -n "$pid" ]]; then
    echo "Removing stale PID file for PID $pid."
  fi

  rm -f "$PID_FILE"

  if [[ -f "$CONFIG_FILE" ]]; then
    port="$(read_port)"
    for pid in $(port_pids "$port"); do
      if is_router_process "$pid"; then
        terminate_pid "$pid" "router process on port $port"
        found_any=1
      else
        echo "Port $port is still used by a non-router process, leaving it alone:"
        echo "  PID $pid: $(process_command "$pid")"
      fi
    done
  fi

  if [[ "$found_any" -eq 0 ]]; then
    echo "Router is not running."
  else
    echo "Router stopped."
  fi
}

show_logs() {
  mkdir -p "$LOG_DIR"
  if [[ ! -f "$LOG_FILE" ]]; then
    echo "Log file does not exist yet: $LOG_FILE"
    return 0
  fi

  if [[ "${1:-}" == "-f" || "${1:-}" == "--follow" ]]; then
    tail -n "${LOG_LINES:-120}" -f "$LOG_FILE"
  else
    tail -n "${LOG_LINES:-120}" "$LOG_FILE"
  fi
}

command="${1:-}"
if [[ "$#" -gt 0 ]]; then
  shift
fi

case "$command" in
  start)
    start_router
    ;;
  stop)
    stop_router
    ;;
  restart)
    stop_router
    start_router
    ;;
  logs)
    show_logs "$@"
    ;;
  -h|--help|help|"")
    usage
    ;;
  *)
    echo "Unknown command: $command"
    usage
    exit 1
    ;;
esac
