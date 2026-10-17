FROM node:20.11.1-bookworm-slim AS build

ENV NEXT_TELEMETRY_DISABLED=1

RUN apt-get update \
    && apt-get install --yes --no-install-recommends python3 make \
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
    && python3 -m unittest discover -s tests -p 'test_*.py' -v

FROM node:20.11.1-bookworm-slim AS runtime

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    RIFT_SERVICE=api

WORKDIR /app
COPY --from=build /app/apps/web ./apps/web
COPY --from=build /app/services/api ./services/api
COPY --from=build /app/demo ./demo

EXPOSE 3000 4000 4173

CMD ["sh", "-c", "if [ \"$RIFT_SERVICE\" = \"web\" ]; then npm --prefix apps/web run start; elif [ \"$RIFT_SERVICE\" = \"demo\" ]; then npm --prefix demo run start; else npm --prefix services/api run start; fi"]
