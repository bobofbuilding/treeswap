#!/usr/bin/env bash
set -euo pipefail

LAB_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
STATE_DIR="$LAB_DIR/.state"
ENV_FILE="$STATE_DIR/runtime.env"
COMPOSE_FILE="$LAB_DIR/compose.yml"

set_runtime_value() {
  local name=$1
  local value=$2
  local temporary
  temporary=$(mktemp "$STATE_DIR/runtime.env.XXXXXX")
  grep -v "^${name}=" "$ENV_FILE" >"$temporary" || true
  printf '%s=%s\n' "$name" "$value" >>"$temporary"
  chmod 600 "$temporary"
  mv "$temporary" "$ENV_FILE"
}

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
  if [[ ! -f "$STATE_DIR/coordinator-private.pem" || ! -f "$STATE_DIR/coordinator-public.pem" ]]; then
    node "$LAB_DIR/../../scripts/generate-lightning-coordinator-key.mjs" \
      "$STATE_DIR/coordinator-private.pem" "$STATE_DIR/coordinator-public.pem"
  fi
  if ! grep -q '^COORDINATOR_PRIVATE_KEY_PATH=' "$ENV_FILE"; then
    set_runtime_value COORDINATOR_PRIVATE_KEY_PATH "$STATE_DIR/coordinator-private.pem"
  fi
  if ! grep -q '^COORDINATOR_PUBLIC_KEY_PATH=' "$ENV_FILE"; then
    set_runtime_value COORDINATOR_PUBLIC_KEY_PATH "$STATE_DIR/coordinator-public.pem"
  fi
  if ! grep -q '^ADAPTER_CREDENTIAL_ISSUED_AT=' "$ENV_FILE"; then
    set_runtime_value ADAPTER_CREDENTIAL_ISSUED_AT "$(date +%s)"
  fi
  if ! grep -q '^ALICE_TLS_FINGERPRINT=' "$ENV_FILE"; then
    set_runtime_value ALICE_TLS_FINGERPRINT pending
  fi
  if ! grep -q '^BOB_TLS_FINGERPRINT=' "$ENV_FILE"; then
    set_runtime_value BOB_TLS_FINGERPRINT pending
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
    if [[ "$state" == "$expected" || ( "$expected" == "RPC_ACTIVE" && "$state" == "SERVER_ACTIVE" ) ]]; then
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
  local active_channels existing_channels confirmed_balance alice_address mine_address bob_pubkey
  active_channels=$(compose exec -T alice lncli --network=regtest listchannels | jq '[.channels[] | select(.active == true)] | length')
  if (( active_channels > 0 )); then
    return 0
  fi
  existing_channels=$(compose exec -T alice lncli --network=regtest listchannels | jq '.channels | length')
  if (( existing_channels > 0 )); then
    alice_address=$(compose exec -T alice lncli --network=regtest newaddress p2tr | jq -r .address)
    compose exec -T bitcoind bitcoin-cli -regtest \
      -rpcuser="$BITCOIND_RPC_USER" -rpcpassword="$BITCOIND_RPC_PASSWORD" \
      generatetoaddress 1 "$alice_address" >/dev/null
    wait_for_chain_sync alice
    wait_for_chain_sync bob
    bob_pubkey=$(compose exec -T bob lncli --network=regtest getinfo | jq -r .identity_pubkey)
    compose exec -T alice lncli --network=regtest connect "$bob_pubkey@bob:9735" >/dev/null 2>&1 || true
    for _ in $(seq 1 60); do
      active_channels=$(compose exec -T alice lncli --network=regtest listchannels | jq '[.channels[] | select(.active == true)] | length')
      if (( active_channels > 0 )); then
        return 0
      fi
      sleep 1
    done
    echo "existing private regtest channel did not reactivate" >&2
    return 1
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
  compose exec -T "$node" rm -f \
    /root/.lnd/treeswap/observer.macaroon \
    /root/.lnd/treeswap/invoice.macaroon \
    /root/.lnd/treeswap/payer.macaroon
  compose exec -T "$node" lncli --network=regtest bakemacaroon \
    --root_key_id=101 --save_to=/root/.lnd/treeswap/observer.macaroon \
    uri:/lnrpc.Lightning/GetInfo \
    uri:/lnrpc.Lightning/ListChannels \
    uri:/lnrpc.Lightning/PendingChannels \
    uri:/lnrpc.Lightning/ChannelBalance >/dev/null
  compose exec -T "$node" lncli --network=regtest bakemacaroon \
    --root_key_id=102 --save_to=/root/.lnd/treeswap/invoice.macaroon \
    uri:/lnrpc.Lightning/GetInfo \
    uri:/lnrpc.Lightning/ListChannels \
    uri:/lnrpc.Lightning/PendingChannels \
    uri:/invoicesrpc.Invoices/AddHoldInvoice \
    uri:/invoicesrpc.Invoices/CancelInvoice \
    uri:/invoicesrpc.Invoices/LookupInvoiceV2 \
    uri:/invoicesrpc.Invoices/SettleInvoice >/dev/null
  compose exec -T "$node" lncli --network=regtest bakemacaroon \
    --root_key_id=103 --save_to=/root/.lnd/treeswap/payer.macaroon \
    uri:/lnrpc.Lightning/GetInfo \
    uri:/lnrpc.Lightning/ListChannels \
    uri:/lnrpc.Lightning/PendingChannels \
    uri:/lnrpc.Lightning/DecodePayReq \
    uri:/routerrpc.Router/SendPaymentV2 \
    uri:/routerrpc.Router/TrackPaymentV2 >/dev/null
}

