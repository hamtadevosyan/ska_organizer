FROM node:24-bookworm-slim AS dependencies
WORKDIR /app/server
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app/server
COPY --from=dependencies /app/server/node_modules ./node_modules
COPY server/ ./
USER node
EXPOSE 3001
# Migrations are an explicit, backed-up release step, not a side effect of restart.
CMD ["node", "index.js"]
