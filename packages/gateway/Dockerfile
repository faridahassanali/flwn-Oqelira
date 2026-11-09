# Build from the repo root: docker build -f packages/gateway/Dockerfile .
FROM node:24-bookworm-slim
ENV NODE_ENV=production OQELIRA_GATEWAY_HOST=0.0.0.0 PORT=4330
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/gateway/package.json packages/gateway/
# Production deps for the gateway and core only, plus tsx to run the TypeScript entry point.
RUN npm ci --omit=dev --ignore-scripts -w @oqelira/gateway && npm install --no-save --ignore-scripts tsx@4
COPY tsconfig.base.json ./
COPY packages/core packages/core
COPY packages/gateway/src packages/gateway/src
# No secrets in the image: token key, Foundry credentials and database URL arrive as runtime env.
USER node
EXPOSE 4330
CMD ["node", "--import", "tsx", "packages/gateway/src/main.ts"]
