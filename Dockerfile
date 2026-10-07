FROM node:24-bookworm-slim AS build
WORKDIR /app

# 发布版本号，由 CI / 发布方注入，格式：<提交日期 YYYYMMDD>-<7 位提交号>，例如 20260830-4f48e61。
# 必须在 npm run build 之前声明：管理台侧边栏的版本徽标是预渲染的，构建期就要读到它。
# 不传则为空，应用会退化成 0.1.0-dev（明确表示这不是一次发布），不会因此构建失败。
ARG APP_VERSION=""
ENV APP_VERSION=${APP_VERSION}

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci

COPY . .
RUN npm run build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production

# 构建阶段的 ENV 不会带到运行阶段，这里重新声明一次：/health、系统监控、/api/version
# 都读运行时的 APP_VERSION，它同时也是 `docker inspect` 里能看到的发布标识。
ARG APP_VERSION=""
ENV APP_VERSION=${APP_VERSION}

WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /app /app
RUN chmod +x /app/docker/entrypoint.sh

EXPOSE 8080
ENTRYPOINT ["/app/docker/entrypoint.sh"]
