#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${MAINNET_RPC_URL:-}" ]]; then
  echo "MAINNET_RPC_URL is required" >&2
  exit 1
fi

forge test --match-path 'contracts/test/fork/*.t.sol' -vvv
