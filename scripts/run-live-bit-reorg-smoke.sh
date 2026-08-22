#!/usr/bin/env bash
set -euo pipefail

project_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
smoke_port=${LIVE_BIT_REORG_SMOKE_PORT:-18551}
smoke_rpc="http://127.0.0.1:${smoke_port}"
smoke_mnemonic="test test test test test test test test test test test junk"
smoke_log=$(mktemp)
smoke_result=$(mktemp)
anvil_pid=""

cleanup() {
  if [[ -n "$anvil_pid" ]]; then
    kill "$anvil_pid" >/dev/null 2>&1 || true
    wait "$anvil_pid" >/dev/null 2>&1 || true
  fi
  rm -f "$smoke_log" "$smoke_result"
}
trap cleanup EXIT

cd "$project_root"
source_commit=$(node scripts/verify-published-main.mjs) || {
  echo "live-BIT reorg evidence requires exact current canonical published main" >&2
  exit 1
}
if [[ -z "${MAINNET_RPC_URL:-}" ]]; then
  echo "MAINNET_RPC_URL is required" >&2
  exit 1
fi
forge build --quiet
anvil \
  --host 127.0.0.1 \
  --port "$smoke_port" \
  --chain-id 31337 \
  --mnemonic "$smoke_mnemonic" \
  --fork-url "$MAINNET_RPC_URL" \
  --fork-block-number 25788856 \
  --silent >"$smoke_log" 2>&1 &
anvil_pid=$!

for _ in $(seq 1 100); do
  if cast chain-id --rpc-url "$smoke_rpc" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$anvil_pid" >/dev/null 2>&1; then
    echo "pinned live-BIT fork failed to start" >&2
    exit 1
  fi
  sleep 0.1
done
cast chain-id --rpc-url "$smoke_rpc" >/dev/null

ESCROW_REORG_RPC_URL="$smoke_rpc" \
ESCROW_REORG_MNEMONIC="$smoke_mnemonic" \
ESCROW_REORG_ANVIL_VERSION="$(anvil --version | head -n 1)" \
ESCROW_REORG_TOKEN_MODE="live-bit" \
node infra/evm/escrow-reorg-smoke.mjs >"$smoke_result"

final_source_commit=$(node scripts/verify-published-main.mjs) || {
  echo "live-BIT reorg evidence source changed during the campaign" >&2
  exit 1
}
if [[ "$final_source_commit" != "$source_commit" ]]; then
  echo "live-BIT reorg evidence source changed during the campaign" >&2
  exit 1
fi
cat "$smoke_result"
