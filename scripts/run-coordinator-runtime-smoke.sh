#!/usr/bin/env bash
set -euo pipefail

project_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
runtime_image="treeswap/coordinator:runtime-recovery"

cd "$project_root"
docker build --file infra/coordinator/Dockerfile --tag "$runtime_image" .
docker run --rm --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --mount type=bind,src="$project_root/tests",dst=/app/tests,readonly \
  --entrypoint node \
  "$runtime_image" \
  --test tests/admission-store.test.mjs tests/coordinator-store.test.mjs tests/coordinator-service-state.test.mjs \
    tests/coordinator-action-runner.test.mjs tests/evm-action-runner.test.mjs \
    tests/deployment-observer.test.mjs tests/deployment-policy.test.mjs \
    tests/safety-monitor.test.mjs tests/solver-capability.test.mjs \
    tests/solver-daemon-planner.test.mjs tests/solver-daemon-runtime.test.mjs \
    tests/solver-endpoint-transport.test.mjs tests/solver-private-packet.test.mjs
docker run --rm --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --tmpfs /data:rw,noexec,nosuid,size=512k,mode=0700,uid=1000,gid=1000 \
  --entrypoint node \
  "$runtime_image" \
  infra/coordinator/disk-full-smoke.mjs

closed_container=$(docker run --detach --read-only \
  --tmpfs /data:rw,noexec,nosuid,size=16m,mode=0700,uid=1000,gid=1000 \
  --tmpfs /run/treeswap/state:rw,noexec,nosuid,size=1m,mode=0700,uid=1000,gid=1000 \
  "$runtime_image")
cleanup_closed_container() {
  docker rm --force "$closed_container" >/dev/null 2>&1 || true
}
trap cleanup_closed_container EXIT
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if docker logs "$closed_container" 2>&1 | grep -q 'ready-closed-no-funding-authority'; then
    break
  fi
  if [ "$(docker inspect --format '{{.State.Running}}' "$closed_container")" != "true" ]; then
    docker logs "$closed_container"
    exit 1
  fi
  sleep 1
done
docker logs "$closed_container" 2>&1 | grep -q 'ready-closed-no-funding-authority'
docker exec "$closed_container" node infra/coordinator/healthcheck.mjs \
  | grep -q '"fundingAuthorization":false'
docker stop --time 10 "$closed_container" >/dev/null
trap - EXIT
