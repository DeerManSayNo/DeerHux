#!/bin/bash

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

launcher_pids() {
  local pid cwd
  for pid in $(pgrep -f '^npm run tauri:dev([[:space:]]|$)' 2>/dev/null || true); do
    cwd="$(/usr/sbin/lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | awk '/^n/ { print substr($0, 2); exit }')"
    [ "$cwd" = "$PROJECT_DIR" ] && printf '%s\n' "$pid"
  done
}

PIDS="$(launcher_pids)"
if [ -z "$PIDS" ]; then
  echo "DeerHux Tauri development environment is not running."
  exit 1
fi

PROCESS_GROUPS=""
for pid in $PIDS; do
  pgid="$(ps -p "$pid" -o pgid= | tr -d ' ')"
  [ "$pgid" = "$pid" ] || {
    echo "Refusing to stop PID $pid because it is not its process group leader." >&2
    exit 1
  }
  case " $PROCESS_GROUPS " in
    *" $pgid "*) ;;
    *) PROCESS_GROUPS="$PROCESS_GROUPS $pgid" ;;
  esac
done

[ -n "$PROCESS_GROUPS" ] || { echo "Unable to identify the DeerHux process group." >&2; exit 1; }

if [ "${1:-}" = "check" ]; then
  echo "DeerHux launcher PID(s):$PIDS"
  echo "DeerHux process group(s):$PROCESS_GROUPS"
  exit 0
fi

echo "Stopping DeerHux Tauri development environment."
for pgid in $PROCESS_GROUPS; do
  /bin/kill -TERM "-$pgid"
done

for _ in 1 2 3 4 5 6 7 8 9 10; do
  [ -z "$(launcher_pids)" ] && { echo "DeerHux development environment stopped."; exit 0; }
  sleep 1
done

echo "DeerHux development environment did not stop within 10 seconds." >&2
exit 1
