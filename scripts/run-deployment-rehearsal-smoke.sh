#!/usr/bin/env bash
set -euo pipefail

project_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
rehearsal_port=${DEPLOYMENT_REHEARSAL_PORT:-18552}
proxy_port=${DEPLOYMENT_REHEARSAL_PROXY_PORT:-18553}
rehearsal_rpc="http://127.0.0.1:${rehearsal_port}"
rehearsal_mnemonic="test test test test test test test test test test test junk"
rehearsal_log=$(mktemp)
rehearsal_pid=""

cleanup() {
  if [[ -n "$rehearsal_pid" ]]; then
    kill "$rehearsal_pid" >/dev/null 2>&1 || true
    wait "$rehearsal_pid" >/dev/null 2>&1 || true
  fi
  rm -f "$rehearsal_log"
}
trap cleanup EXIT

cd "$project_root"
forge build --quiet
anvil --host 127.0.0.1 --port "$rehearsal_port" --chain-id 11155111 --mnemonic "$rehearsal_mnemonic" \
  --block-time 1 --slots-in-an-epoch 2 --silent >"$rehearsal_log" 2>&1 &
rehearsal_pid=$!

for _ in $(seq 1 100); do
  if cast chain-id --rpc-url "$rehearsal_rpc" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done
cast chain-id --rpc-url "$rehearsal_rpc" >/dev/null

DEPLOYMENT_REHEARSAL_RPC_URL="$rehearsal_rpc" \
DEPLOYMENT_REHEARSAL_PROXY_PORT="$proxy_port" \
DEPLOYMENT_REHEARSAL_MNEMONIC="$rehearsal_mnemonic" \
DEPLOYMENT_REHEARSAL_SOURCE_COMMIT="$(git rev-parse HEAD)" \
DEPLOYMENT_REHEARSAL_ANVIL_VERSION="$(anvil --version | head -n 1)" \
node infra/evm/deployment-rehearsal-smoke.mjs
