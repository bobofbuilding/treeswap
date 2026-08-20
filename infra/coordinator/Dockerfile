FROM node:22.22.0-alpine@sha256:e4bf2a82ad0a4037d28035ae71529873c069b13eb0455466ae0bc13363826e34

WORKDIR /app
COPY infra/coordinator/runtime/package.json infra/coordinator/runtime/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
  && npm cache clean --force
COPY lib ./lib
COPY infra/coordinator ./infra/coordinator
COPY infra/lightning-adapter/capacity-smoke.mjs ./infra/lightning-adapter/capacity-smoke.mjs
RUN mkdir -p /data /run/treeswap/credentials \
  && chown node:node /data /run/treeswap/credentials \
  && node -e "import('./lib/evm-action-runner.mjs')"

USER node
CMD ["node", "infra/coordinator/smoke.mjs"]
