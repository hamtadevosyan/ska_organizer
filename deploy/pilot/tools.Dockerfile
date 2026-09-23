FROM node:24-bookworm-slim AS dependencies
WORKDIR /app/server
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

# The dump/restore client has the same major version as the pilot PostgreSQL server.
FROM postgres:17-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=dependencies /usr/local/bin/node /usr/local/bin/node
WORKDIR /app/server
COPY --from=dependencies /app/server/node_modules ./node_modules
COPY server/operations/ ./operations/
ENTRYPOINT ["node", "operations/pilot-data.js"]
CMD ["help"]
