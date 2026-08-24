FROM node:24-alpine3.24 AS ui-build
WORKDIR /app/ui
COPY ui/package.json ui/package-lock.json ./
RUN npm ci
COPY ui/ ./
RUN npm run build

FROM node:24-alpine3.24 AS server-build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine3.24 AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S registry && adduser -S registry -G registry
COPY --from=server-build --chown=registry:registry /app/package.json ./
COPY --from=server-build --chown=registry:registry /app/node_modules ./node_modules
COPY --from=server-build --chown=registry:registry /app/dist ./dist
COPY --from=ui-build --chown=registry:registry /app/ui/dist ./ui/dist
COPY --chown=registry:registry openapi.yaml ./openapi.yaml
USER registry
EXPOSE 3003
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 CMD wget -qO- http://127.0.0.1:3003/health/ready >/dev/null || exit 1
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["--ui"]
