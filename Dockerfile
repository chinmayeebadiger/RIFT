FROM node:20.11.1-bookworm-slim@sha256:357deca6eb61149534d32faaf5e4b2e4fa3549c2be610ee1019bf340ea8c51ec AS build

ENV NEXT_TELEMETRY_DISABLED=1

RUN apt-get update \
    && apt-get install --yes --no-install-recommends python3 make \
    && apt-get upgrade --yes \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .

RUN npm --prefix apps/web ci \
    && npm --prefix services/api ci \
    && npm --prefix demo ci \
    && npm --prefix apps/web run build \
    && npm --prefix services/api run build \
    && npm --prefix demo run build \
    && npm --prefix demo test -- --run src/domain/shop.test.ts src/server.test.ts \
    && python3 -m unittest discover -s tests -p 'test_*.py' -v \
    && npm --prefix apps/web prune --omit=dev \
    && npm --prefix services/api prune --omit=dev \
    && npm --prefix demo prune --omit=dev

FROM node:20.11.1-bookworm-slim@sha256:357deca6eb61149534d32faaf5e4b2e4fa3549c2be610ee1019bf340ea8c51ec AS runtime

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    RIFT_SERVICE=api \
    RIFT_HOST=0.0.0.0

WORKDIR /app

RUN groupadd --system --gid 10001 rift \
    && useradd --system --uid 10001 --gid rift --home-dir /nonexistent --shell /usr/sbin/nologin rift

RUN apt-get update \
    && apt-get upgrade --yes \
    && rm -rf /var/lib/apt/lists/* \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

COPY --from=build --chown=rift:rift /app/apps/web ./apps/web
COPY --from=build --chown=rift:rift /app/services/api ./services/api
COPY --from=build --chown=rift:rift /app/demo ./demo
COPY --from=build --chown=rift:rift /app/packages/core ./packages/core

USER rift

EXPOSE 3000 4000 4173

CMD ["sh", "-c", "if [ \"$RIFT_SERVICE\" = \"web\" ]; then /app/apps/web/node_modules/.bin/next start; elif [ \"$RIFT_SERVICE\" = \"demo\" ]; then node /app/demo/dist/server.js; else node /app/services/api/dist/server.js; fi"]
