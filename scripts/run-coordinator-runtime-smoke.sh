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
  --test tests/admission-store.test.mjs tests/coordinator-store.test.mjs \
    tests/coordinator-action-runner.test.mjs tests/evm-action-runner.test.mjs \
    tests/solver-capability.test.mjs \
    tests/solver-daemon-planner.test.mjs tests/solver-daemon-runtime.test.mjs \
    tests/solver-endpoint-transport.test.mjs tests/solver-private-packet.test.mjs
docker run --rm --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --tmpfs /data:rw,noexec,nosuid,size=512k,mode=0700,uid=1000,gid=1000 \
  --entrypoint node \
  "$runtime_image" \
  infra/coordinator/disk-full-smoke.mjs
