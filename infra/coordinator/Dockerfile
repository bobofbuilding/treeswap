FROM node:22.23.4-alpine@sha256:ce8d97f7cfc7c5386421eb932df20a29df99b1a7f469f6157d5c9956702ffadc

# Require the incident distrust update in the OS store as well as Node.
RUN apk add --no-cache --upgrade 'ca-certificates>=20261020-r0'

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
  && node -e "Promise.all([import('./lib/evm-action-runner.mjs'), import('./lib/contract-intent-wallet.mjs'), import('./lib/contract-intent-wallet-store.mjs'), import('./lib/contract-intent-wallet-dispatcher.mjs'), import('./lib/contract-intent-wallet-gateway.mjs'), import('./lib/contract-intent-wallet-ownership.mjs'), import('./lib/contract-intent-wallet-abuse-store.mjs'), import('./lib/contract-intent-wallet-session-reader.mjs'), import('./lib/contract-intent-wallet-siwe-edge.mjs'), import('./lib/contract-intent-wallet-edge-perimeter.mjs'), import('./lib/solver-daemon-evidence-provider.mjs'), import('./lib/solver-private-packet-provider.mjs'), import('./lib/solver-contract-signing-transport.mjs'), import('./lib/solver-contract-signing-provider.mjs'), import('./lib/rfq-delivery-service.mjs'), import('./lib/blind-quote-preview.mjs'), import('./lib/rfq-quote-ingress-store.mjs'), import('./lib/rfq-quote-ingress-reader.mjs'), import('./lib/rfq-selection-reservation.mjs'), import('./lib/rfq-finalization-restart-policy.mjs'), import('./lib/rfq-private-ceremony.mjs'), import('./lib/rfq-quote-ingress.mjs'), import('./lib/coordinator-active-operator-policy.mjs'), import('./lib/coordinator-active-execution-policy.mjs'), import('./lib/coordinator-active-execution-lifecycle.mjs'), import('./lib/coordinator-active-execution-supervisor.mjs'), import('./lib/coordinator-active-execution-service.mjs'), import('./lib/coordinator-recovery-execution-supervisor.mjs'), import('./lib/coordinator-recovery-execution-service.mjs'), import('./lib/coordinator-recovery-operator-policy.mjs')])"

ENV COORDINATOR_MODE=closed \
  COORDINATOR_DATABASE_PATH=/data/coordinator.sqlite \
  COORDINATOR_RUNTIME_DIRECTORY=/run/treeswap/state

USER node
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=4 \
  CMD ["node", "infra/coordinator/healthcheck.mjs"]
CMD ["node", "infra/coordinator/service.mjs"]
