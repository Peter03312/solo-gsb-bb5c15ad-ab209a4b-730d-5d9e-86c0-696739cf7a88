# 巡展作品光照预算工作台
# 说明：better-sqlite3 需从源码编译（部分预编译二进制在特定宿主上加载即崩溃），
# 因此使用含编译工具链的 node:20-bookworm 镜像。
FROM node:20-bookworm-slim AS build
WORKDIR /app

# 先拷贝依赖清单，利用 Docker 层缓存安装并编译原生模块
COPY package.json package-lock.json* .npmrc ./
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm config set fund false \
    && npm ci --no-audit --no-fund || npm install --no-audit --no-fund

# 运行阶段：仅拷贝源码与已编译好的 node_modules
FROM node:20-bookworm-slim
ENV NODE_ENV=production \
    PORT=8080 \
    DB_PATH=/data/light.db
WORKDIR /app

RUN mkdir -p /data && chown -R node:node /data
COPY --from=build /app/node_modules ./node_modules
COPY src ./src
COPY public ./public

USER node
EXPOSE 8080
VOLUME ["/data"]

# 容器首次启动且数据库不存在时自动建表并写入演示数据（见 src/db.js openDb）
CMD ["node", "src/server.js"]
