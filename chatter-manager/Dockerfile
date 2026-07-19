FROM node:20-alpine

RUN apk add --no-cache docker-cli docker-cli-compose

WORKDIR /app

COPY server.js ./server.js

ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "server.js"]
