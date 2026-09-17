#!/bin/bash

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd -P)"
DEV_PORT="${DEERHUX_DEV_PORT:-30141}"

pid_cwd() {
  /usr/sbin/lsof -a -p "$1" -d cwd -Fn 2>/dev/null | awk '/^n/ { print substr($0, 2); exit }'
}

is_project_cwd() {
  case "$1" in
    "$PROJECT_DIR"|"$PROJECT_DIR"/*) return 0 ;;
    *) return 1 ;;
  esac
}

target_pids() {
  local pid cwd

  # The Next listener is the reliable anchor shared by `npm run dev` and
  # Tauri's beforeDevCommand. Reject the operation if the port belongs to a
  # different project.
  for pid in $(/usr/sbin/lsof -tiTCP:"$DEV_PORT" -sTCP:LISTEN 2>/dev/null || true); do
    cwd="$(pid_cwd "$pid")"
    if ! is_project_cwd "$cwd"; then
      echo "Refusing to stop port $DEV_PORT listener PID $pid outside this project (${cwd:-unknown cwd})." >&2
      return 2
    fi
    printf '%s\n' "$pid"
  done

  # Also find the launcher so a partially started Tauri environment can be
  # stopped before Next begins listening.
  for pid in $(pgrep -f '(^|[ /])(npm run tauri:dev|tauri dev)([[:space:]]|$)' 2>/dev/null || true); do
    cwd="$(pid_cwd "$pid")"
    is_project_cwd "$cwd" && printf '%s\n' "$pid"
  done
}

process_groups_for() {
  local pid pgid groups=""
  for pid in $1; do
    pgid="$(ps -p "$pid" -o pgid= 2>/dev/null | tr -d ' ')"
    [ -n "$pgid" ] || continue
    case " $groups " in
      *" $pgid "*) ;;
      *) groups="$groups $pgid" ;;
    esac
  done
  printf '%s\n' "${groups# }"
}

validate_process_group() {
  local pgid="$1" pid cwd members=""
  for pid in $(ps -axo pid=,pgid= | awk -v pgid="$pgid" '$2 == pgid { print $1 }'); do
    members="$members $pid"
    cwd="$(pid_cwd "$pid")"
    if ! is_project_cwd "$cwd"; then
      echo "Refusing to stop process group $pgid: PID $pid is outside this project (${cwd:-unknown cwd})." >&2
      return 1
    fi
  done
  [ -n "$members" ] || {
    echo "Unable to inspect DeerHux process group $pgid." >&2
    return 1
  }
}

groups_are_running() {
  local pgid
  for pgid in $1; do
    if ps -axo stat=,pgid= | awk -v pgid="$pgid" '$2 == pgid && $1 !~ /^Z/ { found=1 } END { exit !found }'; then
      return 0
    fi
  done
  return 1
}

PIDS="$(target_pids)" || exit $?
PROCESS_GROUPS="$(process_groups_for "$PIDS")"

if [ -z "$PROCESS_GROUPS" ]; then
  echo "DeerHux development environment is not running."
  [ "${1:-}" != "check" ]
  exit $?
fi

for pgid in $PROCESS_GROUPS; do
  validate_process_group "$pgid"
done

if [ "${1:-}" = "check" ]; then
  echo "DeerHux development PID(s): $PIDS"
  echo "DeerHux process group(s): $PROCESS_GROUPS"
  exit 0
fi

echo "Stopping DeerHux development environment on port $DEV_PORT."
for pgid in $PROCESS_GROUPS; do
  /bin/kill -TERM "-$pgid"
done

for _ in 1 2 3 4 5 6 7 8 9 10; do
  if ! groups_are_running "$PROCESS_GROUPS"; then
    echo "DeerHux development environment stopped."
    exit 0
  fi
  sleep 1
done

echo "DeerHux development environment did not stop within 10 seconds; forcing the validated process group(s) to exit." >&2
for pgid in $PROCESS_GROUPS; do
  /bin/kill -KILL "-$pgid" 2>/dev/null || true
done

for _ in 1 2 3 4 5; do
  if ! groups_are_running "$PROCESS_GROUPS"; then
    echo "DeerHux development environment stopped."
    exit 0
  fi
  sleep 1
done

echo "DeerHux development environment is still running." >&2
exit 1
