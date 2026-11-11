#!/bin/sh
set -eu
node /opt/oncall/preflight.mjs --config /home/node/.openclaw/openclaw.json --check
exec node /app/openclaw.mjs gateway --bind lan --port 18791
