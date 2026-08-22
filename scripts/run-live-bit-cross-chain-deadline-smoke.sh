#!/usr/bin/env bash
set -euo pipefail

project_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
smoke_port=${LIVE_BIT_CROSS_CHAIN_DEADLINE_PORT:-18556}
smoke_rpc="http://127.0.0.1:${smoke_port}"
smoke_mnemonic="test test test test test test test test test test test junk"
smoke_log=$(mktemp)
smoke_state_dir=$(mktemp -d)
smoke_state_path="$smoke_state_dir/state.json"
anvil_pid=""
evidence_path=""

if (( $# != 0 )); then
  if (( $# != 2 )) || [[ "$1" != "--out-name" ]] ||
    [[ ! "$2" =~ ^[a-z0-9][a-z0-9._-]{0,100}\.json$ ]]; then
    echo "Usage: bash scripts/run-live-bit-cross-chain-deadline-smoke.sh [--out-name evidence.json]" >&2
    exit 1
  fi
  evidence_path="$project_root/outputs/$2"
fi

cleanup() {
  if [[ -n "$anvil_pid" ]]; then
    kill "$anvil_pid" >/dev/null 2>&1 || true
    wait "$anvil_pid" >/dev/null 2>&1 || true
  fi
  rm -f "$smoke_state_path" "$smoke_log"
  rmdir "$smoke_state_dir" >/dev/null 2>&1 || true
}
trap cleanup EXIT

chmod 0700 "$smoke_state_dir"
cd "$project_root"
source_commit=$(node scripts/verify-published-main.mjs) || {
  echo "live-BIT deadline evidence requires exact current canonical published main" >&2
  exit 1
}
if [[ -z "${MAINNET_RPC_URL:-}" ]]; then
  echo "MAINNET_RPC_URL is required" >&2
  exit 1
fi
if [[ -n "$evidence_path" ]]; then
  if [[ ! -d "$project_root/outputs" || -L "$project_root/outputs" ]]; then
    echo "live-BIT evidence outputs parent must be a real directory" >&2
    exit 1
  fi
  chmod 0700 "$project_root/outputs"
  if [[ -e "$evidence_path" || -L "$evidence_path" ]]; then
    echo "live-BIT evidence output already exists" >&2
    exit 1
  fi
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
    echo "pinned live-BIT deadline fork failed to start" >&2
    exit 1
  fi
  sleep 0.1
done
cast chain-id --rpc-url "$smoke_rpc" >/dev/null

CROSS_CHAIN_DEADLINE_RPC_URL="$smoke_rpc" \
CROSS_CHAIN_DEADLINE_MNEMONIC="$smoke_mnemonic" \
CROSS_CHAIN_DEADLINE_STATE_PATH="$smoke_state_path" \
CROSS_CHAIN_DEADLINE_ANVIL_VERSION="$(anvil --version | head -n 1)" \
CROSS_CHAIN_DEADLINE_TOKEN_MODE="live-bit" \
CROSS_CHAIN_DEADLINE_EVIDENCE_PATH="$evidence_path" \
bash infra/regtest/lab.sh cross-chain-deadline-smoke

final_source_commit=$(node scripts/verify-published-main.mjs) || {
  if [[ -n "$evidence_path" && -f "$evidence_path" && ! -L "$evidence_path" ]]; then
    rm -f -- "$evidence_path"
  fi
  echo "live-BIT deadline evidence source changed during the campaign" >&2
  exit 1
}
if [[ "$final_source_commit" != "$source_commit" ]]; then
  if [[ -n "$evidence_path" && -f "$evidence_path" && ! -L "$evidence_path" ]]; then
    rm -f -- "$evidence_path"
  fi
  echo "live-BIT deadline evidence source changed during the campaign" >&2
  exit 1
fi

if [[ -n "$evidence_path" ]]; then
  echo "Durable live-BIT cross-chain deadline evidence: outputs/$(basename "$evidence_path")"
fi
