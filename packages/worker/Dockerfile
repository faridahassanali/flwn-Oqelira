FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /workspace && chown node:node /workspace
COPY packages/worker/runner.mjs /runner.mjs
USER node
WORKDIR /workspace
ENTRYPOINT ["node", "/runner.mjs"]
