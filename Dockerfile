# syntax=docker/dockerfile:1

# ---- 依赖与编译阶段 ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
# better-sqlite3@13 随包发布 linuxmusl 预编译二进制，无需联网下载或本地编译
RUN npm ci
COPY tsconfig.build.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build

# ---- 自动化测试阶段（compose 的 test 服务使用） ----
FROM build AS test
COPY test ./test
CMD ["npm", "test"]

# ---- 运行阶段 ----
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    DB_PATH=/data/triage.db \
    POLICY_PATH=/app/config/policy.json
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./
COPY config ./config
COPY scripts/blackbox.mjs ./scripts/blackbox.mjs
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 8080
# 容器级健康检查：纯本地 HTTP，不依赖任何外部服务
HEALTHCHECK --interval=5s --timeout=3s --retries=20 --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
