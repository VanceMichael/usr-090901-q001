# syntax=docker/dockerfile:1

# ---- 构建阶段：TypeScript -> dist ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- 运行阶段：仅编译产物 + 规则与迁移，无 npm 依赖（node:sqlite 内置） ----
FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    SQLITE_PATH=/data/dispatch.db
WORKDIR /app

# 非 root 运行，数据目录归属该用户
RUN addgroup -S app && adduser -S -G app app \
    && mkdir -p /data && chown -R app:app /data

COPY --from=build /app/dist ./dist
COPY rules ./rules
COPY migrations ./migrations
COPY package.json ./package.json
COPY scripts ./scripts

USER app
VOLUME ["/data"]
EXPOSE 8080

# 健康检查直接用 Node 22 内置 fetch，不引入 curl/wget
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=20 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "--experimental-sqlite", "dist/index.js"]
