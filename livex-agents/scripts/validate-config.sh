#!/bin/sh
set -eu
PACKAGE_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exec python3 -B "$PACKAGE_ROOT/scripts/config.py" validate "$@"