bake_credentials() {
  bake_node_credentials alice
  bake_node_credentials bob
  compose exec -T alice lncli --network=regtest \
    --macaroonpath=/root/.lnd/treeswap/observer.macaroon getinfo >/dev/null
  if compose exec -T alice lncli --network=regtest \
    --macaroonpath=/root/.lnd/treeswap/invoice.macaroon walletbalance >/dev/null 2>&1; then
    echo "invoice credential unexpectedly authorized WalletBalance" >&2
    return 1
  fi
  if compose exec -T alice lncli --network=regtest \
    --macaroonpath=/root/.lnd/treeswap/payer.macaroon addinvoice --amt=1 >/dev/null 2>&1; then
    echo "payer credential unexpectedly authorized AddInvoice" >&2
    return 1
  fi
}

node_tls_fingerprint() {
  local node=$1
  compose exec -T "$node" cat /root/.lnd/tls.cert |
    openssl x509 -outform DER |
    openssl dgst -sha256 -binary |
    xxd -p -c 256 |
    awk '{print "sha256:" $0}'
}

start_adapters() {
  set_runtime_value ALICE_TLS_FINGERPRINT "$(node_tls_fingerprint alice)"
  set_runtime_value BOB_TLS_FINGERPRINT "$(node_tls_fingerprint bob)"
  set_runtime_value ADAPTER_CREDENTIAL_ISSUED_AT "$(date +%s)"
  set -a
  source "$ENV_FILE"
  set +a
  compose run --rm export-alice-payer-credential >/dev/null
  compose run --rm export-bob-invoice-credential >/dev/null
  compose --profile adapter up -d --build payer-adapter invoice-adapter
  for adapter in payer-adapter invoice-adapter; do
    wait_for_adapter_healthy "$adapter"
  done
}

