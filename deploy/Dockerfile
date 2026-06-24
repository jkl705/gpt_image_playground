# ---- Build stage ----
FROM --platform=$BUILDPLATFORM node:20-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# ---- Production stage ----
FROM node:20-alpine

WORKDIR /app

ENV HOST=0.0.0.0
ENV PORT=3000
ENV DATA_DIR=/app/data
ENV DIST_DIR=/app/dist
ENV COOKIE_SECURE=false

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server

VOLUME ["/app/data"]
EXPOSE 3000

CMD ["node", "dist-server/server/index.js"]
