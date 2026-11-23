# Campfile for any server: one Node process serving the app and the viewer (selfhost/server.ts). Build context is the repository root; compose.yaml does that.
# Node runs the .ts files directly, so there is no build step, and pnpm is here only for `pnpm migrate` and `pnpm admin`.
FROM node:22-slim

# Not corepack: it downloads pnpm again for the unprivileged user at the first run.
RUN npm install --global pnpm@12.11.2 && mkdir /data /settings && chown node:node /data /settings && chmod 700 /settings
WORKDIR /app

# Only what runs: dependencies first, so a code change does not install them again. selfhost/Dockerfile.dockerignore keeps everything else out.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY migrations migrations
COPY scripts/admin.ts scripts/migrate.ts scripts/
COPY src src
COPY public public
COPY viewer/public viewer/public
COPY selfhost selfhost

# COPY keeps the modes of the checkout, and a umask of 077 or 027 there leaves files that the unprivileged user below cannot read.
RUN chmod -R a+rX /app

# pnpm would try to reinstall before every `pnpm migrate` and `pnpm admin`, which the unprivileged user cannot (node_modules is root's) and nobody wants.
ENV NODE_ENV=production DATA_DIR=/data pnpm_config_verify_deps_before_run=false NODE_OPTIONS="--import=/app/selfhost/settings.mjs"
VOLUME /data
EXPOSE 8787 8788
USER node
CMD ["sh", "selfhost/start.sh"]
