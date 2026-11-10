#!/bin/sh
set -eu

# PID 1 is reused on container restart. Hold a kernel lock across exec so a
# stale PID file can be recovered without allowing two containers to own data.
bridge_data_dir="${TEAMSPACE_DATA_DIR:-/data}"
mkdir -p "$bridge_data_dir"
exec 9>"$bridge_data_dir/.bridge.container.lock"
if ! flock -n 9; then
  echo 'Another Team Space container is already using this data folder.' >&2
  exit 1
fi
bridge_authority_dir="${TEAMSPACE_AUTHORITY_DIR:-${bridge_data_dir}.authority}"
mkdir -p "$bridge_authority_dir"
exec 8>"$bridge_authority_dir/.bridge.container.lock"
if ! flock -n 8; then
  echo 'Another Team Space container is already using this authorization folder.' >&2
  exit 1
fi
export TEAMSPACE_CONTAINER_AUTHORITY_LOCK_FD=8
export TEAMSPACE_CONTAINER_LOCK_FD=9
exec "$@"
