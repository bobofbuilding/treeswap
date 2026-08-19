#!/usr/bin/env bash
set -euo pipefail

LAB_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
STATE_DIR="$LAB_DIR/.state"
ENV_FILE="$STATE_DIR/runtime.env"
COMPOSE_FILE="$LAB_DIR/compose.yml"

ensure_runtime_env() {
  mkdir -p "$STATE_DIR"
  chmod 700 "$STATE_DIR"
  if [[ ! -f "$ENV_FILE" ]]; then
    umask 077
    {
      echo "BITCOIND_RPC_USER=treeswap_regtest"
      echo "BITCOIND_RPC_PASSWORD=$(openssl rand -hex 24)"
      echo "LND_WALLET_PASSWORD=$(openssl rand -hex 24)"
    } >"$ENV_FILE"
  fi
  set -a
  source "$ENV_FILE"
  set +a
}

compose() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

wait_for_wallet_state() {
  local node=$1
  local expected=$2
  local state=""
  for _ in $(seq 1 90); do
    state=$(compose exec -T "$node" lncli --network=regtest state 2>/dev/null | jq -r '.state // empty' || true)
    if [[ "$state" == "$expected" ]]; then
      return 0
    fi
    sleep 1
  done
  echo "$node did not reach wallet state $expected" >&2
  return 1
}

wait_for_wallet_rpc() {
  local node=$1
  local state=""
  for _ in $(seq 1 90); do
    state=$(compose exec -T "$node" lncli --network=regtest state 2>/dev/null | jq -r '.state // empty' || true)
    if [[ -n "$state" ]]; then
      return 0
    fi
    sleep 1
  done
  echo "$node wallet RPC did not become reachable" >&2
  return 1
}

initialize_wallet() {
  local node=$1
  local state
  state=$(compose exec -T "$node" lncli --network=regtest state 2>/dev/null | jq -r '.state // empty' || true)
  if [[ "$state" == "NON_EXISTING" ]]; then
    printf '%s\n%s\nn\n\n' "$LND_WALLET_PASSWORD" "$LND_WALLET_PASSWORD" |
      compose exec -T "$node" lncli --network=regtest create >/dev/null
  elif [[ "$state" == "LOCKED" ]]; then
    printf '%s\n' "$LND_WALLET_PASSWORD" |
      compose exec -T "$node" lncli --network=regtest unlock >/dev/null
  fi
  wait_for_wallet_state "$node" "RPC_ACTIVE"
}

wait_for_chain_sync() {
  local node=$1
  for _ in $(seq 1 60); do
    if [[ $(compose exec -T "$node" lncli --network=regtest getinfo 2>/dev/null | jq -r '.synced_to_chain // false') == "true" ]]; then
      return 0
    fi
    sleep 1
  done
  echo "$node did not synchronize to regtest" >&2
  return 1
}

fund_private_channel() {
  local active_channels confirmed_balance alice_address mine_address bob_pubkey
  active_channels=$(compose exec -T alice lncli --network=regtest listchannels | jq '.channels | length')
  if (( active_channels > 0 )); then
    return 0
  fi

  confirmed_balance=$(compose exec -T alice lncli --network=regtest walletbalance | jq -r '.confirmed_balance | tonumber')
  if (( confirmed_balance < 2000000 )); then
    alice_address=$(compose exec -T alice lncli --network=regtest newaddress p2tr | jq -r .address)
    compose exec -T bitcoind bitcoin-cli -regtest \
      -rpcuser="$BITCOIND_RPC_USER" -rpcpassword="$BITCOIND_RPC_PASSWORD" \
      generatetoaddress 101 "$alice_address" >/dev/null
  fi

  wait_for_chain_sync alice
  wait_for_chain_sync bob
  bob_pubkey=$(compose exec -T bob lncli --network=regtest getinfo | jq -r .identity_pubkey)
  compose exec -T alice lncli --network=regtest connect "$bob_pubkey@bob:9735" >/dev/null 2>&1 || true
  compose exec -T alice lncli --network=regtest openchannel \
    --sat_per_vbyte=1 --private "$bob_pubkey" 1000000 500000 >/dev/null

  mine_address=$(compose exec -T alice lncli --network=regtest newaddress p2tr | jq -r .address)
  compose exec -T bitcoind bitcoin-cli -regtest \
    -rpcuser="$BITCOIND_RPC_USER" -rpcpassword="$BITCOIND_RPC_PASSWORD" \
    generatetoaddress 6 "$mine_address" >/dev/null

  for _ in $(seq 1 60); do
    active_channels=$(compose exec -T alice lncli --network=regtest listchannels | jq '[.channels[] | select(.active == true)] | length')
    if (( active_channels > 0 )); then
      return 0
    fi
    sleep 1
  done
  echo "private regtest channel did not become active" >&2
  return 1
}

