FROM node:22.22.0-alpine@sha256:e4bf2a82ad0a4037d28035ae71529873c069b13eb0455466ae0bc13363826e34

WORKDIR /app
COPY lib ./lib
COPY infra/lightning-adapter ./infra/lightning-adapter
RUN mkdir -p /data && chown node:node /data

USER node
EXPOSE 3000
CMD ["node", "infra/lightning-adapter/server.mjs"]
