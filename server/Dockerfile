# syntax=docker/dockerfile:1.7

# ─── Build the server ───
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts --no-audit --no-fund --loglevel=error
COPY tsconfig.json ./
COPY src ./src
RUN npm run build \
 && npm prune --omit=dev --ignore-scripts

# ─── Runtime ───
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4020
ENV FACILITATOR_PORT=4021

RUN addgroup -S app && adduser -S app -G app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist         ./dist
COPY package.json ./

USER app

EXPOSE 4020

CMD ["node", "dist/index.js"]
