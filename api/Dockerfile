# syntax=docker/dockerfile:1.7

# ─── Build the API ───
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build \
 && cp src/db/schema.sql dist/db/schema.sql

# ─── Production deps only ───
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# ─── Clone + install Sentinel SDK ───
# The API imports from a hardcoded relative path that resolves to /Sentinel SDK/js-sdk.
# Pin SDK_REF to a commit SHA or tag for reproducible builds.
FROM node:22-alpine AS sdk
RUN apk add --no-cache git
ARG SDK_REF=
RUN if [ -n "$SDK_REF" ]; then \
      git clone --depth 1 --branch "$SDK_REF" \
        https://github.com/Sentinel-Bluebuilder/blue-js-sdk.git \
        "/Sentinel SDK/js-sdk"; \
    else \
      git clone --depth 1 \
        https://github.com/Sentinel-Bluebuilder/blue-js-sdk.git \
        "/Sentinel SDK/js-sdk"; \
    fi
WORKDIR "/Sentinel SDK/js-sdk"
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; \
    else npm install --omit=dev; fi

# ─── Runtime ───
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3402
ENV DATABASE_PATH=/data/x402.db

RUN apk add --no-cache su-exec \
 && addgroup -S app && adduser -S app -G app \
 && mkdir -p /data && chown -R app:app /data

COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist         ./dist
COPY package.json ./
COPY --from=sdk ["/Sentinel SDK", "/Sentinel SDK"]

COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3402
VOLUME ["/data"]

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
