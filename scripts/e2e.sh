#!/usr/bin/env sh
# 可重复的容器黑盒流程：
#   1. 构建镜像并启动 app（带健康检查）
#   2. 黑盒阶段 1：真实 HTTP 验证登记/附件去重/重算/白名单/批量坏行/预览/部分清理
#   3. 重启 app（容器重建，SQLite 数据卷保留）
#   4. 黑盒阶段 2：验证队列顺序、附件引用、清理计划恢复，并执行剩余到期清理
#   5. 容器内运行自动化测试与脚手架契约检查
# 全程仅使用本地容器网络，不连接任何外部内容识别或身份服务。
set -eu

COMPOSE="docker compose"
cd "$(dirname "$0")/.."

echo "==> [0/5] 清理旧环境"
$COMPOSE down -v --remove-orphans

echo "==> [1/5] 构建并启动 app（等待健康检查通过）"
$COMPOSE up -d --build --wait app

echo "==> [2/5] 黑盒阶段 1（重启前）"
$COMPOSE run --rm blackbox-seed

echo "==> [3/5] 重启 app（强制重建容器，SQLite 数据卷保留）"
$COMPOSE up -d --force-recreate --wait app

echo "==> [4/5] 黑盒阶段 2（重启后恢复 + 剩余清理）"
$COMPOSE run --rm blackbox-verify

echo "==> [5/5] 容器内自动化测试 + 脚手架契约检查"
$COMPOSE run --rm test
$COMPOSE run --rm --no-deps scaffold-check

echo ""
echo "全部黑盒与自动化测试通过。清理环境..."
$COMPOSE down -v --remove-orphans
