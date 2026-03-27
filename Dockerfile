FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache curl dumb-init

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .
RUN chmod +x /app/docker-entrypoint.sh && mkdir -p /app/logs /app/data /app/temp

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD curl -f http://127.0.0.1:3000/health || exit 1

ENTRYPOINT ["dumb-init", "--", "/app/docker-entrypoint.sh"]
CMD ["node", "src/app.js"]
