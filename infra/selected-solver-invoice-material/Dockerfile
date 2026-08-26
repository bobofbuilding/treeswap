FROM node:22.22.0-alpine@sha256:e4bf2a82ad0a4037d28035ae71529873c069b13eb0455466ae0bc13363826e34

WORKDIR /app
COPY lib ./lib
COPY infra/selected-solver-invoice-material ./infra/selected-solver-invoice-material

USER node
CMD ["node", "infra/selected-solver-invoice-material/smoke.mjs"]
