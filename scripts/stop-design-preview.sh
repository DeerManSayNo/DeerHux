#!/bin/bash
set -euo pipefail
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
for pid in $(/usr/sbin/lsof -tiTCP:30143 -sTCP:LISTEN); do
  cwd="$(/usr/sbin/lsof -a -p "$pid" -d cwd -Fn | sed -n 's/^n//p')"
  if [ "$cwd" != "$PROJECT_DIR" ]; then
    echo "Refusing to stop a listener outside this project." >&2
    exit 1
  fi
  /bin/kill -TERM "$pid"
done
