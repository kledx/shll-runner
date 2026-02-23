# --- SDK Build Stage ---
# Build the @shll/runner-sdk dependency first
FROM node:20-slim AS sdk-builder
WORKDIR /sdk
COPY shll-runner-sdk/package.json shll-runner-sdk/package-lock.json* ./
RUN npm install
COPY shll-runner-sdk/ .
RUN npx tsup

# --- Runner Build Stage ---
FROM node:20-slim AS builder
WORKDIR /app

# Copy pre-built SDK to the path that package.json file: reference expects
COPY --from=sdk-builder /sdk /app/shll-runner-sdk

# Install runner deps — file:../shll-runner-sdk resolves relative to /app
# so we override with a local copy inside the build context
COPY package.json package-lock.json* ./
# Rewrite the file: reference to point to local copy
RUN sed -i 's|"file:../shll-runner-sdk"|"file:./shll-runner-sdk"|' package.json
RUN npm install

COPY . .
RUN npx tsc

# --- Runtime Stage ---
FROM node:20-slim AS runner
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends wget && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

ENV NODE_ENV=production

# Health check — verify the HTTP API is serving
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:${API_PORT:-8787}/health || exit 1

CMD ["node", "dist/index.js"]
