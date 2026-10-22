FROM node:22.23.4-alpine@sha256:ce8d97f7cfc7c5386421eb932df20a29df99b1a7f469f6157d5c9956702ffadc

# Require the incident distrust update in the OS store as well as Node.
RUN apk add --no-cache --upgrade 'ca-certificates>=20261020-r0'

WORKDIR /app
COPY lib ./lib
COPY infra/selected-solver-invoice-material ./infra/selected-solver-invoice-material

USER node
CMD ["node", "infra/selected-solver-invoice-material/smoke.mjs"]
