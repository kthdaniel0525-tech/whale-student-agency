FROM node:24.20.0-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates libgomp1 \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json .npmrc ./
COPY vendor ./vendor
RUN npm ci --include=dev --include=optional --no-audit --no-fund
COPY . .
# No runtime secret or database connection is needed to build the artifact.
RUN npm run build -- --webpack

FROM node:24.20.0-bookworm-slim AS runtime
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates libgomp1 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=node:node /app /app
ARG RELEASE_SHA=development
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 RELEASE_SHA=$RELEASE_SHA
# The release script checks the immutable target image before replacing roles.
LABEL io.student-agency.access-policy="beta-v1"
USER node
EXPOSE 3000
ENTRYPOINT ["node", "--env-file=/run/secrets/runtime.env", "scripts/container-entry.mjs"]
CMD ["web"]
