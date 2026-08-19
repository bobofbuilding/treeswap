#!/usr/bin/env bash
set -euo pipefail

project_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
smoke_port=${ESCROW_REORG_SMOKE_PORT:-18547}
smoke_rpc="http://127.0.0.1:${smoke_port}"
smoke_mnemonic="test test test test test test test test test test test junk"
smoke_log=$(mktemp)
anvil_pid=""

cleanup() {
  if [[ -n "$anvil_pid" ]]; then
    kill "$anvil_pid" >/dev/null 2>&1 || true
    wait "$anvil_pid" >/dev/null 2>&1 || true
  fi
  rm -f "$smoke_log"
}
trap cleanup EXIT

cd "$project_root"
forge build --quiet
anvil --host 127.0.0.1 --port "$smoke_port" --chain-id 31337 --mnemonic "$smoke_mnemonic" --silent >"$smoke_log" 2>&1 &
anvil_pid=$!

for _ in $(seq 1 50); do
  if cast chain-id --rpc-url "$smoke_rpc" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done
cast chain-id --rpc-url "$smoke_rpc" >/dev/null

ESCROW_REORG_RPC_URL="$smoke_rpc" \
ESCROW_REORG_MNEMONIC="$smoke_mnemonic" \
ESCROW_REORG_ANVIL_VERSION="$(anvil --version | head -n 1)" \
node infra/evm/escrow-reorg-smoke.mjs
