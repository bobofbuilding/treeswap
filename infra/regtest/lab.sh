#!/usr/bin/env bash
set -euo pipefail

LAB_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
STATE_DIR="$LAB_DIR/.state"
ENV_FILE="$STATE_DIR/runtime.env"
COMPOSE_FILE="$LAB_DIR/compose.yml"
ROLE_CREDENTIAL_LIFETIME_SECONDS=86400

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
    case "$state" in
      NON_EXISTING|LOCKED|RPC_ACTIVE|SERVER_ACTIVE) return 0 ;;
    esac
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
  local info
  for _ in $(seq 1 60); do
    info=$(compose exec -T "$node" lncli --network=regtest getinfo 2>/dev/null || true)
    if jq -e '.synced_to_chain == true and .wallet_synced == true' <<<"$info" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "$node did not synchronize its chain and wallet to regtest" >&2
  return 1
}

wait_for_block_height() {
  local node=$1
  local target_height=$2
  local block_height=0
  for _ in $(seq 1 90); do
    block_height=$(compose exec -T "$node" lncli --network=regtest getinfo 2>/dev/null |
      jq -r '.block_height | tonumber' || true)
    if (( block_height >= target_height )); then
      return 0
    fi
    sleep 1
  done
  echo "$node did not reach regtest block height $target_height" >&2
  return 1
}

wait_for_active_channel() {
  local node=$1
  local active_channels=0
  for _ in $(seq 1 60); do
    active_channels=$(compose exec -T "$node" lncli --network=regtest listchannels 2>/dev/null |
      jq '[.channels[] | select(.active == true)] | length' || true)
    if (( active_channels > 0 )); then
      return 0
    fi
    sleep 1
  done
  echo "$node did not regain an active regtest channel" >&2
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

refresh_regtest_chain_header() {
  local miner_address
  miner_address=$(compose exec -T alice lncli --network=regtest newaddress p2tr | jq -er .address)
  compose exec -T bitcoind bitcoin-cli -regtest \
    -rpcuser="$BITCOIND_RPC_USER" -rpcpassword="$BITCOIND_RPC_PASSWORD" \
    generatetoaddress 1 "$miner_address" >/dev/null
  wait_for_chain_sync alice
  wait_for_chain_sync bob
}

bake_node_credentials() {
  local node=$1
  compose exec -T "$node" mkdir -p /root/.lnd/treeswap
  compose exec -T "$node" rm -f \
    /root/.lnd/treeswap/observer.macaroon \
    /root/.lnd/treeswap/invoice.macaroon \
    /root/.lnd/treeswap/payer.macaroon
  compose exec -T "$node" lncli --network=regtest bakemacaroon \
    --timeout="$ROLE_CREDENTIAL_LIFETIME_SECONDS" \
    --root_key_id=101 --save_to=/root/.lnd/treeswap/observer.macaroon \
    uri:/lnrpc.Lightning/GetInfo \
    uri:/lnrpc.Lightning/ListChannels \
    uri:/lnrpc.Lightning/PendingChannels \
    uri:/lnrpc.Lightning/ChannelBalance >/dev/null
  compose exec -T "$node" lncli --network=regtest bakemacaroon \
    --timeout="$ROLE_CREDENTIAL_LIFETIME_SECONDS" \
    --root_key_id=102 --save_to=/root/.lnd/treeswap/invoice.macaroon \
    uri:/lnrpc.Lightning/GetInfo \
    uri:/lnrpc.Lightning/ListChannels \
    uri:/lnrpc.Lightning/PendingChannels \
    uri:/invoicesrpc.Invoices/AddHoldInvoice \
    uri:/invoicesrpc.Invoices/CancelInvoice \
    uri:/invoicesrpc.Invoices/LookupInvoiceV2 \
    uri:/invoicesrpc.Invoices/SettleInvoice >/dev/null
  compose exec -T "$node" lncli --network=regtest bakemacaroon \
    --timeout="$ROLE_CREDENTIAL_LIFETIME_SECONDS" \
    --root_key_id=103 --save_to=/root/.lnd/treeswap/payer.macaroon \
    uri:/lnrpc.Lightning/GetInfo \
    uri:/lnrpc.Lightning/ListChannels \
    uri:/lnrpc.Lightning/PendingChannels \
    uri:/lnrpc.Lightning/DecodePayReq \
    uri:/routerrpc.Router/SendPaymentV2 \
    uri:/routerrpc.Router/TrackPaymentV2 >/dev/null
}

role_root_key_id() {
  case "$1" in
    observer) printf '%s\n' 101 ;;
    invoice) printf '%s\n' 102 ;;
    payer) printf '%s\n' 103 ;;
    *) echo "unknown credential role" >&2; return 1 ;;
  esac
}

role_permissions() {
  case "$1" in
    observer)
      printf '%s\n' \
        uri:/lnrpc.Lightning/ChannelBalance \
        uri:/lnrpc.Lightning/GetInfo \
        uri:/lnrpc.Lightning/ListChannels \
        uri:/lnrpc.Lightning/PendingChannels
      ;;
    invoice)
      printf '%s\n' \
        uri:/invoicesrpc.Invoices/AddHoldInvoice \
        uri:/invoicesrpc.Invoices/CancelInvoice \
        uri:/invoicesrpc.Invoices/LookupInvoiceV2 \
        uri:/invoicesrpc.Invoices/SettleInvoice \
        uri:/lnrpc.Lightning/GetInfo \
        uri:/lnrpc.Lightning/ListChannels \
        uri:/lnrpc.Lightning/PendingChannels
      ;;
    payer)
      printf '%s\n' \
        uri:/lnrpc.Lightning/DecodePayReq \
        uri:/lnrpc.Lightning/GetInfo \
        uri:/lnrpc.Lightning/ListChannels \
        uri:/lnrpc.Lightning/PendingChannels \
        uri:/routerrpc.Router/SendPaymentV2 \
        uri:/routerrpc.Router/TrackPaymentV2
      ;;
    *) echo "unknown credential role" >&2; return 1 ;;
  esac
}

verify_role_manifest_at() {
  local node=$1
  local role=$2
  local macaroon_path=$3
  local root_key_id=$4
  local manifest expected actual caveat caveat_time expires_at now
  local available_permissions uri
  manifest=$(compose exec -T "$node" lncli --network=regtest printmacaroon \
    --macaroon_file="$macaroon_path")
  if [[ $(jq -r '.root_key_id' <<<"$manifest") != "$root_key_id" ]]; then
    echo "$node $role credential has the wrong root-key ID" >&2
    return 1
  fi
  expected=$(role_permissions "$role" | LC_ALL=C sort)
  actual=$(jq -r '.permissions[]' <<<"$manifest" | LC_ALL=C sort)
  if [[ "$actual" != "$expected" ]]; then
    echo "$node $role credential permissions differ from the exact manifest" >&2
    return 1
  fi
  caveat=$(jq -er 'if (.caveats | length) == 1 then .caveats[0] else error("wrong caveat count") end' <<<"$manifest")
  if [[ ! "$caveat" =~ ^time-before\ [0-9]{4}-[0-9]{2}-[0-9]{2}T ]]; then
    echo "$node $role credential lacks one bounded time caveat" >&2
    return 1
  fi
  caveat_time=${caveat#time-before }
  caveat_time="${caveat_time%%.*}Z"
  expires_at=$(jq -nr --arg value "$caveat_time" '$value | fromdateiso8601')
  now=$(date +%s)
  if (( expires_at <= now || expires_at > now + ROLE_CREDENTIAL_LIFETIME_SECONDS + 60 )); then
    echo "$node $role credential expiry falls outside the configured lifetime" >&2
    return 1
  fi
  available_permissions=$(compose exec -T "$node" lncli --network=regtest listpermissions)
  while IFS= read -r uri; do
    if ! jq -e --arg uri "${uri#uri:}" '.method_permissions[$uri] != null' <<<"$available_permissions" >/dev/null; then
      echo "$node $role credential contains an RPC URI unknown to the pinned LND" >&2
      return 1
    fi
  done < <(role_permissions "$role")
}

verify_role_manifest() {
  local node=$1
  local role=$2
  verify_role_manifest_at "$node" "$role" "/root/.lnd/treeswap/${role}.macaroon" \
    "$(role_root_key_id "$role")"
}

assert_role_command_denied() {
  local node=$1
  local role=$2
  local output
  shift 2
  if output=$(compose exec -T "$node" lncli --network=regtest \
    --macaroonpath="/root/.lnd/treeswap/${role}.macaroon" "$@" 2>&1); then
    echo "$node $role credential unexpectedly authorized: $*" >&2
    return 1
  fi
  if [[ "$output" != *"permission denied"* ]]; then
    echo "$node $role negative check failed for a reason other than authorization: $*" >&2
    return 1
  fi
}

verify_role_negative_matrix() {
  local node=$1
  local role=$2
  assert_role_command_denied "$node" "$role" walletbalance
  assert_role_command_denied "$node" "$role" listinvoices
  assert_role_command_denied "$node" "$role" listpayments
  assert_role_command_denied "$node" "$role" listmacaroonids
  if [[ "$role" != "observer" ]]; then
    assert_role_command_denied "$node" "$role" channelbalance
  fi
  if [[ "$role" == "observer" ]]; then
    assert_role_command_denied "$node" "$role" getnetworkinfo
  fi
}

bake_credentials() {
  local node role
  bake_node_credentials alice
  bake_node_credentials bob
  for node in alice bob; do
    for role in observer invoice payer; do
      verify_role_manifest "$node" "$role"
      verify_role_negative_matrix "$node" "$role"
    done
  done
  compose exec -T alice lncli --network=regtest \
    --macaroonpath=/root/.lnd/treeswap/observer.macaroon getinfo >/dev/null
}

delete_test_macaroon_id() {
  local node=$1
  local root_key_id=$2
  if compose exec -T "$node" lncli --network=regtest listmacaroonids |
    jq -e --arg rootKeyId "$root_key_id" '.root_key_ids | index($rootKeyId) != null' >/dev/null; then
    compose exec -T "$node" lncli --network=regtest deletemacaroonid "$root_key_id" >/dev/null
  fi
}

assert_test_credential_denied() {
  local node=$1
  local macaroon_path=$2
  local expected_reason=$3
  local output
  if output=$(compose exec -T "$node" lncli --network=regtest \
    --macaroonpath="$macaroon_path" getinfo 2>&1); then
    echo "$node disposable credential remained authorized after $expected_reason" >&2
    return 1
  fi
  case "$expected_reason" in
    expiry)
      if [[ "$output" != *"macaroon has expired"* ]]; then
        echo "$node disposable credential did not fail specifically because it expired" >&2
        return 1
      fi
      ;;
    revocation)
      if [[ "$output" != *"cannot get macaroon"* && "$output" != *"permission denied"* ]]; then
        echo "$node disposable credential did not fail specifically because its root key was revoked" >&2
        return 1
      fi
      ;;
    *) echo "unknown credential denial reason" >&2; return 1 ;;
  esac
}

smoke_credential_lifecycle() {
  ensure_runtime_env
  start_lab >/dev/null
  local node=alice
  local expiry_root_key_id=9001
  local revocation_root_key_id=9002
  local expiry_path=/root/.lnd/treeswap/expiry-test.macaroon
  local revocation_path=/root/.lnd/treeswap/revocation-test.macaroon

  delete_test_macaroon_id "$node" "$expiry_root_key_id"
  delete_test_macaroon_id "$node" "$revocation_root_key_id"
  compose exec -T "$node" rm -f "$expiry_path" "$revocation_path"

  compose exec -T "$node" lncli --network=regtest bakemacaroon \
    --timeout=2 --root_key_id="$expiry_root_key_id" --save_to="$expiry_path" \
    uri:/lnrpc.Lightning/GetInfo >/dev/null
  compose exec -T "$node" lncli --network=regtest \
    --macaroonpath="$expiry_path" getinfo >/dev/null
  sleep 3
  assert_test_credential_denied "$node" "$expiry_path" expiry
  compose exec -T "$node" lncli --network=regtest getinfo >/dev/null
  delete_test_macaroon_id "$node" "$expiry_root_key_id"

  compose exec -T "$node" lncli --network=regtest bakemacaroon \
    --timeout=60 --root_key_id="$revocation_root_key_id" --save_to="$revocation_path" \
    uri:/lnrpc.Lightning/GetInfo >/dev/null
  compose exec -T "$node" lncli --network=regtest \
    --macaroonpath="$revocation_path" getinfo >/dev/null
  compose exec -T "$node" lncli --network=regtest \
    deletemacaroonid "$revocation_root_key_id" >/dev/null
  assert_test_credential_denied "$node" "$revocation_path" revocation
  compose exec -T "$node" lncli --network=regtest getinfo >/dev/null
  compose exec -T "$node" rm -f "$expiry_path" "$revocation_path"

  echo "Credential lifecycle smoke passed: exact role manifests, authorization-only denials, expiry, and root-key revocation."
}

delete_exported_payer_next_credential() {
  compose --profile tools run --rm -T --entrypoint /bin/sh export-alice-payer-credential \
    -ec 'rm -f /target/payer-next.macaroon' >/dev/null
}

