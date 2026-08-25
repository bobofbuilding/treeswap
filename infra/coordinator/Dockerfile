FROM node:22.22.0-alpine@sha256:e4bf2a82ad0a4037d28035ae71529873c069b13eb0455466ae0bc13363826e34

WORKDIR /app
COPY infra/coordinator/runtime/package.json infra/coordinator/runtime/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
  && npm cache clean --force
COPY lib ./lib
COPY scripts/verify-retained-release-custody.mjs ./scripts/verify-retained-release-custody.mjs
COPY infra/coordinator ./infra/coordinator
COPY infra/lightning-adapter/capacity-smoke.mjs ./infra/lightning-adapter/capacity-smoke.mjs
RUN mkdir -p /data /run/treeswap/credentials /run/treeswap/state \
  && chown node:node /data /run/treeswap/credentials /run/treeswap/state \
  && node --check infra/coordinator/supervision-status.mjs \
  && node -e "Promise.all([import('./lib/evm-action-runner.mjs'), import('./lib/coordinator-active-execution-policy.mjs'), import('./lib/coordinator-active-execution-lifecycle.mjs'), import('./lib/coordinator-active-execution-supervisor.mjs'), import('./lib/coordinator-active-execution-service.mjs'), import('./lib/coordinator-recovery-execution-supervisor.mjs'), import('./lib/coordinator-recovery-execution-service.mjs')])"

ENV COORDINATOR_MODE=closed \
  COORDINATOR_DATABASE_PATH=/data/coordinator.sqlite \
  COORDINATOR_RUNTIME_DIRECTORY=/run/treeswap/state

USER node
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=4 \
  CMD ["node", "infra/coordinator/healthcheck.mjs"]
CMD ["node", "infra/coordinator/service.mjs"]
