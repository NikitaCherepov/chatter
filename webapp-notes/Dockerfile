FROM node:20-bookworm-slim AS build

WORKDIR /app

# better-sqlite3 is a native Node module and may need a compiler during install.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build \
    && npm prune --omit=dev


FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production \
    NOTES_DB_PATH=/data/chatter.db

WORKDIR /app

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/next.config.mjs ./next.config.mjs

RUN mkdir -p /data \
    && chown -R node:node /app /data

USER node

EXPOSE 3001

CMD ["npm", "start"]
