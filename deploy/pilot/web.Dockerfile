FROM node:24-bookworm-slim AS build
WORKDIR /app/client
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client/ ./
# API callers already append /api. A root base yields same-origin requests.
ENV VITE_API_BASE_URL=/
RUN npm run build

FROM caddy:2-alpine
RUN apk add --no-cache curl
COPY deploy/pilot/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/client/dist /srv
EXPOSE 8443
