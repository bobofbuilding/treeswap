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
if [[ -n "$(git status --porcelain --untracked-files=all)" ]]; then
  echo "live-BIT deadline evidence requires a clean source tree" >&2
  exit 1
fi
source_branch=$(git branch --show-current)
source_commit=$(git rev-parse HEAD)
published_commit=$(git rev-parse origin/main)
if [[ "$source_branch" != "main" || "$source_commit" != "$published_commit" ]]; then
  echo "live-BIT deadline evidence requires exact published main" >&2
  exit 1
fi
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
bash infra/regtest/lab.sh cross-chain-deadline-smoke
