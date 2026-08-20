#!/usr/bin/env bash
set -euo pipefail

project_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
primary_port=${EVM_OUTBOX_PRIMARY_PORT:-18548}
secondary_port=${EVM_OUTBOX_SECONDARY_PORT:-18549}
proxy_port=${EVM_OUTBOX_PROXY_PORT:-18550}
primary_rpc="http://127.0.0.1:${primary_port}"
secondary_rpc="http://127.0.0.1:${secondary_port}"
smoke_mnemonic="test test test test test test test test test test test junk"
primary_log=$(mktemp)
secondary_log=$(mktemp)
primary_pid=""
secondary_pid=""

cleanup() {
  if [[ -n "$primary_pid" ]]; then
    kill "$primary_pid" >/dev/null 2>&1 || true
    wait "$primary_pid" >/dev/null 2>&1 || true
  fi
  if [[ -n "$secondary_pid" ]]; then
    kill "$secondary_pid" >/dev/null 2>&1 || true
    wait "$secondary_pid" >/dev/null 2>&1 || true
  fi
  rm -f "$primary_log" "$secondary_log"
}
trap cleanup EXIT

cd "$project_root"
forge build --quiet
anvil --host 127.0.0.1 --port "$primary_port" --chain-id 31337 --mnemonic "$smoke_mnemonic" \
  --block-time 1 --slots-in-an-epoch 2 --silent >"$primary_log" 2>&1 &
primary_pid=$!
anvil --host 127.0.0.1 --port "$secondary_port" --chain-id 31337 --mnemonic "$smoke_mnemonic" \
  --block-time 1 --slots-in-an-epoch 2 --silent >"$secondary_log" 2>&1 &
secondary_pid=$!

for _ in $(seq 1 100); do
  if cast chain-id --rpc-url "$primary_rpc" >/dev/null 2>&1 \
    && cast chain-id --rpc-url "$secondary_rpc" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done
cast chain-id --rpc-url "$primary_rpc" >/dev/null
cast chain-id --rpc-url "$secondary_rpc" >/dev/null

EVM_OUTBOX_PRIMARY_RPC_URL="$primary_rpc" \
EVM_OUTBOX_SECONDARY_RPC_URL="$secondary_rpc" \
EVM_OUTBOX_PROXY_PORT="$proxy_port" \
EVM_OUTBOX_MNEMONIC="$smoke_mnemonic" \
EVM_OUTBOX_ANVIL_VERSION="$(anvil --version | head -n 1)" \
node infra/evm/outbox-fault-smoke.mjs
