FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /workspace && chown node:node /workspace
COPY packages/worker/runner.mjs /app/packages/worker/runner.mjs
COPY packages/core/src/tools/search-engine.mjs /app/packages/core/src/tools/search-engine.mjs
USER node
WORKDIR /workspace
ENTRYPOINT ["node", "/app/packages/worker/runner.mjs"]
