FROM node:24-bookworm-slim AS build
WORKDIR /app/client
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client/ ./
# API callers already append /api. A root base yields same-origin requests.
ENV VITE_API_BASE_URL=/
RUN npm run build

FROM caddy:2-alpine
# The upstream binary can carry CAP_NET_BIND_SERVICE, which conflicts with
# cap_drop: ALL on some runtimes. Port 8443 does not require that capability.
# https://github.com/caddyserver/caddy-docker/issues/396
RUN apk add --no-cache curl libcap \
    && if [ -n "$(getcap /usr/bin/caddy)" ]; then setcap -r /usr/bin/caddy; fi
COPY deploy/pilot/Caddyfile /etc/caddy/Caddyfile
COPY deploy/pilot/web-healthcheck.sh /usr/local/bin/skao-web-healthcheck
RUN chmod 0555 /usr/local/bin/skao-web-healthcheck
COPY --from=build /app/client/dist /srv
EXPOSE 8443