bake_node_credentials() {
  local node=$1
  compose exec -T "$node" mkdir -p /root/.lnd/treeswap
  if ! compose exec -T "$node" test -f /root/.lnd/treeswap/observer.macaroon; then
    compose exec -T "$node" lncli --network=regtest bakemacaroon \
      --root_key_id=101 --save_to=/root/.lnd/treeswap/observer.macaroon \
      uri:/lnrpc.Lightning/GetInfo \
      uri:/lnrpc.Lightning/ListChannels \
      uri:/lnrpc.Lightning/PendingChannels \
      uri:/lnrpc.Lightning/ChannelBalance \
      uri:/lnrpc.Lightning/DecodePayReq \
      uri:/lnrpc.Lightning/LookupInvoice >/dev/null
  fi
  if ! compose exec -T "$node" test -f /root/.lnd/treeswap/invoice.macaroon; then
    compose exec -T "$node" lncli --network=regtest bakemacaroon \
      --root_key_id=102 --save_to=/root/.lnd/treeswap/invoice.macaroon \
      uri:/invoicesrpc.Invoices/AddHoldInvoice \
      uri:/invoicesrpc.Invoices/CancelInvoice \
      uri:/invoicesrpc.Invoices/LookupInvoiceV2 \
      uri:/invoicesrpc.Invoices/SettleInvoice \
      uri:/invoicesrpc.Invoices/SubscribeSingleInvoice \
      uri:/lnrpc.Lightning/LookupInvoice >/dev/null
  fi
  if ! compose exec -T "$node" test -f /root/.lnd/treeswap/payer.macaroon; then
    compose exec -T "$node" lncli --network=regtest bakemacaroon \
      --root_key_id=103 --save_to=/root/.lnd/treeswap/payer.macaroon \
      uri:/lnrpc.Lightning/DecodePayReq \
      uri:/routerrpc.Router/SendPaymentV2 \
      uri:/routerrpc.Router/TrackPaymentV2 >/dev/null
  fi
}

bake_credentials() {
  bake_node_credentials alice
  bake_node_credentials bob
  compose exec -T alice lncli --network=regtest \
    --macaroonpath=/root/.lnd/treeswap/observer.macaroon getinfo >/dev/null
  if compose exec -T alice lncli --network=regtest \
    --macaroonpath=/root/.lnd/treeswap/invoice.macaroon getinfo >/dev/null 2>&1; then
    echo "invoice credential unexpectedly authorized GetInfo" >&2
    return 1
  fi
  if compose exec -T alice lncli --network=regtest \
    --macaroonpath=/root/.lnd/treeswap/payer.macaroon addinvoice --amt=1 >/dev/null 2>&1; then
    echo "payer credential unexpectedly authorized AddInvoice" >&2
    return 1
  fi
}

start_lab() {
  ensure_runtime_env
  compose up -d bitcoind alice bob
  wait_for_wallet_rpc alice
  wait_for_wallet_rpc bob
  initialize_wallet alice
  initialize_wallet bob
  fund_private_channel
  bake_credentials
  echo "TreeSwap regtest nodes, private channel, and least-privilege credentials are active."
}

smoke_hold_invoice() {
  ensure_runtime_env
  start_lab >/dev/null
  local preimage payment_hash pay_req payment_pid state result_file accepted=false
  preimage=$(openssl rand -hex 32)
  payment_hash=$(printf '%s' "$preimage" | xxd -r -p | openssl dgst -sha256 -binary | xxd -p -c 256)
  pay_req=$(compose exec -T bob lncli --network=regtest \
    --macaroonpath=/root/.lnd/treeswap/invoice.macaroon addholdinvoice \
    --memo=treeswap-regtest --expiry=300 --cltv_expiry_delta=80 --private \
    "$payment_hash" 10000 | jq -r .payment_request)
  compose exec -T alice lncli --network=regtest \
    --macaroonpath=/root/.lnd/treeswap/payer.macaroon decodepayreq "$pay_req" |
    jq -e '.num_satoshis == "10000" and .payment_hash != ""' >/dev/null

  umask 077
  result_file=$(mktemp "$STATE_DIR/payment-result.XXXXXX")
  compose exec -T alice lncli --network=regtest \
    --macaroonpath=/root/.lnd/treeswap/payer.macaroon payinvoice \
    --force --fee_limit=10 --timeout=30s --json "$pay_req" >"$result_file" &
  payment_pid=$!

  for _ in $(seq 1 30); do
    state=$(compose exec -T bob lncli --network=regtest \
      --macaroonpath=/root/.lnd/treeswap/invoice.macaroon lookupinvoice "$payment_hash" |
      jq -r .state)
    if [[ "$state" == "ACCEPTED" ]]; then
      accepted=true
      break
    fi
    sleep 1
  done
  if [[ "$accepted" != true ]]; then
    kill "$payment_pid" 2>/dev/null || true
    rm -f "$result_file"
    echo "hold invoice was not accepted" >&2
    return 1
  fi

  compose exec -T bob lncli --network=regtest \
    --macaroonpath=/root/.lnd/treeswap/invoice.macaroon settleinvoice "$preimage" >/dev/null
  wait "$payment_pid"
  jq -e 'select(.status == "SUCCEEDED")' "$result_file" >/dev/null
  rm -f "$result_file"
  unset preimage
  echo "Hold-invoice smoke passed: accepted, settled, and paid 10000 sats with separated credentials."
}

status_lab() {
  ensure_runtime_env
  compose ps
  for node in alice bob; do
    compose exec -T "$node" lncli --network=regtest getinfo |
      jq -c '{alias, identity_pubkey, block_height, synced_to_chain, num_active_channels}'
  done
}

stop_lab() {
  ensure_runtime_env
  compose down
}

destroy_lab() {
  ensure_runtime_env
  compose down --volumes
  echo "Regtest containers and Docker volumes removed. Runtime credentials remain in $ENV_FILE."
}

case "${1:-}" in
  up) start_lab ;;
  smoke) smoke_hold_invoice ;;
  status) status_lab ;;
  down) stop_lab ;;
  destroy) destroy_lab ;;
  *)
    echo "Usage: $0 {up|smoke|status|down|destroy}" >&2
    exit 2
    ;;
esac
