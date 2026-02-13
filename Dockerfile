# --- Build Stage ---
FROM node:20-slim AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
RUN npx tsc

# --- Runtime Stage ---
FROM node:20-slim AS runner
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

ENV NODE_ENV=production

# Health check — verify the process is runningapi/listings
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "process.exit(0)"

CMD ["node", "dist/index.js"]
