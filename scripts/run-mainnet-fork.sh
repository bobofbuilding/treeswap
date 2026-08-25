#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${MAINNET_RPC_URL:-}" ]]; then
  echo "MAINNET_RPC_URL is required" >&2
  exit 1
fi

fork_block=25788856
fork_block_hash=0xf327faf6fee57fdf66e5973d19364e662da009ba266ab32899e242a2b22aef89

if ! observed_chain_id=$(cast chain-id --rpc-url "$MAINNET_RPC_URL" 2>/dev/null); then
  echo "mainnet fork RPC chain preflight failed" >&2
  exit 1
fi
if [[ "$observed_chain_id" != "1" ]]; then
  echo "mainnet fork RPC returned the wrong chain" >&2
  exit 1
fi
if ! observed_block_hash=$(cast block "$fork_block" --field hash --rpc-url "$MAINNET_RPC_URL" 2>/dev/null); then
  echo "mainnet fork RPC pinned-block preflight failed" >&2
  exit 1
fi
observed_block_hash=$(printf '%s' "$observed_block_hash" | tr '[:upper:]' '[:lower:]')
if [[ "$observed_block_hash" != "$fork_block_hash" ]]; then
  echo "mainnet fork RPC returned the wrong pinned block" >&2
  exit 1
fi

forge test --match-path 'contracts/test/fork/*.t.sol' -vvv
