# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3402
ENV DATABASE_PATH=/data/x402.db

RUN addgroup -S app && adduser -S app -G app \
 && mkdir -p /data && chown -R app:app /data

COPY --from=deps  --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist         ./dist
COPY --chown=app:app package.json ./

USER app
EXPOSE 3402
VOLUME ["/data"]

CMD ["node", "dist/index.js"]
