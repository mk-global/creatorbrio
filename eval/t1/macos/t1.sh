#!/bin/bash
# Runs one of the harness's TypeScript entry points as root in the macOS VM
# (#225), with the run's root-only configuration and records folder.
#   t1.sh services/observer.ts mark setup harness
set -euo pipefail
T1=/usr/local/t1
script=$1
shift
exec env T1_CONFIG_FILE=/var/t1/config.json T1_RECORDS=/var/t1/records \
  "$T1/node/bin/node" --no-warnings --import "$T1/harness/register.mjs" "$T1/harness/$script" "$@"
