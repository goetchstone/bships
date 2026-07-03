# Stable, non-watch run of the whole game (client preview + ws server + stats),
# so live development on the host never restarts/freezes a running match.
# Build:  docker build -t bships .
# Run:    docker run --rm -p 5173:5173 -p 8787:8787 -p 8088:8088 bships
# Then open http://localhost:5173  ->  Create room -> Play vs AI.
FROM node:22-slim
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install && pnpm build
ENV STATS_INGEST_SECRET=dev-local-secret \
    STATS_URL=http://localhost:8088 \
    PORT=8787
EXPOSE 5173 8787 8088
# Production (non-watch) processes: stats + ws server + static client preview.
CMD npx concurrently -k -n stats,server,client -c magenta,blue,green \
    "pnpm --filter @bships/stats start" \
    "pnpm --filter @bships/server start" \
    "pnpm --filter @bships/client exec vite preview --host 0.0.0.0 --port 5173 --strictPort"
