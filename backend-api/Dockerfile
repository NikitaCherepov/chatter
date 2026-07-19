FROM node:20-bookworm-slim AS build

WORKDIR /app

# Native Node modules such as better-sqlite3 may need a compiler while
# dependencies are being installed.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build


FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production \
    BACKEND_API_PORT=3050 \
    API_DB_PATH=/data/chatter.db \
    UPLOADS_DIR=/data/uploads

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npm cache clean --force

COPY --from=build /app/dist ./dist

# TypeScript does not copy Markdown system prompts into dist.
COPY --from=build /app/src/services/subagents/prompts ./dist/services/subagents/prompts

RUN mkdir -p /data/uploads \
    && chown -R node:node /app /data

USER node

EXPOSE 3050

CMD ["node", "dist/server.js"]
