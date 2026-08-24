# syntax=docker/dockerfile:1

# --- Build stage ---
FROM node:22-bookworm-slim AS build

WORKDIR /app

# Skip Playwright browser download during npm ci — we use the runtime stage's Chromium
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# --- Runtime stage ---
# Use the official Playwright image which includes Chromium and all system deps.
# Pin to the exact Playwright dep version to guarantee browser/driver compatibility.
FROM mcr.microsoft.com/playwright:v1.40.0-jammy AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Copy built artefacts and production deps only
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./

# Use dumb-init as PID 1 so Chrome child processes are reaped.
# The Playwright image already ships tini/dumb-init at /usr/bin/dumb-init.
# NOTE: Fargate users should use linuxParameters.initProcessEnabled=true instead.
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "dist/index.js"]

# /dev/shm sizing:
#   Docker Compose: set shm_size: 1gb
#   k8s: emptyDir{medium: Memory, sizeLimit: 1Gi} mounted at /dev/shm  (preferred)
#   Fargate: linuxParameters.tmpfs [{containerPath:"/dev/shm", size:1024}]
#   If none of the above is possible, set BROWSER_DISABLE_DEV_SHM=true as fallback.
#
# --no-sandbox is passed by the browser pool; document that this means a renderer
# RCE gets the container — exactly why Tier 1 (no browser) is the default path.

EXPOSE 3000
