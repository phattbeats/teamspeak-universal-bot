#!/bin/sh
# PHA-4919: tell the lifecycle log WHY the next stop/restart happens.
#   lifecycle-mark test      # then docker restart / supervisorctl restart
# image/deploy.sh does the same from the host with `deploy`. Valid for 3 minutes.
set -eu
case "${1:-}" in deploy|test) ;; *) echo "usage: lifecycle-mark deploy|test" >&2; exit 2;; esac
echo "$1 $(date +%s)" > "${LIFECYCLE_MARK:-/var/sexton-logs/.lifecycle-mark}"