wait_for_adapter_healthy() {
  local adapter=$1
  local state=""
  for _ in $(seq 1 60); do
    state=$(compose --profile adapter ps --format json "$adapter" 2>/dev/null | jq -r 'if type == "array" then .[0].Health else .Health end // empty' || true)
    if [[ "$state" == "healthy" ]]; then
      return 0
    fi
    sleep 1
  done
  compose --profile adapter logs --no-color "$adapter" >&2
  echo "$adapter did not become healthy" >&2
  return 1
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
  start_adapters
  echo "TreeSwap regtest nodes, private channel, and isolated Lightning adapters are active."
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

sign_adapter_authorization() {
  local method=$1
  local request_id=$2
  local intent_digest=$3
  local payment_hash=$4
  local invoice_digest=$5
  local amount_sats=$6
  local operation=$7
  local now
  now=$(date +%s)
  jq -cn \
    --arg schema treeswap.lightning-authorization.v1 \
    --arg keyId regtest-coordinator-1 \
    --arg method "$method" \
    --arg requestId "$request_id" \
    --arg intentDigest "$intent_digest" \
    --arg paymentHash "$payment_hash" \
    --arg invoiceDigest "$invoice_digest" \
    --arg amountSats "$amount_sats" \
    --argjson capacityEpoch 1 \
    --argjson authorizedAt "$now" \
    --argjson expiresAt "$((now + 30))" \
    --argjson operation "$operation" \
    '{schema:$schema,keyId:$keyId,method:$method,requestId:$requestId,intentDigest:$intentDigest,paymentHash:$paymentHash,invoiceDigest:$invoiceDigest,amountSats:$amountSats,capacityEpoch:$capacityEpoch,authorizedAt:$authorizedAt,expiresAt:$expiresAt,operation:$operation}' |
    COORDINATOR_PRIVATE_KEY_PATH="$COORDINATOR_PRIVATE_KEY_PATH" node "$LAB_DIR/../../scripts/sign-lightning-authorization.mjs"
}

call_adapter() {
  local adapter=$1
  shift
  sign_adapter_authorization "$@" |
    call_signed_adapter "$adapter"
}

call_signed_adapter() {
  local adapter=$1
  compose --profile adapter exec -T "$adapter" node /app/infra/lightning-adapter/client.mjs
}

smoke_adapter_hold_invoice() {
  ensure_runtime_env
  start_lab >/dev/null
  local preimage payment_hash intent_digest create_id create_operation create_result
  local pay_req invoice_digest payment_id pay_operation payment_envelope payment_result payment_pid
  local lookup_id lookup_operation lookup_result state accepted settle_id settle_operation settle_result
  local replay_result wrong_role_id wrong_role_envelope wrong_role_result
  preimage="0x$(openssl rand -hex 32)"
  payment_hash="0x$(printf '%s' "${preimage#0x}" | xxd -r -p | openssl dgst -sha256 -binary | xxd -p -c 256)"
  intent_digest="0x$(openssl rand -hex 32)"
  create_id="0x$(openssl rand -hex 32)"
  create_operation=$(jq -cn '{memo:"treeswap-adapter-regtest",expirySeconds:600,cltvExpiry:80,isPrivate:true}')
  if ! create_result=$(call_adapter invoice-adapter \
    /invoicesrpc.Invoices/AddHoldInvoice "$create_id" "$intent_digest" "$payment_hash" \
    "0x0000000000000000000000000000000000000000000000000000000000000000" 10000 "$create_operation"); then
    printf '%s\n' "$create_result" >&2
    return 1
  fi
  pay_req=$(jq -er '.result.paymentRequest' <<<"$create_result")
  invoice_digest=$(jq -er '.result.invoiceDigest' <<<"$create_result")

  payment_id="0x$(openssl rand -hex 32)"
  pay_operation=$(jq -cn --arg paymentRequest "$pay_req" '{paymentRequest:$paymentRequest,timeoutSeconds:30,feeLimitSats:"10"}')
  payment_envelope=$(sign_adapter_authorization /routerrpc.Router/SendPaymentV2 "$payment_id" "$intent_digest" \
    "$payment_hash" "$invoice_digest" 10000 "$pay_operation")
  umask 077
  payment_result=$(mktemp "$STATE_DIR/adapter-payment.XXXXXX")
  printf '%s\n' "$payment_envelope" | call_signed_adapter payer-adapter >"$payment_result" &
  payment_pid=$!

  lookup_operation='{}'
  accepted=false
  for _ in $(seq 1 30); do
    lookup_id="0x$(openssl rand -hex 32)"
    if ! lookup_result=$(call_adapter invoice-adapter /invoicesrpc.Invoices/LookupInvoiceV2 "$lookup_id" \
      "$intent_digest" "$payment_hash" "$invoice_digest" 10000 "$lookup_operation"); then
      kill "$payment_pid" 2>/dev/null || true
      rm -f "$payment_result"
      printf '%s\n' "$lookup_result" >&2
      return 1
    fi
    state=$(jq -r '.result.state' <<<"$lookup_result")
    if [[ "$state" == "ACCEPTED" ]]; then
      accepted=true
      break
    fi
    sleep 1
  done
  if [[ "$accepted" != true ]]; then
    kill "$payment_pid" 2>/dev/null || true
    rm -f "$payment_result"
    echo "adapter hold invoice was not accepted" >&2
    return 1
  fi

  settle_id="0x$(openssl rand -hex 32)"
  settle_operation=$(jq -cn --arg preimage "$preimage" '{preimage:$preimage}')
  if ! settle_result=$(call_adapter invoice-adapter /invoicesrpc.Invoices/SettleInvoice "$settle_id" \
    "$intent_digest" "$payment_hash" "$invoice_digest" 10000 "$settle_operation"); then
    kill "$payment_pid" 2>/dev/null || true
    rm -f "$payment_result"
    printf '%s\n' "$settle_result" >&2
    return 1
  fi
  jq -e '.result.state == "SETTLED"' <<<"$settle_result" >/dev/null
  wait "$payment_pid"
  jq -e --arg preimage "$preimage" \
    '.result.status == "SUCCEEDED" and .result.amountSats == "10000" and .result.preimage == $preimage' \
    "$payment_result" >/dev/null

  compose --profile adapter restart payer-adapter >/dev/null
  wait_for_adapter_healthy payer-adapter
  if replay_result=$(printf '%s\n' "$payment_envelope" | call_signed_adapter payer-adapter); then
    rm -f "$payment_result"
    echo "payer adapter accepted a replay after restart" >&2
    return 1
  fi
  jq -e '.error | test("already used")' <<<"$replay_result" >/dev/null

  wrong_role_id="0x$(openssl rand -hex 32)"
  wrong_role_envelope=$(sign_adapter_authorization /routerrpc.Router/SendPaymentV2 "$wrong_role_id" "$intent_digest" \
    "$payment_hash" "$invoice_digest" 10000 "$pay_operation")
  if wrong_role_result=$(printf '%s\n' "$wrong_role_envelope" | call_signed_adapter invoice-adapter); then
    rm -f "$payment_result"
    echo "invoice adapter accepted a payer authorization" >&2
    return 1
  fi
  jq -e '.error | test("does not belong")' <<<"$wrong_role_result" >/dev/null
  rm -f "$payment_result"
  unset preimage
  echo "Adapter smoke passed: signed intent, pinned TLS, role isolation, accepted hold, settle, 10000-sat payment, and restart-safe replay rejection."
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
  adapter-smoke) smoke_adapter_hold_invoice ;;
  status) status_lab ;;
  down) stop_lab ;;
  destroy) destroy_lab ;;
  *)
    echo "Usage: $0 {up|smoke|adapter-smoke|status|down|destroy}" >&2
    exit 2
    ;;
esac
