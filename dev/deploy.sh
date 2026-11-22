#!/bin/bash
# Installs dist/<id>.tgz on the BUSY Bar with curl only and launches it.
cd "$(dirname "$0")/.."
B="http://${BAR:-10.0.4.20}"
ID=io.github.rnadyrshin.pingmonitor
curl -s -X POST "$B/api/apps/quit" >/dev/null
S=$(curl -s -X POST -H 'Content-Type: application/octet-stream' --data-binary "@dist/$ID.tgz" "$B/api/apps/stage")
K=$(echo "$S" | grep -oE '"install_key":[0-9]+' | grep -oE '[0-9]+')
[ -n "$K" ] || { echo "stage failed: $S"; exit 1; }
curl -s -X POST "$B/api/apps/install?install_key=$K"; echo
curl -s -X POST "$B/api/apps/launch?app_id=$ID"; echo