smoke_credential_rotation() {
  ensure_runtime_env
  start_lab >/dev/null
  local node=alice
  local old_root_key_id=103
  local next_root_key_id=203
  local next_source=/root/.lnd/treeswap/payer-next.macaroon
  local next_target=/run/treeswap/credentials/payer-next.macaroon
  local next_container="treeswap-regtest-payer-next"
  local invoice payment_request payment_hash invoice_digest intent_digest operation
  local old_id old_result next_id next_result revoked_id revoked_result recovered_id recovered_result

  trap 'docker rm -f "${next_container:-missing}" >/dev/null 2>&1 || true; \
    delete_exported_payer_next_credential >/dev/null 2>&1 || true; \
    if [[ -n "${payment_hash:-}" ]]; then compose exec -T bob lncli --network=regtest cancelinvoice "${payment_hash#0x}" >/dev/null 2>&1 || true; fi; \
    compose exec -T "${node:-alice}" rm -f "${next_source:-/invalid}" >/dev/null 2>&1 || true; \
    delete_test_macaroon_id "${node:-alice}" "${next_root_key_id:-203}" >/dev/null 2>&1 || true; \
    bake_node_credentials "${node:-alice}" >/dev/null 2>&1 || true; \
    start_adapters >/dev/null 2>&1 || true' EXIT

  docker rm -f "$next_container" >/dev/null 2>&1 || true
  delete_test_macaroon_id "$node" "$next_root_key_id"
  compose exec -T "$node" rm -f "$next_source"
  compose exec -T "$node" lncli --network=regtest bakemacaroon \
    --timeout="$ROLE_CREDENTIAL_LIFETIME_SECONDS" \
    --root_key_id="$next_root_key_id" --save_to="$next_source" \
    uri:/lnrpc.Lightning/GetInfo \
    uri:/lnrpc.Lightning/ListChannels \
    uri:/lnrpc.Lightning/PendingChannels \
    uri:/lnrpc.Lightning/DecodePayReq \
    uri:/routerrpc.Router/SendPaymentV2 \
    uri:/routerrpc.Router/TrackPaymentV2 >/dev/null
  verify_role_manifest_at "$node" payer "$next_source" "$next_root_key_id"

  compose --profile tools run --rm -T --entrypoint /bin/sh export-alice-payer-credential \
    -ec 'cp -f /source/treeswap/payer-next.macaroon /target/payer-next.macaroon; chown 1000:1000 /target/payer-next.macaroon; chmod 0400 /target/payer-next.macaroon' \
    >/dev/null
  compose --profile adapter run --rm -d --name "$next_container" \
    -e LND_MACAROON_PATH="$next_target" \
    -e CREDENTIAL_ID=alice-payer-regtest-next \
    -e CREDENTIAL_ROOT_KEY_ID="$next_root_key_id" \
    -e ADAPTER_JOURNAL_PATH=/tmp/rotation-actions.jsonl \
    payer-adapter >/dev/null
  wait_for_disposable_adapter "$next_container"

  invoice=$(compose exec -T bob lncli --network=regtest addinvoice \
    --amt=10000 --memo=treeswap-credential-rotation --expiry=600 --private)
  payment_request=$(jq -er '.payment_request' <<<"$invoice")
  payment_hash=$(compose exec -T alice lncli --network=regtest \
    --macaroonpath=/root/.lnd/treeswap/payer.macaroon decodepayreq "$payment_request" |
    jq -er '.payment_hash | ascii_downcase | "0x" + .')
  invoice_digest="0x$(printf '%s' "$payment_request" | openssl dgst -sha256 -binary | xxd -p -c 256)"
  intent_digest="0x$(openssl rand -hex 32)"
  operation=$(jq -cn --arg paymentRequest "$payment_request" '{paymentRequest:$paymentRequest}')

  old_id="0x$(openssl rand -hex 32)"
  old_result=$(call_adapter payer-adapter /lnrpc.Lightning/DecodePayReq \
    "$old_id" "$intent_digest" "$payment_hash" "$invoice_digest" 10000 "$operation")
  jq -e --arg paymentHash "$payment_hash" \
    '.result.paymentHash == $paymentHash and .result.amountSats == "10000"' <<<"$old_result" >/dev/null
  next_id="0x$(openssl rand -hex 32)"
  next_result=$(sign_adapter_authorization /lnrpc.Lightning/DecodePayReq \
    "$next_id" "$intent_digest" "$payment_hash" "$invoice_digest" 10000 "$operation" |
    docker exec -i "$next_container" node /app/infra/lightning-adapter/client.mjs)
  jq -e --arg paymentHash "$payment_hash" \
    '.result.paymentHash == $paymentHash and .result.amountSats == "10000"' <<<"$next_result" >/dev/null
  echo "Credential-rotation stage passed: old and next exact-role credentials overlapped successfully."

  if ! compose exec -T "$node" lncli --network=regtest \
    deletemacaroonid "$old_root_key_id" >/dev/null; then
    echo "old payer root key could not be revoked" >&2
    return 1
  fi
  assert_test_credential_denied "$node" /root/.lnd/treeswap/payer.macaroon revocation
  revoked_id="0x$(openssl rand -hex 32)"
  if revoked_result=$(call_adapter payer-adapter /lnrpc.Lightning/DecodePayReq \
    "$revoked_id" "$intent_digest" "$payment_hash" "$invoice_digest" 10000 "$operation"); then
    echo "old payer adapter remained authorized after root-key revocation" >&2
    return 1
  fi
  if ! jq -e '.ambiguous == false and .errorCode == "REJECTED"' <<<"$revoked_result" >/dev/null; then
    echo "old payer adapter did not return a deterministic rejection after root-key revocation" >&2
    jq -c '{errorCode,ambiguous}' <<<"$revoked_result" >&2 || true
    return 1
  fi

  next_id="0x$(openssl rand -hex 32)"
  next_result=$(sign_adapter_authorization /lnrpc.Lightning/DecodePayReq \
    "$next_id" "$intent_digest" "$payment_hash" "$invoice_digest" 10000 "$operation" |
    docker exec -i "$next_container" node /app/infra/lightning-adapter/client.mjs)
  if ! jq -e --arg paymentHash "$payment_hash" \
    '.result.paymentHash == $paymentHash and .result.amountSats == "10000"' <<<"$next_result" >/dev/null; then
    echo "replacement payer credential stopped working after old-root revocation" >&2
    jq -c '{errorCode,ambiguous}' <<<"$next_result" >&2 || true
    return 1
  fi

  docker rm -f "$next_container" >/dev/null
  delete_exported_payer_next_credential
  compose exec -T "$node" rm -f "$next_source"
  delete_test_macaroon_id "$node" "$next_root_key_id"
  bake_node_credentials "$node"
  verify_role_manifest "$node" payer
  start_adapters >/dev/null

  recovered_id="0x$(openssl rand -hex 32)"
  recovered_result=$(call_adapter payer-adapter /lnrpc.Lightning/DecodePayReq \
    "$recovered_id" "$intent_digest" "$payment_hash" "$invoice_digest" 10000 "$operation")
  if ! jq -e --arg paymentHash "$payment_hash" \
    '.result.paymentHash == $paymentHash and .result.amountSats == "10000"' <<<"$recovered_result" >/dev/null; then
    echo "standard payer credential did not recover after the rotation drill" >&2
    jq -c '{errorCode,ambiguous}' <<<"$recovered_result" >&2 || true
    return 1
  fi
  compose exec -T bob lncli --network=regtest cancelinvoice "${payment_hash#0x}" >/dev/null
  unset payment_request
  trap - EXIT

  echo "Credential-rotation smoke passed: overlap, old-root revocation, uninterrupted next credential, and baseline recovery all succeeded."
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
  compose run --rm export-coordinator-private-key >/dev/null
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

wait_for_disposable_adapter() {
  local container=$1
  for _ in $(seq 1 60); do
    if docker exec "$container" node -e \
      'fetch("http://127.0.0.1:3000/healthz").then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))' \
      >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  docker logs "$container" >&2 2>/dev/null || true
  echo "disposable adapter did not become ready" >&2
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
  refresh_regtest_chain_header
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
    state=$(compose exec -T bob lncli --network=regtest lookupinvoice "$payment_hash" |
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

smoke_invoice_faults() {
  ensure_runtime_env
  start_lab >/dev/null
  local amount_sats=10000
  local zero_hash="0x$(printf '00%.0s' {1..32})"
  local expiry_preimage expiry_payment_hash expiry_state late_output
  local preimage payment_hash intent_digest create_id create_operation create_result
  local pay_req invoice_digest payment_id pay_operation payment_envelope
  local payment_result="" payment_pid="" lookup_id lookup_result state accepted
  local wrong_preimage wrong_id wrong_operation wrong_result cancel_id cancel_envelope cancel_result
  local settle_id settle_operation settle_result replay_result
  local restart_preimage restart_hash restart_intent restart_create_id restart_create_result
  local restart_pay_req restart_invoice_digest restart_payment_id restart_payment_envelope
  local restart_result="" restart_pid="" restart_lookup_id restart_lookup_result
  local restart_settle_id restart_settle_operation restart_settle_result

  trap '[[ -z "${payment_pid:-}" ]] || kill "$payment_pid" 2>/dev/null || true; \
    [[ -z "${restart_pid:-}" ]] || kill "$restart_pid" 2>/dev/null || true; \
    [[ -z "${payment_result:-}" ]] || rm -f "$payment_result"; \
    [[ -z "${restart_result:-}" ]] || rm -f "$restart_result"' EXIT

  expiry_preimage=$(openssl rand -hex 32)
  expiry_payment_hash=$(printf '%s' "$expiry_preimage" | xxd -r -p |
    openssl dgst -sha256 -binary | xxd -p -c 256)
  compose exec -T bob lncli --network=regtest \
    --macaroonpath=/root/.lnd/treeswap/invoice.macaroon addholdinvoice \
    --memo=treeswap-expiry-regtest --expiry=2 --cltv_expiry_delta=48 --private \
    "$expiry_payment_hash" "$amount_sats" >/dev/null
  sleep 3
  expiry_state=$(compose exec -T bob lncli --network=regtest lookupinvoice "$expiry_payment_hash" |
    jq -er '.state')
  if [[ "$expiry_state" != "CANCELED" ]]; then
    echo "expired hold invoice did not become CANCELED" >&2
    return 1
  fi
  if late_output=$(compose exec -T bob lncli --network=regtest \
    --macaroonpath=/root/.lnd/treeswap/invoice.macaroon settleinvoice "$expiry_preimage" 2>&1); then
    echo "expired hold invoice accepted a late settlement" >&2
    return 1
  fi
  if [[ "$late_output" != *"invoice already canceled"* ]]; then
    echo "late settlement failed for a reason other than invoice expiry" >&2
    return 1
  fi
  unset expiry_preimage

  preimage="0x$(openssl rand -hex 32)"
  payment_hash="0x$(printf '%s' "${preimage#0x}" | xxd -r -p |
    openssl dgst -sha256 -binary | xxd -p -c 256)"
  intent_digest="0x$(openssl rand -hex 32)"
  create_id="0x$(openssl rand -hex 32)"
  create_operation=$(jq -cn '{memo:"treeswap-cancel-regtest",expirySeconds:600,cltvExpiry:80,isPrivate:true}')
  create_result=$(call_adapter invoice-adapter /invoicesrpc.Invoices/AddHoldInvoice \
    "$create_id" "$intent_digest" "$payment_hash" "$zero_hash" "$amount_sats" "$create_operation")
  pay_req=$(jq -er '.result.paymentRequest' <<<"$create_result")
  invoice_digest=$(jq -er '.result.invoiceDigest' <<<"$create_result")
  payment_id="0x$(openssl rand -hex 32)"
  pay_operation=$(jq -cn --arg paymentRequest "$pay_req" \
    '{paymentRequest:$paymentRequest,timeoutSeconds:30,feeLimitSats:"10"}')
  payment_envelope=$(sign_adapter_authorization /routerrpc.Router/SendPaymentV2 \
    "$payment_id" "$intent_digest" "$payment_hash" "$invoice_digest" "$amount_sats" "$pay_operation")
  umask 077
  payment_result=$(mktemp "$STATE_DIR/invoice-fault-payment.XXXXXX")
  printf '%s\n' "$payment_envelope" | call_signed_adapter payer-adapter >"$payment_result" &
  payment_pid=$!

  accepted=false
  for _ in $(seq 1 30); do
    lookup_id="0x$(openssl rand -hex 32)"
    lookup_result=$(call_adapter invoice-adapter /invoicesrpc.Invoices/LookupInvoiceV2 \
      "$lookup_id" "$intent_digest" "$payment_hash" "$invoice_digest" "$amount_sats" '{}')
    state=$(jq -er '.result.state' <<<"$lookup_result")
    if [[ "$state" == "ACCEPTED" ]]; then
      accepted=true
      break
    fi
    sleep 1
  done
  if [[ "$accepted" != true ]]; then
    echo "cancel fault invoice was not accepted" >&2
    return 1
  fi

  wrong_preimage="0x$(openssl rand -hex 32)"
  wrong_id="0x$(openssl rand -hex 32)"
  wrong_operation=$(jq -cn --arg preimage "$wrong_preimage" '{preimage:$preimage}')
  if wrong_result=$(call_adapter invoice-adapter /invoicesrpc.Invoices/SettleInvoice \
    "$wrong_id" "$intent_digest" "$payment_hash" "$invoice_digest" "$amount_sats" "$wrong_operation"); then
    echo "invoice adapter accepted a wrong preimage" >&2
    return 1
  fi
  jq -e '.error | test("preimage does not match")' <<<"$wrong_result" >/dev/null
  lookup_id="0x$(openssl rand -hex 32)"
  lookup_result=$(call_adapter invoice-adapter /invoicesrpc.Invoices/LookupInvoiceV2 \
    "$lookup_id" "$intent_digest" "$payment_hash" "$invoice_digest" "$amount_sats" '{}')
  jq -e '.result.state == "ACCEPTED"' <<<"$lookup_result" >/dev/null

  cancel_id="0x$(openssl rand -hex 32)"
  cancel_envelope=$(sign_adapter_authorization /invoicesrpc.Invoices/CancelInvoice \
    "$cancel_id" "$intent_digest" "$payment_hash" "$invoice_digest" "$amount_sats" '{}')
  cancel_result=$(printf '%s\n' "$cancel_envelope" | call_signed_adapter invoice-adapter)
  jq -e '.result.state == "CANCELED"' <<<"$cancel_result" >/dev/null
  lookup_id="0x$(openssl rand -hex 32)"
  lookup_result=$(call_adapter invoice-adapter /invoicesrpc.Invoices/LookupInvoiceV2 \
    "$lookup_id" "$intent_digest" "$payment_hash" "$invoice_digest" "$amount_sats" '{}')
  jq -e '.result.state == "CANCELED"' <<<"$lookup_result" >/dev/null
  if replay_result=$(printf '%s\n' "$cancel_envelope" | call_signed_adapter invoice-adapter); then
    echo "invoice adapter accepted a replayed cancellation" >&2
    return 1
  fi
  jq -e '.error | test("already used")' <<<"$replay_result" >/dev/null

  settle_id="0x$(openssl rand -hex 32)"
  settle_operation=$(jq -cn --arg preimage "$preimage" '{preimage:$preimage}')
  if settle_result=$(call_adapter invoice-adapter /invoicesrpc.Invoices/SettleInvoice \
    "$settle_id" "$intent_digest" "$payment_hash" "$invoice_digest" "$amount_sats" "$settle_operation"); then
    echo "canceled hold invoice accepted a late settlement" >&2
    return 1
  fi
  jq -e '.error | test("not accepted")' <<<"$settle_result" >/dev/null
  if wait "$payment_pid"; then
    payment_pid=""
    echo "payer reported success for a canceled hold invoice" >&2
    return 1
  fi
  payment_pid=""
  jq -e '.error | test("Lightning payment failed")' "$payment_result" >/dev/null
  rm -f "$payment_result"
  payment_result=""
  unset preimage wrong_preimage pay_req payment_envelope

  restart_preimage="0x$(openssl rand -hex 32)"
  restart_hash="0x$(printf '%s' "${restart_preimage#0x}" | xxd -r -p |
    openssl dgst -sha256 -binary | xxd -p -c 256)"
  restart_intent="0x$(openssl rand -hex 32)"
  restart_create_id="0x$(openssl rand -hex 32)"
  restart_create_result=$(call_adapter invoice-adapter /invoicesrpc.Invoices/AddHoldInvoice \
    "$restart_create_id" "$restart_intent" "$restart_hash" "$zero_hash" "$amount_sats" \
    "$(jq -cn '{memo:"treeswap-restart-regtest",expirySeconds:600,cltvExpiry:80,isPrivate:true}')")
  restart_pay_req=$(jq -er '.result.paymentRequest' <<<"$restart_create_result")
  restart_invoice_digest=$(jq -er '.result.invoiceDigest' <<<"$restart_create_result")
  restart_payment_id="0x$(openssl rand -hex 32)"
  restart_payment_envelope=$(sign_adapter_authorization /routerrpc.Router/SendPaymentV2 \
    "$restart_payment_id" "$restart_intent" "$restart_hash" "$restart_invoice_digest" "$amount_sats" \
    "$(jq -cn --arg paymentRequest "$restart_pay_req" \
      '{paymentRequest:$paymentRequest,timeoutSeconds:30,feeLimitSats:"10"}')")
  restart_result=$(mktemp "$STATE_DIR/invoice-restart-payment.XXXXXX")
  printf '%s\n' "$restart_payment_envelope" | call_signed_adapter payer-adapter >"$restart_result" &
  restart_pid=$!

  accepted=false
  for _ in $(seq 1 30); do
    restart_lookup_id="0x$(openssl rand -hex 32)"
    restart_lookup_result=$(call_adapter invoice-adapter /invoicesrpc.Invoices/LookupInvoiceV2 \
      "$restart_lookup_id" "$restart_intent" "$restart_hash" "$restart_invoice_digest" "$amount_sats" '{}')
    state=$(jq -er '.result.state' <<<"$restart_lookup_result")
    if [[ "$state" == "ACCEPTED" ]]; then
      accepted=true
      break
    fi
    sleep 1
  done
  if [[ "$accepted" != true ]]; then
    echo "restart fault invoice was not accepted" >&2
    return 1
  fi

  compose restart bob >/dev/null
  wait_for_wallet_rpc bob
  initialize_wallet bob
  wait_for_chain_sync bob
  wait_for_active_channel bob
  restart_lookup_id="0x$(openssl rand -hex 32)"
  restart_lookup_result=$(call_adapter invoice-adapter /invoicesrpc.Invoices/LookupInvoiceV2 \
    "$restart_lookup_id" "$restart_intent" "$restart_hash" "$restart_invoice_digest" "$amount_sats" '{}')
  jq -e '.result.state == "ACCEPTED"' <<<"$restart_lookup_result" >/dev/null

  restart_settle_id="0x$(openssl rand -hex 32)"
  restart_settle_operation=$(jq -cn --arg preimage "$restart_preimage" '{preimage:$preimage}')
  restart_settle_result=$(call_adapter invoice-adapter /invoicesrpc.Invoices/SettleInvoice \
    "$restart_settle_id" "$restart_intent" "$restart_hash" "$restart_invoice_digest" \
    "$amount_sats" "$restart_settle_operation")
  jq -e '.result.state == "SETTLED"' <<<"$restart_settle_result" >/dev/null
  wait "$restart_pid"
  restart_pid=""
  jq -e --arg preimage "$restart_preimage" \
    '.result.status == "SUCCEEDED" and .result.preimage == $preimage' "$restart_result" >/dev/null
  rm -f "$restart_result"
  restart_result=""
  unset restart_preimage restart_pay_req restart_payment_envelope
  trap - EXIT

  echo "Invoice fault smoke passed: expiry, late-settle rejection, wrong preimage, cancel, replay, and accepted-state LND restart."
}

assert_adapter_payment_not_found() {
  local intent_digest=$1
  local payment_hash=$2
  local invoice_digest=$3
  local amount_sats=$4
  local request_id result payment_hash_base64 payment_hash_url
  request_id="0x$(openssl rand -hex 32)"
  if result=$(call_adapter payer-adapter /routerrpc.Router/TrackPaymentV2 \
    "$request_id" "$intent_digest" "$payment_hash" "$invoice_digest" "$amount_sats" '{}'); then
    echo "payment was dispatched despite a pre-dispatch rejection" >&2
    return 1
  fi
  if ! jq -e '.errorCode == "NOT_FOUND"' <<<"$result" >/dev/null; then
    echo "read-only tracking did not return NOT_FOUND after pre-dispatch rejection" >&2
    jq -c '{error,errorCode,ambiguous}' <<<"$result" >&2
    return 1
  fi
  payment_hash_base64=$(printf '%s' "${payment_hash#0x}" | xxd -r -p | openssl base64 -A)
  payment_hash_url=$(jq -nr --arg value "$payment_hash_base64" '$value | @uri')
  if [[ "$result" == *"${payment_hash#0x}"* || "$result" == *"$payment_hash_base64"* || "$result" == *"$payment_hash_url"* ]]; then
    echo "read-only tracking error exposed its bound payment hash" >&2
    return 1
  fi
}

smoke_policy_faults() {
  ensure_runtime_env
  start_lab >/dev/null
  local invoice payment_request payment_hash invoice_digest intent_digest request_id operation result
  local hold_preimage_one hold_preimage_two hold_hash_one="" hold_hash_two=""
  local hold_request_one hold_request_two state inflight_sats active_channels
  local hold_result_one="" hold_result_two="" hold_pid_one="" hold_pid_two=""
  local offline_invoice offline_request offline_hash offline_digest offline_intent offline_result
  local decode_result tls_result

  trap '[[ -z "${hold_hash_one:-}" ]] || compose exec -T bob lncli --network=regtest cancelinvoice "$hold_hash_one" >/dev/null 2>&1 || true; \
    [[ -z "${hold_hash_two:-}" ]] || compose exec -T bob lncli --network=regtest cancelinvoice "$hold_hash_two" >/dev/null 2>&1 || true; \
    [[ -z "${hold_pid_one:-}" ]] || kill "$hold_pid_one" 2>/dev/null || true; \
    [[ -z "${hold_pid_two:-}" ]] || kill "$hold_pid_two" 2>/dev/null || true; \
    [[ -z "${hold_result_one:-}" ]] || rm -f "$hold_result_one"; \
    [[ -z "${hold_result_two:-}" ]] || rm -f "$hold_result_two"; \
    compose start bob >/dev/null 2>&1 || true' EXIT

  invoice=$(compose exec -T bob lncli --network=regtest addinvoice \
    --amt=10000 --memo=treeswap-fee-cap --expiry=600 --private)
  payment_request=$(jq -er '.payment_request' <<<"$invoice")
  payment_hash=$(compose exec -T alice lncli --network=regtest \
    --macaroonpath=/root/.lnd/treeswap/payer.macaroon decodepayreq "$payment_request" |
    jq -er '.payment_hash | ascii_downcase | "0x" + .')
  invoice_digest="0x$(printf '%s' "$payment_request" | openssl dgst -sha256 -binary | xxd -p -c 256)"
  intent_digest="0x$(openssl rand -hex 32)"
  request_id="0x$(openssl rand -hex 32)"
  operation=$(jq -cn --arg paymentRequest "$payment_request" \
    '{paymentRequest:$paymentRequest,timeoutSeconds:30,feeLimitSats:"11"}')
  if result=$(call_adapter payer-adapter /routerrpc.Router/SendPaymentV2 \
    "$request_id" "$intent_digest" "$payment_hash" "$invoice_digest" 10000 "$operation"); then
    echo "payer adapter accepted a routing fee above its cap" >&2
    return 1
  fi
  if ! jq -e '.error | test("routing fee limit exceeds policy")' <<<"$result" >/dev/null; then
    echo "routing-fee probe failed for an unexpected reason" >&2
    jq -c '{error,errorCode,ambiguous}' <<<"$result" >&2
    return 1
  fi
  assert_adapter_payment_not_found "$intent_digest" "$payment_hash" "$invoice_digest" 10000
  echo "Policy fault stage passed: routing-fee cap and no dispatch."

  invoice=$(compose exec -T bob lncli --network=regtest addinvoice \
    --amt=100001 --memo=treeswap-amount-cap --expiry=600 --private)
  payment_request=$(jq -er '.payment_request' <<<"$invoice")
  payment_hash=$(compose exec -T alice lncli --network=regtest \
    --macaroonpath=/root/.lnd/treeswap/payer.macaroon decodepayreq "$payment_request" |
    jq -er '.payment_hash | ascii_downcase | "0x" + .')
  invoice_digest="0x$(printf '%s' "$payment_request" | openssl dgst -sha256 -binary | xxd -p -c 256)"
  intent_digest="0x$(openssl rand -hex 32)"
  request_id="0x$(openssl rand -hex 32)"
  operation=$(jq -cn --arg paymentRequest "$payment_request" \
    '{paymentRequest:$paymentRequest,timeoutSeconds:30,feeLimitSats:"10"}')
  if result=$(call_adapter payer-adapter /routerrpc.Router/SendPaymentV2 \
    "$request_id" "$intent_digest" "$payment_hash" "$invoice_digest" 100001 "$operation"); then
    echo "payer adapter accepted a payment above its per-payment cap" >&2
    return 1
  fi
  if ! jq -e '.error | test("per-payment Lightning cap exceeded")' <<<"$result" >/dev/null; then
    echo "per-payment probe failed for an unexpected reason" >&2
    jq -c '{error,errorCode,ambiguous}' <<<"$result" >&2
    return 1
  fi
  assert_adapter_payment_not_found "$intent_digest" "$payment_hash" "$invoice_digest" 100001
  echo "Policy fault stage passed: per-payment cap and no dispatch."

  hold_preimage_one=$(openssl rand -hex 32)
  hold_hash_one=$(printf '%s' "$hold_preimage_one" | xxd -r -p |
    openssl dgst -sha256 -binary | xxd -p -c 256)
  hold_request_one=$(compose exec -T bob lncli --network=regtest \
    --macaroonpath=/root/.lnd/treeswap/invoice.macaroon addholdinvoice \
    --memo=treeswap-inflight-one --expiry=600 --cltv_expiry_delta=80 --private \
    "$hold_hash_one" 80000 | jq -er '.payment_request')
  hold_preimage_two=$(openssl rand -hex 32)
  hold_hash_two=$(printf '%s' "$hold_preimage_two" | xxd -r -p |
    openssl dgst -sha256 -binary | xxd -p -c 256)
  hold_request_two=$(compose exec -T bob lncli --network=regtest \
    --macaroonpath=/root/.lnd/treeswap/invoice.macaroon addholdinvoice \
    --memo=treeswap-inflight-two --expiry=600 --cltv_expiry_delta=80 --private \
    "$hold_hash_two" 80000 | jq -er '.payment_request')
  umask 077
  hold_result_one=$(mktemp "$STATE_DIR/policy-hold-one.XXXXXX")
  hold_result_two=$(mktemp "$STATE_DIR/policy-hold-two.XXXXXX")
  compose exec -T alice lncli --network=regtest \
    --macaroonpath=/root/.lnd/treeswap/payer.macaroon payinvoice \
    --force --fee_limit=10 --timeout=30s --json "$hold_request_one" >"$hold_result_one" 2>/dev/null &
  hold_pid_one=$!
  compose exec -T alice lncli --network=regtest \
    --macaroonpath=/root/.lnd/treeswap/payer.macaroon payinvoice \
    --force --fee_limit=10 --timeout=30s --json "$hold_request_two" >"$hold_result_two" 2>/dev/null &
  hold_pid_two=$!
  for _ in $(seq 1 30); do
    state=$(compose exec -T bob lncli --network=regtest lookupinvoice "$hold_hash_one" |
      jq -er '.state')
    [[ "$state" == "ACCEPTED" ]] || { sleep 1; continue; }
    state=$(compose exec -T bob lncli --network=regtest lookupinvoice "$hold_hash_two" |
      jq -er '.state')
    [[ "$state" == "ACCEPTED" ]] && break
    sleep 1
  done
  if [[ "$state" != "ACCEPTED" ]]; then
    echo "in-flight cap probes were not both accepted" >&2
    return 1
  fi
  inflight_sats=$(compose exec -T alice lncli --network=regtest listchannels |
    jq '[.channels[].pending_htlcs[].amount | tonumber] | add // 0')
  if (( inflight_sats < 160000 )); then
    echo "LND did not expose the expected in-flight HTLC value" >&2
    return 1
  fi

  invoice=$(compose exec -T bob lncli --network=regtest addinvoice \
    --amt=10000 --memo=treeswap-inflight-cap --expiry=600 --private)
  payment_request=$(jq -er '.payment_request' <<<"$invoice")
  payment_hash=$(compose exec -T alice lncli --network=regtest \
    --macaroonpath=/root/.lnd/treeswap/payer.macaroon decodepayreq "$payment_request" |
    jq -er '.payment_hash | ascii_downcase | "0x" + .')
  invoice_digest="0x$(printf '%s' "$payment_request" | openssl dgst -sha256 -binary | xxd -p -c 256)"
  intent_digest="0x$(openssl rand -hex 32)"
  request_id="0x$(openssl rand -hex 32)"
  operation=$(jq -cn --arg paymentRequest "$payment_request" \
    '{paymentRequest:$paymentRequest,timeoutSeconds:30,feeLimitSats:"10"}')
  if result=$(call_adapter payer-adapter /routerrpc.Router/SendPaymentV2 \
    "$request_id" "$intent_digest" "$payment_hash" "$invoice_digest" 10000 "$operation"); then
    echo "payer adapter opened exposure above its live in-flight cap" >&2
    return 1
  fi
  jq -e '.error | test("Lightning in-flight cap exceeded")' <<<"$result" >/dev/null
  assert_adapter_payment_not_found "$intent_digest" "$payment_hash" "$invoice_digest" 10000
  echo "Policy fault stage passed: live in-flight cap and no dispatch."
  compose exec -T bob lncli --network=regtest cancelinvoice "$hold_hash_one" >/dev/null
  compose exec -T bob lncli --network=regtest cancelinvoice "$hold_hash_two" >/dev/null
  hold_hash_one=""
  hold_hash_two=""
  if wait "$hold_pid_one"; then
    hold_pid_one=""
    echo "first canceled capacity probe unexpectedly succeeded" >&2
    return 1
  fi
  hold_pid_one=""
  if wait "$hold_pid_two"; then
    hold_pid_two=""
    echo "second canceled capacity probe unexpectedly succeeded" >&2
    return 1
  fi
  hold_pid_two=""
  rm -f "$hold_result_one" "$hold_result_two"
  hold_result_one=""
  hold_result_two=""
  unset hold_preimage_one hold_preimage_two hold_request_one hold_request_two

  offline_invoice=$(compose exec -T bob lncli --network=regtest addinvoice \
    --amt=10000 --memo=treeswap-offline-channel --expiry=600 --private)
  offline_request=$(jq -er '.payment_request' <<<"$offline_invoice")
  offline_hash=$(compose exec -T alice lncli --network=regtest \
    --macaroonpath=/root/.lnd/treeswap/payer.macaroon decodepayreq "$offline_request" |
    jq -er '.payment_hash | ascii_downcase | "0x" + .')
  offline_digest="0x$(printf '%s' "$offline_request" | openssl dgst -sha256 -binary | xxd -p -c 256)"
  offline_intent="0x$(openssl rand -hex 32)"
  compose stop bob >/dev/null
  active_channels=1
  for _ in $(seq 1 60); do
    active_channels=$(compose exec -T alice lncli --network=regtest listchannels 2>/dev/null |
      jq '[.channels[] | select(.active == true)] | length' || true)
    (( active_channels == 0 )) && break
    sleep 1
  done
  if (( active_channels != 0 )); then
    echo "Alice did not mark the stopped peer channel inactive" >&2
    return 1
  fi
  request_id="0x$(openssl rand -hex 32)"
  operation=$(jq -cn --arg paymentRequest "$offline_request" \
    '{paymentRequest:$paymentRequest,timeoutSeconds:30,feeLimitSats:"10"}')
  if offline_result=$(call_adapter payer-adapter /routerrpc.Router/SendPaymentV2 \
    "$request_id" "$offline_intent" "$offline_hash" "$offline_digest" 10000 "$operation"); then
    echo "payer adapter dispatched while its only channel was offline" >&2
    return 1
  fi
  jq -e '.error | test("service is unhealthy or unsynced")' <<<"$offline_result" >/dev/null
  compose start bob >/dev/null
  wait_for_wallet_rpc bob
  initialize_wallet bob
  wait_for_chain_sync bob
  wait_for_active_channel alice
  wait_for_active_channel bob
  assert_adapter_payment_not_found "$offline_intent" "$offline_hash" "$offline_digest" 10000
  echo "Policy fault stage passed: channel-offline rejection and recovery."

  if tls_result=$(compose --profile adapter run --rm -T \
    -e LND_TLS_CERT_FINGERPRINT="sha256:$(printf '00%.0s' {1..32})" payer-adapter 2>&1); then
    echo "payer adapter started with a mismatched LND certificate pin" >&2
    return 1
  fi
  if [[ "$tls_result" != *"configured LND certificate pin does not match the credential bundle"* ]]; then
    echo "mismatched TLS-pin probe failed for an unexpected reason" >&2
    return 1
  fi

  request_id="0x$(openssl rand -hex 32)"
  decode_result=$(call_adapter payer-adapter /lnrpc.Lightning/DecodePayReq \
    "$request_id" "$offline_intent" "$offline_hash" "$offline_digest" 10000 \
    "$(jq -cn --arg paymentRequest "$offline_request" '{paymentRequest:$paymentRequest}')")
  jq -e --arg paymentHash "$offline_hash" \
    '.result.paymentHash == $paymentHash and .result.amountSats == "10000"' <<<"$decode_result" >/dev/null
  echo "Policy fault stage passed: mismatched TLS pin and healthy pinned adapter."
  compose exec -T bob lncli --network=regtest cancelinvoice "${offline_hash#0x}" >/dev/null
  trap - EXIT

  echo "Policy fault smoke passed: fee, amount, in-flight, offline-channel, no-dispatch, recovery, and TLS-pin enforcement."
}

smoke_directional_capacity() {
  ensure_runtime_env
  start_lab >/dev/null
  local amount_sats=100000
  local target_remaining_sats=75000
  local alice_local normalize_amount normalize_invoice normalize_request
  local drain_amount drain_invoice drain_request restore_invoice restore_request=""
  local payer_invoice payer_request payer_hash payer_digest payer_intent payer_id payer_operation payer_result
  local invoice_preimage invoice_hash invoice_intent invoice_id invoice_operation invoice_result invoice_digest
  local cancel_id cancel_result zero_hash
  local drained=false restored=false hold_created=false final_payer_paid=false final_restore_request=""
  local current_alice_local current_bob_remote recovered=false

  trap '[[ "${hold_created:-false}" != true || -z "${invoice_hash:-}" ]] || \
      compose exec -T bob lncli --network=regtest cancelinvoice "${invoice_hash#0x}" >/dev/null 2>&1 || true; \
    [[ "${final_payer_paid:-false}" != true || -z "${final_restore_request:-}" ]] || \
      compose exec -T bob lncli --network=regtest --macaroonpath=/root/.lnd/treeswap/payer.macaroon \
        payinvoice --force --fee_limit=10 --timeout=30s "$final_restore_request" >/dev/null 2>&1 || true; \
    [[ "${drained:-false}" != true || "${restored:-false}" == true || -z "${restore_request:-}" ]] || \
      compose exec -T bob lncli --network=regtest --macaroonpath=/root/.lnd/treeswap/payer.macaroon \
        payinvoice --force --fee_limit=10 --timeout=30s "$restore_request" >/dev/null 2>&1 || true' EXIT

  alice_local=$(compose exec -T alice lncli --network=regtest listchannels |
    jq -er '[.channels[] | select(.active == true) | (.local_balance | tonumber)] | add')
  if (( alice_local < 350000 )); then
    normalize_amount=$((350000 - alice_local))
    normalize_invoice=$(compose exec -T alice lncli --network=regtest addinvoice \
      --amt="$normalize_amount" --memo=treeswap-capacity-normalize --expiry=600 --private)
    normalize_request=$(jq -er '.payment_request' <<<"$normalize_invoice")
    compose exec -T bob lncli --network=regtest \
      --macaroonpath=/root/.lnd/treeswap/payer.macaroon payinvoice \
      --force --fee_limit=10 --timeout=30s "$normalize_request" >/dev/null
    alice_local=$(compose exec -T alice lncli --network=regtest listchannels |
      jq -er '[.channels[] | select(.active == true) | (.local_balance | tonumber)] | add')
  fi
  if (( alice_local <= target_remaining_sats + amount_sats )); then
    echo "regtest channel could not establish the directional-capacity baseline" >&2
    return 1
  fi

  drain_amount=$((alice_local - target_remaining_sats))
  drain_invoice=$(compose exec -T bob lncli --network=regtest addinvoice \
    --amt="$drain_amount" --memo=treeswap-capacity-drain --expiry=600 --private)
  drain_request=$(jq -er '.payment_request' <<<"$drain_invoice")
  restore_invoice=$(compose exec -T alice lncli --network=regtest addinvoice \
    --amt="$drain_amount" --memo=treeswap-capacity-restore --expiry=600 --private)
  restore_request=$(jq -er '.payment_request' <<<"$restore_invoice")
  compose exec -T alice lncli --network=regtest \
    --macaroonpath=/root/.lnd/treeswap/payer.macaroon payinvoice \
    --force --fee_limit=10 --timeout=30s "$drain_request" >/dev/null
  drained=true

  for _ in $(seq 1 30); do
    current_alice_local=$(compose exec -T alice lncli --network=regtest listchannels |
      jq -er '[.channels[] | select(.active == true) | (.local_balance | tonumber)] | add')
    current_bob_remote=$(compose exec -T bob lncli --network=regtest listchannels |
      jq -er '[.channels[] | select(.active == true) | (.remote_balance | tonumber)] | add')
    if (( current_alice_local < amount_sats && current_bob_remote < amount_sats )); then
      break
    fi
    sleep 1
  done
  if (( current_alice_local >= amount_sats || current_bob_remote >= amount_sats )); then
    echo "regtest channel did not reach the directional-capacity boundary" >&2
    return 1
  fi

  payer_invoice=$(compose exec -T bob lncli --network=regtest addinvoice \
    --amt="$amount_sats" --memo=treeswap-outbound-capacity --expiry=600 --private)
  payer_request=$(jq -er '.payment_request' <<<"$payer_invoice")
  payer_hash=$(compose exec -T alice lncli --network=regtest \
    --macaroonpath=/root/.lnd/treeswap/payer.macaroon decodepayreq "$payer_request" |
    jq -er '.payment_hash | ascii_downcase | "0x" + .')
  payer_digest="0x$(printf '%s' "$payer_request" | openssl dgst -sha256 -binary | xxd -p -c 256)"
  payer_intent="0x$(openssl rand -hex 32)"
  payer_id="0x$(openssl rand -hex 32)"
  payer_operation=$(jq -cn --arg paymentRequest "$payer_request" \
    '{paymentRequest:$paymentRequest,timeoutSeconds:30,feeLimitSats:"10"}')
  if payer_result=$(call_adapter payer-adapter /routerrpc.Router/SendPaymentV2 \
    "$payer_id" "$payer_intent" "$payer_hash" "$payer_digest" "$amount_sats" "$payer_operation"); then
    echo "payer adapter dispatched without enough outbound liquidity" >&2
    return 1
  fi
  jq -e '.ambiguous == false and (.error | test("directional Lightning liquidity is insufficient"))' \
    <<<"$payer_result" >/dev/null
  assert_adapter_payment_not_found "$payer_intent" "$payer_hash" "$payer_digest" "$amount_sats"

  invoice_preimage="0x$(openssl rand -hex 32)"
  invoice_hash="0x$(printf '%s' "${invoice_preimage#0x}" | xxd -r -p |
    openssl dgst -sha256 -binary | xxd -p -c 256)"
  invoice_intent="0x$(openssl rand -hex 32)"
  invoice_id="0x$(openssl rand -hex 32)"
  invoice_operation=$(jq -cn '{memo:"treeswap-inbound-capacity",expirySeconds:600,cltvExpiry:80,isPrivate:true}')
  zero_hash="0x$(printf '00%.0s' {1..32})"
  if invoice_result=$(call_adapter invoice-adapter /invoicesrpc.Invoices/AddHoldInvoice \
    "$invoice_id" "$invoice_intent" "$invoice_hash" "$zero_hash" "$amount_sats" "$invoice_operation"); then
    echo "invoice adapter opened exposure without enough inbound liquidity" >&2
    return 1
  fi
  jq -e '.ambiguous == false and (.error | test("directional Lightning liquidity is insufficient"))' \
    <<<"$invoice_result" >/dev/null
  if compose exec -T bob lncli --network=regtest lookupinvoice "${invoice_hash#0x}" >/dev/null 2>&1; then
    echo "inbound-capacity rejection still created a hold invoice" >&2
    return 1
  fi
  echo "Directional-capacity stage passed: both exposure directions rejected before dispatch."

  compose exec -T bob lncli --network=regtest \
    --macaroonpath=/root/.lnd/treeswap/payer.macaroon payinvoice \
    --force --fee_limit=10 --timeout=30s "$restore_request" >/dev/null
  restored=true
  restore_request=""
  wait_for_active_channel alice
  wait_for_active_channel bob
  for _ in $(seq 1 30); do
    current_alice_local=$(compose exec -T alice lncli --network=regtest listchannels |
      jq -er '[.channels[] | select(.active == true) | (.local_balance | tonumber)] | add')
    current_bob_remote=$(compose exec -T bob lncli --network=regtest listchannels |
      jq -er '[.channels[] | select(.active == true) | (.remote_balance | tonumber)] | add')
    if (( current_alice_local >= amount_sats && current_bob_remote >= amount_sats )); then
      recovered=true
      break
    fi
    sleep 1
  done
  if [[ "$recovered" != true ]]; then
    echo "directional liquidity did not recover after rebalancing" >&2
    return 1
  fi

  final_restore_request=$(compose exec -T alice lncli --network=regtest addinvoice \
    --amt="$amount_sats" --memo=treeswap-capacity-final-restore --expiry=600 --private |
    jq -er '.payment_request')
  payer_id="0x$(openssl rand -hex 32)"
  payer_result=$(call_adapter payer-adapter /routerrpc.Router/SendPaymentV2 \
    "$payer_id" "$payer_intent" "$payer_hash" "$payer_digest" "$amount_sats" "$payer_operation")
  jq -e --arg paymentHash "$payer_hash" --arg amount "$amount_sats" \
    '.result.status == "SUCCEEDED" and .result.paymentHash == $paymentHash and .result.amountSats == $amount' \
    <<<"$payer_result" >/dev/null
  final_payer_paid=true
  compose exec -T bob lncli --network=regtest \
    --macaroonpath=/root/.lnd/treeswap/payer.macaroon payinvoice \
    --force --fee_limit=10 --timeout=30s "$final_restore_request" >/dev/null
  final_payer_paid=false
  final_restore_request=""

  invoice_id="0x$(openssl rand -hex 32)"
  invoice_result=$(call_adapter invoice-adapter /invoicesrpc.Invoices/AddHoldInvoice \
    "$invoice_id" "$invoice_intent" "$invoice_hash" "$zero_hash" "$amount_sats" "$invoice_operation")
  invoice_digest=$(jq -er '.result.invoiceDigest' <<<"$invoice_result")
  hold_created=true
  cancel_id="0x$(openssl rand -hex 32)"
  cancel_result=$(call_adapter invoice-adapter /invoicesrpc.Invoices/CancelInvoice \
    "$cancel_id" "$invoice_intent" "$invoice_hash" "$invoice_digest" "$amount_sats" '{}')
  jq -e '.result.state == "CANCELED"' <<<"$cancel_result" >/dev/null
  hold_created=false
  invoice_hash=""
  unset payer_request invoice_preimage
  trap - EXIT

  echo "Directional-capacity smoke passed: outbound and inbound exposure failed closed at exhaustion, then both recovered after rebalancing."
}

smoke_daily_cap() {
  ensure_runtime_env
  start_lab >/dev/null
  local cap_sats=10000
  local suffix payer_container invoice_container payer_journal invoice_journal
  local payer_invoice payer_request payer_hash payer_digest payer_intent payer_id payer_operation payer_result
  local rejected_invoice rejected_request rejected_hash rejected_digest rejected_intent rejected_id rejected_operation rejected_result
  local restore_invoice restore_request="" payer_paid=false
  local hold_preimage hold_hash hold_intent hold_id hold_operation hold_result hold_digest hold_created=false
  local rejected_preimage rejected_hold_hash rejected_hold_intent rejected_hold_id rejected_hold_operation rejected_hold_result
  local cancel_id cancel_result zero_hash

  suffix=$(openssl rand -hex 8)
  payer_container="treeswap-regtest-daily-payer-$suffix"
  invoice_container="treeswap-regtest-daily-invoice-$suffix"
  payer_journal="/data/daily-cap-$suffix.jsonl"
  invoice_journal="/data/daily-cap-$suffix.jsonl"
  trap '[[ "${hold_created:-false}" != true || -z "${hold_hash:-}" ]] || \
      compose exec -T bob lncli --network=regtest cancelinvoice "${hold_hash#0x}" >/dev/null 2>&1 || true; \
    [[ "${payer_paid:-false}" != true || -z "${restore_request:-}" ]] || \
      compose exec -T bob lncli --network=regtest --macaroonpath=/root/.lnd/treeswap/payer.macaroon \
        payinvoice --force --fee_limit=10 --timeout=30s "$restore_request" >/dev/null 2>&1 || true; \
    docker exec "${payer_container:-missing}" rm -f "${payer_journal:-/invalid}" >/dev/null 2>&1 || true; \
    docker exec "${invoice_container:-missing}" rm -f "${invoice_journal:-/invalid}" >/dev/null 2>&1 || true; \
    docker rm -f "${payer_container:-missing}" "${invoice_container:-missing}" >/dev/null 2>&1 || true' EXIT

  docker rm -f "$payer_container" "$invoice_container" >/dev/null 2>&1 || true
  compose --profile adapter run --rm -d --name "$payer_container" \
    -e MAX_DAILY_VALUE_SATS="$cap_sats" \
    -e ADAPTER_JOURNAL_PATH="$payer_journal" \
    payer-adapter >/dev/null
  wait_for_disposable_adapter "$payer_container"

  restore_invoice=$(compose exec -T alice lncli --network=regtest addinvoice \
    --amt="$cap_sats" --memo=treeswap-daily-cap-restore --expiry=600 --private)
  restore_request=$(jq -er '.payment_request' <<<"$restore_invoice")
  payer_invoice=$(compose exec -T bob lncli --network=regtest addinvoice \
    --amt="$cap_sats" --memo=treeswap-daily-cap-fill --expiry=600 --private)
  payer_request=$(jq -er '.payment_request' <<<"$payer_invoice")
  payer_hash=$(compose exec -T alice lncli --network=regtest \
    --macaroonpath=/root/.lnd/treeswap/payer.macaroon decodepayreq "$payer_request" |
    jq -er '.payment_hash | ascii_downcase | "0x" + .')
  payer_digest="0x$(printf '%s' "$payer_request" | openssl dgst -sha256 -binary | xxd -p -c 256)"
  payer_intent="0x$(openssl rand -hex 32)"
  payer_id="0x$(openssl rand -hex 32)"
  payer_operation=$(jq -cn --arg paymentRequest "$payer_request" \
    '{paymentRequest:$paymentRequest,timeoutSeconds:30,feeLimitSats:"10"}')
  payer_result=$(sign_adapter_authorization /routerrpc.Router/SendPaymentV2 \
    "$payer_id" "$payer_intent" "$payer_hash" "$payer_digest" "$cap_sats" "$payer_operation" |
    docker exec -i "$payer_container" node /app/infra/lightning-adapter/client.mjs)
  jq -e --arg paymentHash "$payer_hash" --arg amount "$cap_sats" \
    '.result.status == "SUCCEEDED" and .result.paymentHash == $paymentHash and .result.amountSats == $amount' \
    <<<"$payer_result" >/dev/null
  payer_paid=true

  docker rm -f "$payer_container" >/dev/null
  compose --profile adapter run --rm -d --name "$payer_container" \
    -e MAX_DAILY_VALUE_SATS="$cap_sats" \
    -e ADAPTER_JOURNAL_PATH="$payer_journal" \
    payer-adapter >/dev/null
  wait_for_disposable_adapter "$payer_container"

  rejected_invoice=$(compose exec -T bob lncli --network=regtest addinvoice \
    --amt=1 --memo=treeswap-daily-cap-reject --expiry=600 --private)
  rejected_request=$(jq -er '.payment_request' <<<"$rejected_invoice")
  rejected_hash=$(compose exec -T alice lncli --network=regtest \
    --macaroonpath=/root/.lnd/treeswap/payer.macaroon decodepayreq "$rejected_request" |
    jq -er '.payment_hash | ascii_downcase | "0x" + .')
  rejected_digest="0x$(printf '%s' "$rejected_request" | openssl dgst -sha256 -binary | xxd -p -c 256)"
  rejected_intent="0x$(openssl rand -hex 32)"
  rejected_id="0x$(openssl rand -hex 32)"
  rejected_operation=$(jq -cn --arg paymentRequest "$rejected_request" \
    '{paymentRequest:$paymentRequest,timeoutSeconds:30,feeLimitSats:"10"}')
  if rejected_result=$(sign_adapter_authorization /routerrpc.Router/SendPaymentV2 \
    "$rejected_id" "$rejected_intent" "$rejected_hash" "$rejected_digest" 1 "$rejected_operation" |
    docker exec -i "$payer_container" node /app/infra/lightning-adapter/client.mjs); then
    echo "restarted payer adapter exceeded its daily cap" >&2
    return 1
  fi
  jq -e '.ambiguous == false and (.error | test("daily Lightning cap exceeded"))' \
    <<<"$rejected_result" >/dev/null
  assert_adapter_payment_not_found "$rejected_intent" "$rejected_hash" "$rejected_digest" 1
  compose exec -T bob lncli --network=regtest cancelinvoice "${rejected_hash#0x}" >/dev/null

  compose exec -T bob lncli --network=regtest \
    --macaroonpath=/root/.lnd/treeswap/payer.macaroon payinvoice \
    --force --fee_limit=10 --timeout=30s "$restore_request" >/dev/null
  payer_paid=false
  restore_request=""
  echo "Daily-cap stage passed: payer saturation survived adapter restart and the next payment was not dispatched."

  compose --profile adapter run --rm -d --name "$invoice_container" \
    -e MAX_DAILY_VALUE_SATS="$cap_sats" \
    -e ADAPTER_JOURNAL_PATH="$invoice_journal" \
    invoice-adapter >/dev/null
  wait_for_disposable_adapter "$invoice_container"
  zero_hash="0x$(printf '00%.0s' {1..32})"
  hold_preimage="0x$(openssl rand -hex 32)"
  hold_hash="0x$(printf '%s' "${hold_preimage#0x}" | xxd -r -p |
    openssl dgst -sha256 -binary | xxd -p -c 256)"
  hold_intent="0x$(openssl rand -hex 32)"
  hold_id="0x$(openssl rand -hex 32)"
  hold_operation=$(jq -cn '{memo:"treeswap-daily-cap-hold",expirySeconds:600,cltvExpiry:80,isPrivate:true}')
  hold_result=$(sign_adapter_authorization /invoicesrpc.Invoices/AddHoldInvoice \
    "$hold_id" "$hold_intent" "$hold_hash" "$zero_hash" "$cap_sats" "$hold_operation" |
    docker exec -i "$invoice_container" node /app/infra/lightning-adapter/client.mjs)
  hold_digest=$(jq -er '.result.invoiceDigest' <<<"$hold_result")
  hold_created=true

  docker rm -f "$invoice_container" >/dev/null
  compose --profile adapter run --rm -d --name "$invoice_container" \
    -e MAX_DAILY_VALUE_SATS="$cap_sats" \
    -e ADAPTER_JOURNAL_PATH="$invoice_journal" \
    invoice-adapter >/dev/null
  wait_for_disposable_adapter "$invoice_container"

  rejected_preimage="0x$(openssl rand -hex 32)"
  rejected_hold_hash="0x$(printf '%s' "${rejected_preimage#0x}" | xxd -r -p |
    openssl dgst -sha256 -binary | xxd -p -c 256)"
  rejected_hold_intent="0x$(openssl rand -hex 32)"
  rejected_hold_id="0x$(openssl rand -hex 32)"
  rejected_hold_operation=$(jq -cn '{memo:"treeswap-daily-cap-hold-reject",expirySeconds:600,cltvExpiry:80,isPrivate:true}')
  if rejected_hold_result=$(sign_adapter_authorization /invoicesrpc.Invoices/AddHoldInvoice \
    "$rejected_hold_id" "$rejected_hold_intent" "$rejected_hold_hash" "$zero_hash" 1 "$rejected_hold_operation" |
    docker exec -i "$invoice_container" node /app/infra/lightning-adapter/client.mjs); then
    echo "restarted invoice adapter exceeded its daily cap" >&2
    return 1
  fi
  jq -e '.ambiguous == false and (.error | test("daily Lightning cap exceeded"))' \
    <<<"$rejected_hold_result" >/dev/null
  if compose exec -T bob lncli --network=regtest lookupinvoice "${rejected_hold_hash#0x}" >/dev/null 2>&1; then
    echo "daily-cap rejection still created a hold invoice" >&2
    return 1
  fi

  cancel_id="0x$(openssl rand -hex 32)"
  cancel_result=$(call_adapter invoice-adapter /invoicesrpc.Invoices/CancelInvoice \
    "$cancel_id" "$hold_intent" "$hold_hash" "$hold_digest" "$cap_sats" '{}')
  jq -e '.result.state == "CANCELED"' <<<"$cancel_result" >/dev/null
  hold_created=false
  hold_hash=""
  unset payer_request rejected_request hold_preimage rejected_preimage
  docker exec "$payer_container" rm -f "$payer_journal" >/dev/null
  docker exec "$invoice_container" rm -f "$invoice_journal" >/dev/null
  docker rm -f "$payer_container" "$invoice_container" >/dev/null
  trap - EXIT

  echo "Daily-cap smoke passed: payer and invoice caps survived restart, rejected before dispatch, and exact UTC rollover remains deterministic in the journal tests."
}

smoke_stale_chain_header() {
  ensure_runtime_env
  start_lab >/dev/null
  local stale_container="treeswap-regtest-stale-payer"
  local height_before height_after info
  local invoice payment_request payment_hash invoice_digest intent_digest request_id operation envelope result decode_result
  local baseline_id baseline_operation baseline_envelope baseline_result

  trap 'docker rm -f "${stale_container:-treeswap-regtest-stale-payer}" >/dev/null 2>&1 || true' EXIT
  docker rm -f "$stale_container" >/dev/null 2>&1 || true

  info=$(compose exec -T alice lncli --network=regtest getinfo)
  jq -e '.synced_to_chain == true and .wallet_synced == true and (.best_header_timestamp | tonumber) > 0' \
    <<<"$info" >/dev/null
  height_before=$(jq -er '.block_height | tonumber' <<<"$info")

  compose --profile adapter run --rm -d --name "$stale_container" \
    -e MAX_CHAIN_NO_PROGRESS_SECONDS=1 \
    -e ADAPTER_JOURNAL_PATH=/tmp/stale-actions.jsonl \
    payer-adapter >/dev/null
  for _ in $(seq 1 60); do
    if docker exec "$stale_container" node -e \
      'fetch("http://127.0.0.1:3000/healthz").then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))' \
      >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
  if ! docker exec "$stale_container" node -e \
    'fetch("http://127.0.0.1:3000/healthz").then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))' \
    >/dev/null 2>&1; then
    echo "disposable stale-header adapter did not become ready" >&2
    return 1
  fi

  invoice=$(compose exec -T bob lncli --network=regtest addinvoice \
    --amt=10000 --memo=treeswap-stale-header --expiry=600 --private)
  payment_request=$(jq -er '.payment_request' <<<"$invoice")
  payment_hash=$(compose exec -T alice lncli --network=regtest \
    --macaroonpath=/root/.lnd/treeswap/payer.macaroon decodepayreq "$payment_request" |
    jq -er '.payment_hash | ascii_downcase | "0x" + .')
  invoice_digest="0x$(printf '%s' "$payment_request" | openssl dgst -sha256 -binary | xxd -p -c 256)"
  intent_digest="0x$(openssl rand -hex 32)"
  baseline_id="0x$(openssl rand -hex 32)"
  baseline_operation=$(jq -cn --arg paymentRequest "$payment_request" '{paymentRequest:$paymentRequest}')
  baseline_envelope=$(sign_adapter_authorization /lnrpc.Lightning/DecodePayReq \
    "$baseline_id" "$intent_digest" "$payment_hash" "$invoice_digest" 10000 "$baseline_operation")
  baseline_result=$(printf '%s\n' "$baseline_envelope" |
    docker exec -i "$stale_container" node /app/infra/lightning-adapter/client.mjs)
  jq -e --arg paymentHash "$payment_hash" \
    '.result.paymentHash == $paymentHash and .result.amountSats == "10000"' <<<"$baseline_result" >/dev/null

  sleep 3
  info=$(compose exec -T alice lncli --network=regtest getinfo)
  height_after=$(jq -er '.block_height | tonumber' <<<"$info")
  if (( height_after != height_before )); then
    echo "regtest advanced during the deliberate no-block interval" >&2
    return 1
  fi

  request_id="0x$(openssl rand -hex 32)"
  operation=$(jq -cn --arg paymentRequest "$payment_request" \
    '{paymentRequest:$paymentRequest,timeoutSeconds:30,feeLimitSats:"10"}')
  envelope=$(sign_adapter_authorization /routerrpc.Router/SendPaymentV2 \
    "$request_id" "$intent_digest" "$payment_hash" "$invoice_digest" 10000 "$operation")
  if result=$(printf '%s\n' "$envelope" |
    docker exec -i "$stale_container" node /app/infra/lightning-adapter/client.mjs); then
    echo "stale-header adapter dispatched a new payment" >&2
    return 1
  fi
  if ! jq -e '.ambiguous == false and (.error | test("chain made no observed progress"))' <<<"$result" >/dev/null; then
    echo "stale-header adapter failed for an unexpected reason" >&2
    jq -c '{error,errorCode,ambiguous}' <<<"$result" >&2
    return 1
  fi

  assert_adapter_payment_not_found "$intent_digest" "$payment_hash" "$invoice_digest" 10000
  request_id="0x$(openssl rand -hex 32)"
  decode_result=$(call_adapter payer-adapter /lnrpc.Lightning/DecodePayReq \
    "$request_id" "$intent_digest" "$payment_hash" "$invoice_digest" 10000 \
    "$(jq -cn --arg paymentRequest "$payment_request" '{paymentRequest:$paymentRequest}')")
  jq -e --arg paymentHash "$payment_hash" \
    '.result.paymentHash == $paymentHash and .result.amountSats == "10000"' <<<"$decode_result" >/dev/null

  docker rm -f "$stale_container" >/dev/null
  unset payment_request envelope
  trap - EXIT
  echo "Stale-chain smoke passed: no blocks advanced, the bounded stale-header adapter rejected before dispatch, and the normal pinned adapter remained healthy."
}

smoke_unsynced_chain_catchup() {
  ensure_runtime_env
  start_lab >/dev/null
  local alice_container miner_address invoice payment_request payment_hash invoice_digest intent_digest
  local request_id operation envelope unsynced_info unsynced_result decode_result

  alice_container=$(compose ps -q alice)
  if [[ -z "$alice_container" ]]; then
    echo "Alice container is not running" >&2
    return 1
  fi
  miner_address=$(compose exec -T bob lncli --network=regtest newaddress p2tr | jq -er .address)
  invoice=$(compose exec -T bob lncli --network=regtest addinvoice \
    --amt=10000 --memo=treeswap-unsynced-catchup --expiry=600 --private)
  payment_request=$(jq -er '.payment_request' <<<"$invoice")
  payment_hash=$(compose exec -T alice lncli --network=regtest \
    --macaroonpath=/root/.lnd/treeswap/payer.macaroon decodepayreq "$payment_request" |
    jq -er '.payment_hash | ascii_downcase | "0x" + .')
  invoice_digest="0x$(printf '%s' "$payment_request" | openssl dgst -sha256 -binary | xxd -p -c 256)"
  intent_digest="0x$(openssl rand -hex 32)"
  request_id="0x$(openssl rand -hex 32)"
  operation=$(jq -cn --arg paymentRequest "$payment_request" \
    '{paymentRequest:$paymentRequest,timeoutSeconds:30,feeLimitSats:"10"}')
  envelope=$(sign_adapter_authorization /routerrpc.Router/SendPaymentV2 \
    "$request_id" "$intent_digest" "$payment_hash" "$invoice_digest" 10000 "$operation")

  trap '[[ -z "${alice_container:-}" ]] || docker unpause "$alice_container" >/dev/null 2>&1 || true' EXIT
  docker pause "$alice_container" >/dev/null
  compose exec -T bitcoind bitcoin-cli -regtest \
    -rpcuser="$BITCOIND_RPC_USER" -rpcpassword="$BITCOIND_RPC_PASSWORD" \
    generatetoaddress 500 "$miner_address" >/dev/null
  docker unpause "$alice_container" >/dev/null

  unsynced_info=$(compose exec -T alice lncli --network=regtest getinfo)
  if ! jq -e '.synced_to_chain == false or .wallet_synced == false' <<<"$unsynced_info" >/dev/null; then
    echo "Alice did not enter a genuine unsynced catch-up state" >&2
    return 1
  fi
  if unsynced_result=$(printf '%s\n' "$envelope" | call_signed_adapter payer-adapter); then
    echo "payer adapter dispatched while LND was catching up" >&2
    return 1
  fi
  if ! jq -e '.ambiguous == false and (.error | test("unhealthy or unsynced|wallet is unsynced"))' \
    <<<"$unsynced_result" >/dev/null; then
    echo "unsynced-node adapter rejection was unexpected" >&2
    jq -c '{error,errorCode,ambiguous}' <<<"$unsynced_result" >&2
    return 1
  fi

  wait_for_chain_sync alice
  wait_for_active_channel alice
  assert_adapter_payment_not_found "$intent_digest" "$payment_hash" "$invoice_digest" 10000
  request_id="0x$(openssl rand -hex 32)"
  decode_result=$(call_adapter payer-adapter /lnrpc.Lightning/DecodePayReq \
    "$request_id" "$intent_digest" "$payment_hash" "$invoice_digest" 10000 \
    "$(jq -cn --arg paymentRequest "$payment_request" '{paymentRequest:$paymentRequest}')")
  jq -e --arg paymentHash "$payment_hash" \
    '.result.paymentHash == $paymentHash and .result.amountSats == "10000"' <<<"$decode_result" >/dev/null

  unset payment_request envelope
  trap - EXIT
  echo "Unsynced-node smoke passed: a real 500-block backlog forced catch-up rejection, zero dispatch, and healthy adapter recovery."
}

smoke_force_close_recovery() {
  ensure_runtime_env
  start_lab >/dev/null
  local channel_point miner_address invoice payment_request payment_hash invoice_digest intent_digest
  local request_id operation envelope force_result active_channels pending_state bob_pending_state pending_count maturity_blocks
  local decode_result recovered=false

  channel_point=$(compose exec -T alice lncli --network=regtest listchannels |
    jq -er '.channels[] | select(.active == true) | .channel_point' | head -1)
  miner_address=$(compose exec -T bob lncli --network=regtest newaddress p2tr | jq -er .address)
  invoice=$(compose exec -T bob lncli --network=regtest addinvoice \
    --amt=10000 --memo=treeswap-force-close --expiry=600 --private)
  payment_request=$(jq -er '.payment_request' <<<"$invoice")
  payment_hash=$(compose exec -T alice lncli --network=regtest \
    --macaroonpath=/root/.lnd/treeswap/payer.macaroon decodepayreq "$payment_request" |
    jq -er '.payment_hash | ascii_downcase | "0x" + .')
  invoice_digest="0x$(printf '%s' "$payment_request" | openssl dgst -sha256 -binary | xxd -p -c 256)"
  intent_digest="0x$(openssl rand -hex 32)"
  request_id="0x$(openssl rand -hex 32)"
  operation=$(jq -cn --arg paymentRequest "$payment_request" \
    '{paymentRequest:$paymentRequest,timeoutSeconds:30,feeLimitSats:"10"}')
  envelope=$(sign_adapter_authorization /routerrpc.Router/SendPaymentV2 \
    "$request_id" "$intent_digest" "$payment_hash" "$invoice_digest" 10000 "$operation")

  compose exec -T alice lncli --network=regtest closechannel --force \
    --chan_point "$channel_point" >/dev/null 2>&1
  active_channels=1
  pending_count=0
  for _ in $(seq 1 60); do
    active_channels=$(compose exec -T alice lncli --network=regtest listchannels 2>/dev/null |
      jq '[.channels[] | select(.active == true)] | length' || true)
    pending_state=$(compose exec -T alice lncli --network=regtest pendingchannels 2>/dev/null || true)
    pending_count=$(jq '(.waiting_close_channels | length) + (.pending_force_closing_channels | length)' \
      <<<"$pending_state" 2>/dev/null || echo 0)
    if (( active_channels == 0 && pending_count > 0 )); then
      break
    fi
    sleep 1
  done
  if (( active_channels != 0 || pending_count == 0 )); then
    echo "force-close did not remove the only active channel into a pending close" >&2
    return 1
  fi

  if force_result=$(printf '%s\n' "$envelope" | call_signed_adapter payer-adapter); then
    echo "payer adapter dispatched while its only channel was force-closing" >&2
    return 1
  fi
  if ! jq -e '.ambiguous == false and (.error | test("service is unhealthy or unsynced"))' \
    <<<"$force_result" >/dev/null; then
    echo "force-close adapter rejection was unexpected" >&2
    jq -c '{error,errorCode,ambiguous}' <<<"$force_result" >&2
    return 1
  fi

  compose exec -T bitcoind bitcoin-cli -regtest \
    -rpcuser="$BITCOIND_RPC_USER" -rpcpassword="$BITCOIND_RPC_PASSWORD" \
    generatetoaddress 6 "$miner_address" >/dev/null
  wait_for_chain_sync alice
  wait_for_chain_sync bob
  for _ in $(seq 1 60); do
    pending_state=$(compose exec -T alice lncli --network=regtest pendingchannels 2>/dev/null || true)
    if jq -e '(.pending_force_closing_channels | length) > 0' <<<"$pending_state" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
  bob_pending_state=$(compose exec -T bob lncli --network=regtest pendingchannels)
  maturity_blocks=$(jq -ern --argjson alice "$pending_state" --argjson bob "$bob_pending_state" \
    '[($alice.pending_force_closing_channels[]?.blocks_til_maturity | tonumber), ($bob.pending_force_closing_channels[]?.blocks_til_maturity | tonumber)] | max')
  if (( maturity_blocks <= 0 )); then
    echo "force-close did not expose a positive CSV maturity" >&2
    return 1
  fi
  compose exec -T bitcoind bitcoin-cli -regtest \
    -rpcuser="$BITCOIND_RPC_USER" -rpcpassword="$BITCOIND_RPC_PASSWORD" \
    generatetoaddress "$((maturity_blocks + 1))" "$miner_address" >/dev/null

  for _ in $(seq 1 30); do
    pending_state=$(compose exec -T alice lncli --network=regtest pendingchannels 2>/dev/null || true)
    bob_pending_state=$(compose exec -T bob lncli --network=regtest pendingchannels 2>/dev/null || true)
    pending_count=$(jq -rn --argjson alice "$pending_state" --argjson bob "$bob_pending_state" \
      '(($alice.waiting_close_channels | length) + ($alice.pending_force_closing_channels | length) + ($bob.waiting_close_channels | length) + ($bob.pending_force_closing_channels | length))' \
      2>/dev/null || echo 1)
    if (( pending_count == 0 )); then
      recovered=true
      break
    fi
    if jq -en --argjson alice "$pending_state" --argjson bob "$bob_pending_state" \
      'any(([$alice.pending_force_closing_channels[]?, $bob.pending_force_closing_channels[]?])[]?; (.blocks_til_maturity | tonumber) <= 0)' \
      >/dev/null 2>&1; then
      compose exec -T bitcoind bitcoin-cli -regtest \
        -rpcuser="$BITCOIND_RPC_USER" -rpcpassword="$BITCOIND_RPC_PASSWORD" \
        generatetoaddress 1 "$miner_address" >/dev/null
    fi
    sleep 1
  done
  if [[ "$recovered" != true ]]; then
    echo "force-close outputs did not mature and sweep" >&2
    return 1
  fi

  wait_for_chain_sync alice
  wait_for_chain_sync bob
  fund_private_channel
  wait_for_active_channel alice
  wait_for_active_channel bob
  assert_adapter_payment_not_found "$intent_digest" "$payment_hash" "$invoice_digest" 10000
  request_id="0x$(openssl rand -hex 32)"
  decode_result=$(call_adapter payer-adapter /lnrpc.Lightning/DecodePayReq \
    "$request_id" "$intent_digest" "$payment_hash" "$invoice_digest" 10000 \
    "$(jq -cn --arg paymentRequest "$payment_request" '{paymentRequest:$paymentRequest}')")
  jq -e --arg paymentHash "$payment_hash" \
    '.result.paymentHash == $paymentHash and .result.amountSats == "10000"' <<<"$decode_result" >/dev/null

  unset payment_request envelope
  echo "Force-close smoke passed: new exposure stopped, the CSV close fully swept, zero dispatch was proven, and a fresh balanced channel restored service."
}

smoke_route_and_duplicate_failure() {
  ensure_runtime_env
  start_lab >/dev/null
  local invoice payment_request payment_hash invoice_digest intent_digest request_id operation
  local payment_envelope result track_id track_result matching_before matching_after
  local replay_result duplicate_id duplicate_envelope duplicate_result
  local payment_hash_base64 payment_hash_url
  local charlie_channels=""

  compose up -d charlie >/dev/null
  wait_for_wallet_rpc charlie
  initialize_wallet charlie
  wait_for_chain_sync charlie
  wait_for_wallet_state charlie "SERVER_ACTIVE"
  for _ in $(seq 1 30); do
    if charlie_channels=$(compose exec -T charlie lncli --network=regtest listchannels 2>/dev/null |
      jq -er '.channels | length'); then
      break
    fi
    sleep 1
  done
  if [[ -z "$charlie_channels" ]]; then
    echo "unrouted fault node channel RPC did not become ready" >&2
    return 1
  fi
  if (( charlie_channels != 0 )); then
    echo "unrouted fault node unexpectedly has a channel" >&2
    return 1
  fi

  invoice=""
  for _ in $(seq 1 30); do
    if invoice=$(compose exec -T charlie lncli --network=regtest addinvoice \
      --amt=10000 --memo=treeswap-no-route --expiry=600 2>/dev/null); then
      break
    fi
    sleep 1
  done
  if ! payment_request=$(jq -er '.payment_request' <<<"$invoice"); then
    echo "unrouted fault node invoice RPC did not become ready" >&2
    return 1
  fi
  if ! payment_hash=$(compose exec -T alice lncli --network=regtest \
    --macaroonpath=/root/.lnd/treeswap/payer.macaroon decodepayreq "$payment_request" 2>/dev/null |
    jq -er '.payment_hash | ascii_downcase | "0x" + .'); then
    echo "payer could not decode the unrouted invoice" >&2
    return 1
  fi
  invoice_digest="0x$(printf '%s' "$payment_request" | openssl dgst -sha256 -binary | xxd -p -c 256)"
  intent_digest="0x$(openssl rand -hex 32)"
  request_id="0x$(openssl rand -hex 32)"
  operation=$(jq -cn --arg paymentRequest "$payment_request" \
    '{paymentRequest:$paymentRequest,timeoutSeconds:30,feeLimitSats:"10"}')
  payment_envelope=$(sign_adapter_authorization /routerrpc.Router/SendPaymentV2 \
    "$request_id" "$intent_digest" "$payment_hash" "$invoice_digest" 10000 "$operation")

  if ! matching_before=$(compose exec -T alice lncli --network=regtest listpayments --include_incomplete 2>/dev/null |
    jq -er --arg hash "${payment_hash#0x}" '[.payments[] | select((.payment_hash | ascii_downcase) == $hash)] | length'); then
    echo "payer payment-history observation failed before the route probe" >&2
    return 1
  fi
  if (( matching_before != 0 )); then
    echo "unrouted payment hash was not fresh" >&2
    return 1
  fi
  if result=$(printf '%s\n' "$payment_envelope" | call_signed_adapter payer-adapter); then
    echo "unrouted payment unexpectedly succeeded" >&2
    return 1
  fi
  if ! jq -e '.ambiguous == false and (.error | test("Lightning payment failed.*NO_ROUTE"))' <<<"$result" >/dev/null; then
    echo "unrouted payment failed for an unexpected reason" >&2
    jq -c '{error,errorCode,ambiguous}' <<<"$result" >&2
    return 1
  fi

  track_id="0x$(openssl rand -hex 32)"
  if track_result=$(call_adapter payer-adapter /routerrpc.Router/TrackPaymentV2 \
    "$track_id" "$intent_digest" "$payment_hash" "$invoice_digest" 10000 '{}'); then
    jq -e --arg paymentHash "$payment_hash" \
      '.result.status == "FAILED" and .result.paymentHash == $paymentHash and .result.amountSats == "10000"' \
      <<<"$track_result" >/dev/null
  else
    if ! jq -e '.errorCode == "NOT_FOUND" and .ambiguous == false' <<<"$track_result" >/dev/null; then
      echo "read-only tracking returned an unsafe no-route observation" >&2
      jq -c '{error,errorCode,ambiguous}' <<<"$track_result" >&2 || true
      return 1
    fi
    payment_hash_base64=$(printf '%s' "${payment_hash#0x}" | xxd -r -p | openssl base64 -A)
    payment_hash_url=$(jq -nr --arg value "$payment_hash_base64" '$value | @uri')
    if [[ "$track_result" == *"${payment_hash#0x}"* ||
      "$track_result" == *"$payment_hash_base64"* || "$track_result" == *"$payment_hash_url"* ]]; then
      echo "no-route tracking error exposed its bound payment hash" >&2
      return 1
    fi
  fi

  if replay_result=$(printf '%s\n' "$payment_envelope" | call_signed_adapter payer-adapter); then
    echo "failed payment authorization was replayed" >&2
    return 1
  fi
  jq -e '.error | test("request identifier was already used")' <<<"$replay_result" >/dev/null

  duplicate_id="0x$(openssl rand -hex 32)"
  duplicate_envelope=$(sign_adapter_authorization /routerrpc.Router/SendPaymentV2 \
    "$duplicate_id" "$intent_digest" "$payment_hash" "$invoice_digest" 10000 "$operation")
  if duplicate_result=$(printf '%s\n' "$duplicate_envelope" | call_signed_adapter payer-adapter); then
    echo "failed payment hash opened a second Lightning exposure" >&2
    return 1
  fi
  jq -e '.error | test("payment hash was already used for Lightning exposure")' <<<"$duplicate_result" >/dev/null

  matching_after=""
  for _ in $(seq 1 30); do
    if matching_after=$(compose exec -T alice lncli --network=regtest listpayments --include_incomplete 2>/dev/null |
      jq -er --arg hash "${payment_hash#0x}" '[.payments[] | select((.payment_hash | ascii_downcase) == $hash)] | length') &&
      (( matching_after == 1 )); then
      break
    fi
    sleep 1
  done
  if [[ -z "$matching_after" ]]; then
    echo "payer payment-history observation failed after duplicate rejection" >&2
    return 1
  fi
  if (( matching_after != 1 )); then
    echo "duplicate rejection did not preserve exactly one LND payment record" >&2
    return 1
  fi
  unset payment_request payment_envelope duplicate_envelope
  echo "Route and duplicate fault smoke passed: one unrouted dispatch failed, tracking stayed fail-closed, and both replay paths were rejected without a second LND payment."
}

smoke_htlc_cutoff() {
  ensure_runtime_env
  start_lab >/dev/null
  local amount_sats=10000
  local safety_blocks=24
  local preimage payment_hash intent_digest create_id create_result payment_request invoice_digest
  local payment_id payment_envelope payment_result="" payment_pid=""
  local lookup_id lookup_result state accepted expiry_height current_height remaining_blocks
  local blocks_to_mine miner_address target_height settle_id settle_result cancel_id cancel_result
  local boundary_outcome

  trap '[[ -z "${payment_hash:-}" ]] || compose exec -T bob lncli --network=regtest cancelinvoice "${payment_hash#0x}" >/dev/null 2>&1 || true; \
    [[ -z "${payment_pid:-}" ]] || kill "$payment_pid" 2>/dev/null || true; \
    [[ -z "${payment_result:-}" ]] || rm -f "$payment_result"' EXIT

  preimage="0x$(openssl rand -hex 32)"
  payment_hash="0x$(printf '%s' "${preimage#0x}" | xxd -r -p |
    openssl dgst -sha256 -binary | xxd -p -c 256)"
  intent_digest="0x$(openssl rand -hex 32)"
  create_id="0x$(openssl rand -hex 32)"
  create_result=$(call_adapter invoice-adapter /invoicesrpc.Invoices/AddHoldInvoice \
    "$create_id" "$intent_digest" "$payment_hash" \
    "0x$(printf '00%.0s' {1..32})" "$amount_sats" \
    "$(jq -cn '{memo:"treeswap-cltv-cutoff",expirySeconds:600,cltvExpiry:80,isPrivate:true}')")
  payment_request=$(jq -er '.result.paymentRequest' <<<"$create_result")
  invoice_digest=$(jq -er '.result.invoiceDigest' <<<"$create_result")
  payment_id="0x$(openssl rand -hex 32)"
  payment_envelope=$(sign_adapter_authorization /routerrpc.Router/SendPaymentV2 \
    "$payment_id" "$intent_digest" "$payment_hash" "$invoice_digest" "$amount_sats" \
    "$(jq -cn --arg paymentRequest "$payment_request" \
      '{paymentRequest:$paymentRequest,timeoutSeconds:30,feeLimitSats:"10"}')")
  umask 077
  payment_result=$(mktemp "$STATE_DIR/htlc-cutoff-payment.XXXXXX")
  printf '%s\n' "$payment_envelope" | call_signed_adapter payer-adapter >"$payment_result" &
  payment_pid=$!

  accepted=false
  for _ in $(seq 1 30); do
    lookup_id="0x$(openssl rand -hex 32)"
    lookup_result=$(call_adapter invoice-adapter /invoicesrpc.Invoices/LookupInvoiceV2 \
      "$lookup_id" "$intent_digest" "$payment_hash" "$invoice_digest" "$amount_sats" '{}')
    state=$(jq -er '.result.state' <<<"$lookup_result")
    if [[ "$state" == "ACCEPTED" ]]; then
      accepted=true
      break
    fi
    sleep 1
  done
  if [[ "$accepted" != true ]]; then
    echo "CLTV cutoff probe was not accepted" >&2
    return 1
  fi
  expiry_height=$(jq -er '[.result.htlcs[] | select(.state == "ACCEPTED") | .expiryHeight] | min' \
    <<<"$lookup_result")
  current_height=$(compose exec -T bob lncli --network=regtest getinfo |
    jq -er '.block_height | tonumber')
  remaining_blocks=$((expiry_height - current_height))
  if (( remaining_blocks <= safety_blocks )); then
    echo "accepted HTLC began inside the configured settlement safety margin" >&2
    return 1
  fi
  echo "HTLC cutoff stage passed: accepted outside the settlement reserve."
  blocks_to_mine=$((remaining_blocks - safety_blocks))
  miner_address=$(compose exec -T alice lncli --network=regtest newaddress p2tr | jq -er '.address')
  compose exec -T bitcoind bitcoin-cli -regtest \
    -rpcuser="$BITCOIND_RPC_USER" -rpcpassword="$BITCOIND_RPC_PASSWORD" \
    generatetoaddress "$blocks_to_mine" "$miner_address" >/dev/null
  target_height=$((current_height + blocks_to_mine))
  wait_for_block_height alice "$target_height"
  wait_for_block_height bob "$target_height"
  wait_for_chain_sync alice
  wait_for_chain_sync bob
  echo "HTLC cutoff stage passed: both LND nodes reached the rapid-block target."

  lookup_id="0x$(openssl rand -hex 32)"
  if ! lookup_result=$(call_adapter invoice-adapter /invoicesrpc.Invoices/LookupInvoiceV2 \
    "$lookup_id" "$intent_digest" "$payment_hash" "$invoice_digest" "$amount_sats" '{}'); then
    echo "invoice lookup failed after rapid block advancement" >&2
    jq -c '{error,errorCode,ambiguous}' <<<"$lookup_result" >&2
    return 1
  fi
  state=$(jq -er '.result.state' <<<"$lookup_result")
  if [[ "$state" == "ACCEPTED" ]]; then
    expiry_height=$(jq -er '[.result.htlcs[] | select(.state == "ACCEPTED") | .expiryHeight] | min' \
      <<<"$lookup_result")
    current_height=$(compose exec -T bob lncli --network=regtest getinfo |
      jq -er '.block_height | tonumber')
    remaining_blocks=$((expiry_height - current_height))
    if (( remaining_blocks > safety_blocks )); then
      echo "fast-block campaign did not reach the exact settlement safety boundary" >&2
      return 1
    fi
    boundary_outcome=adapter-cutoff
  elif [[ "$state" == "CANCELED" ]]; then
    if ! jq -e '(.result.htlcs | length) > 0 and ([.result.htlcs[] | select(.state != "CANCELED")] | length == 0)' \
      <<<"$lookup_result" >/dev/null; then
      echo "LND canceled the invoice but left a non-canceled HTLC at the safety boundary" >&2
      return 1
    fi
    boundary_outcome=lnd-auto-cancel
  else
    echo "hold invoice reached an unexpected state at the settlement safety boundary" >&2
    return 1
  fi

  settle_id="0x$(openssl rand -hex 32)"
  if settle_result=$(call_adapter invoice-adapter /invoicesrpc.Invoices/SettleInvoice \
    "$settle_id" "$intent_digest" "$payment_hash" "$invoice_digest" "$amount_sats" \
    "$(jq -cn --arg preimage "$preimage" '{preimage:$preimage}')"); then
    echo "invoice adapter settled an HTLC inside its block-safety margin" >&2
    return 1
  fi
  if [[ "$boundary_outcome" == "adapter-cutoff" ]]; then
    if ! jq -e '.error | test("inside the settlement safety margin")' <<<"$settle_result" >/dev/null; then
      echo "CLTV cutoff settlement failed for an unexpected reason" >&2
      jq -c '{error,errorCode,ambiguous}' <<<"$settle_result" >&2
      return 1
    fi
  elif ! jq -e '.error | test("not accepted")' <<<"$settle_result" >/dev/null; then
    echo "CLTV cutoff settlement failed for an unexpected reason" >&2
    jq -c '{error,errorCode,ambiguous}' <<<"$settle_result" >&2
    return 1
  fi

  if [[ "$boundary_outcome" == "adapter-cutoff" ]]; then
    cancel_id="0x$(openssl rand -hex 32)"
    cancel_result=$(call_adapter invoice-adapter /invoicesrpc.Invoices/CancelInvoice \
      "$cancel_id" "$intent_digest" "$payment_hash" "$invoice_digest" "$amount_sats" '{}')
    jq -e '.result.state == "CANCELED"' <<<"$cancel_result" >/dev/null
  fi
  payment_hash=""
  if wait "$payment_pid"; then
    payment_pid=""
    echo "payer succeeded after the near-cutoff hold was canceled" >&2
    return 1
  fi
  payment_pid=""
  jq -e '.error | test("Lightning payment failed")' "$payment_result" >/dev/null
  rm -f "$payment_result"
  payment_result=""
  unset preimage payment_request payment_envelope
  trap - EXIT

  echo "HTLC cutoff smoke passed: rapid blocks reached the 24-block reserve, settlement failed closed ($boundary_outcome), and the payer was released."
}

smoke_coordinator_reconciliation() {
  ensure_runtime_env
  start_lab >/dev/null
  local invoice payment_request payment_hash input
  compose --profile tools build coordinator-smoke >/dev/null
  invoice=$(compose exec -T bob lncli --network=regtest addinvoice \
    --amt=10000 --memo=treeswap-coordinator-regtest --expiry=600 --private)
  payment_request=$(jq -er '.payment_request' <<<"$invoice")
  payment_hash=$(compose exec -T alice lncli --network=regtest \
    --macaroonpath=/root/.lnd/treeswap/payer.macaroon decodepayreq "$payment_request" |
    jq -er '.payment_hash | ascii_downcase | "0x" + .')
  input=$(jq -cn --arg amountSats 10000 --arg paymentRequest "$payment_request" \
    '{amountSats:$amountSats,paymentRequest:$paymentRequest}')
  COORDINATOR_SMOKE_PAYMENT_HASH="$payment_hash" compose --profile adapter --profile tools run --rm -T \
    coordinator-smoke <<<"$input"
  unset invoice payment_request input
}

smoke_coordinator_invoice_reconciliation() {
  ensure_runtime_env
  start_lab >/dev/null
  local amount_sats=10000
  local preimage payment_hash invoice payment_request invoice_digest state accepted
  local payment_result="" payment_pid="" input
  trap '[[ -z "${payment_hash:-}" ]] || compose exec -T bob lncli --network=regtest cancelinvoice "${payment_hash#0x}" >/dev/null 2>&1 || true; \
    [[ -z "${payment_pid:-}" ]] || kill "$payment_pid" 2>/dev/null || true; \
    [[ -z "${payment_result:-}" ]] || rm -f "$payment_result"' EXIT

  preimage="0x$(openssl rand -hex 32)"
  payment_hash="0x$(printf '%s' "${preimage#0x}" | xxd -r -p |
    openssl dgst -sha256 -binary | xxd -p -c 256)"
  invoice=$(compose exec -T bob lncli --network=regtest \
    --macaroonpath=/root/.lnd/treeswap/invoice.macaroon addholdinvoice \
    --memo=treeswap-coordinator-invoice-regtest --expiry=600 --cltv_expiry_delta=80 --private \
    "${payment_hash#0x}" "$amount_sats")
  payment_request=$(jq -er '.payment_request' <<<"$invoice")
  invoice_digest="0x$(printf '%s' "$payment_request" | openssl dgst -sha256 -binary | xxd -p -c 256)"
  umask 077
  payment_result=$(mktemp "$STATE_DIR/coordinator-invoice-payment.XXXXXX")
  compose exec -T alice lncli --network=regtest \
    --macaroonpath=/root/.lnd/treeswap/payer.macaroon payinvoice \
    --force --fee_limit=10 --timeout=30s --json "$payment_request" >"$payment_result" &
  payment_pid=$!

  accepted=false
  for _ in $(seq 1 30); do
    state=$(compose exec -T bob lncli --network=regtest lookupinvoice "${payment_hash#0x}" |
      jq -er '.state')
    if [[ "$state" == "ACCEPTED" ]]; then
      accepted=true
      break
    fi
    sleep 1
  done
  if [[ "$accepted" != true ]]; then
    echo "coordinator invoice probe was not accepted" >&2
    return 1
  fi

  input=$(jq -cn --arg amountSats "$amount_sats" --arg invoiceDigest "$invoice_digest" \
    --arg preimage "$preimage" \
    '{amountSats:$amountSats,invoiceDigest:$invoiceDigest,preimage:$preimage}')
  compose --profile tools build coordinator-invoice-smoke >/dev/null
  COORDINATOR_SMOKE_PAYMENT_HASH="$payment_hash" compose --profile adapter --profile tools run --rm -T \
    coordinator-invoice-smoke <<<"$input"
  payment_hash=""
  wait "$payment_pid"
  payment_pid=""
  jq -e --arg preimage "$preimage" \
    '.status == "SUCCEEDED" and ("0x" + (.payment_preimage | ascii_downcase)) == $preimage' \
    "$payment_result" >/dev/null
  rm -f "$payment_result"
  payment_result=""
  unset preimage payment_request input
  trap - EXIT
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
  compose --profile adapter --profile tools down
}

destroy_lab() {
  ensure_runtime_env
  compose --profile adapter --profile tools down --volumes
  echo "Regtest containers and Docker volumes removed. Runtime credentials remain in $ENV_FILE."
}

case "${1:-}" in
  up) start_lab ;;
  smoke) smoke_hold_invoice ;;
  adapter-smoke) smoke_adapter_hold_invoice ;;
  credential-smoke) smoke_credential_lifecycle ;;
  credential-rotation-smoke) smoke_credential_rotation ;;
  invoice-fault-smoke) smoke_invoice_faults ;;
  policy-fault-smoke) smoke_policy_faults ;;
  directional-capacity-smoke) smoke_directional_capacity ;;
  daily-cap-smoke) smoke_daily_cap ;;
  stale-chain-smoke) smoke_stale_chain_header ;;
  unsynced-chain-smoke) smoke_unsynced_chain_catchup ;;
  force-close-smoke) smoke_force_close_recovery ;;
  route-fault-smoke) smoke_route_and_duplicate_failure ;;
  htlc-cutoff-smoke) smoke_htlc_cutoff ;;
  coordinator-smoke) smoke_coordinator_reconciliation ;;
  coordinator-invoice-smoke) smoke_coordinator_invoice_reconciliation ;;
  status) status_lab ;;
  down) stop_lab ;;
  destroy) destroy_lab ;;
  *)
    echo "Usage: $0 {up|smoke|adapter-smoke|credential-smoke|credential-rotation-smoke|invoice-fault-smoke|policy-fault-smoke|directional-capacity-smoke|daily-cap-smoke|stale-chain-smoke|unsynced-chain-smoke|force-close-smoke|route-fault-smoke|htlc-cutoff-smoke|coordinator-smoke|coordinator-invoice-smoke|status|down|destroy}" >&2
    exit 2
    ;;
esac
