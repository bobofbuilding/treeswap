#!/usr/bin/env bash
set -euo pipefail

project_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
monitor_port=${SAFETY_MONITOR_PORT:-18551}
monitor_rpc="http://127.0.0.1:${monitor_port}"
monitor_mnemonic="test test test test test test test test test test test junk"
monitor_log=$(mktemp)
monitor_pid=""

cleanup() {
  if [[ -n "$monitor_pid" ]]; then
    kill "$monitor_pid" >/dev/null 2>&1 || true
    wait "$monitor_pid" >/dev/null 2>&1 || true
  fi
  rm -f "$monitor_log"
}
trap cleanup EXIT

cd "$project_root"
forge build --quiet
if cast chain-id --rpc-url "$monitor_rpc" >/dev/null 2>&1; then
  echo "safety monitor smoke port is already in use" >&2
  exit 1
fi
anvil --host 127.0.0.1 --port "$monitor_port" --chain-id 31337 --mnemonic "$monitor_mnemonic" \
  --timestamp 2100000000 --slots-in-an-epoch 2 --silent >"$monitor_log" 2>&1 &
monitor_pid=$!

for _ in $(seq 1 100); do
  if ! kill -0 "$monitor_pid" >/dev/null 2>&1; then
    echo "safety monitor Anvil process exited before readiness" >&2
    exit 1
  fi
  if cast chain-id --rpc-url "$monitor_rpc" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done
kill -0 "$monitor_pid" >/dev/null 2>&1
cast chain-id --rpc-url "$monitor_rpc" >/dev/null

SAFETY_MONITOR_RPC_URL="$monitor_rpc" \
SAFETY_MONITOR_MNEMONIC="$monitor_mnemonic" \
SAFETY_MONITOR_ANVIL_VERSION="$(anvil --version | head -n 1)" \
node infra/evm/safety-monitor-smoke.mjs
