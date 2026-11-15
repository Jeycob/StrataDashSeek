#!/usr/bin/env bash
set -euo pipefail
BOOTSTRAP=/data/harness/bootstrap/start.sh
if [ ! -f "$BOOTSTRAP" ] || [ ! -x "$BOOTSTRAP" ]; then
 echo 'Signed startup bootstrap is missing or not executable; Harness remains stopped. Install or repair the trusted startup gate before starting services.' >&2
 exit 1
fi
exec bash "$BOOTSTRAP"
