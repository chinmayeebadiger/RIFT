FROM node:20.11.1-bookworm-slim AS build

ENV NEXT_TELEMETRY_DISABLED=1

RUN apt-get update \
    && apt-get install --yes --no-install-recommends python3 make \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .

RUN npm --prefix apps/web ci \
    && npm --prefix services/api ci \
    && npm --prefix apps/web run build \
    && npm --prefix services/api run build \
    && python3 -m unittest discover -s tests -p 'test_*.py' -v

FROM node:20.11.1-bookworm-slim AS runtime

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    RIFT_SERVICE=api

WORKDIR /app
COPY --from=build /app/apps/web ./apps/web
COPY --from=build /app/services/api ./services/api

EXPOSE 3000 4000

CMD ["sh", "-c", "if [ \"$RIFT_SERVICE\" = \"web\" ]; then npm --prefix apps/web run start; else npm --prefix services/api run start; fi"]
