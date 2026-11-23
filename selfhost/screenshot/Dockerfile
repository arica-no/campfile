# Campfile's screenshot service (server.mjs): headless Chromium that takes the link-preview screenshots. Build context is this folder; selfhost/compose.yaml builds and starts it.
FROM node:22-slim

# The fonts are here because pages are drawn by this Chromium, and a server image has none: Latin, Greek, Cyrillic and the other scripts (noto-core), CJK, emoji, and the Arial/Times/Courier look-alikes pages name.
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium-headless-shell fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji fonts-liberation \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.mjs bounded.mjs ./
ENV NODE_ENV=production HOME=/tmp
EXPOSE 3000
USER node
CMD ["node", "server.mjs"]
