FROM node:20-alpine

RUN apk add --no-cache docker-cli docker-cli-compose sqlite

WORKDIR /app

COPY chatter-manager/server.js ./server.js
COPY docker-compose.yml ./release/docker-compose.yml

ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "server.js"]
