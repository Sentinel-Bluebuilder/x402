# syntax=docker/dockerfile:1.7

# ─── Build the server ───
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ─── Production deps only ───
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# ─── Runtime ───
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4020
ENV FACILITATOR_PORT=4021

RUN addgroup -S app && adduser -S app -G app

COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist         ./dist
COPY package.json ./

USER app

EXPOSE 4020

CMD ["node", "dist/index.js"]
