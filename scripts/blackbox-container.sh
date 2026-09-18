#!/usr/bin/env bash
# 可重复的容器黑盒：全新卷 -> 构建 -> 起服 -> 完整 suite ->
# 重启前写入(pre) -> 重启 app 容器 -> 重启后恢复校验(post) -> 清理。
# 全程仅真实 HTTP，不连接任何外部内容识别或身份服务。
set -euo pipefail
cd "$(dirname "$0")/.."

RUN_ID="${RUN_ID:-bb$(date +%s)}"
export RUN_ID

echo "== 0/6 脚手架契约自检 =="
docker compose run --rm --no-deps scaffold-check

echo "== 1/6 构建镜像并以全新卷启动 =="
docker compose down -v --remove-orphans >/dev/null 2>&1 || true
docker compose build app
docker compose up -d app

cleanup() {
  echo "== 清理容器与卷 =="
  docker compose down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "== 2/6 等待健康检查通过 =="
for i in $(seq 1 60); do
  if docker compose exec -T app node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
    echo "app healthy"; break
  fi
  sleep 2
  if [ "$i" = "60" ]; then echo "app 未就绪"; docker compose logs app; exit 1; fi
done

echo "== 3/6 容器黑盒 suite（去重/重算/白名单/清理/坏行隔离）=="
docker compose run --rm -e RUN_ID="$RUN_ID" blackbox suite

echo "== 4/6 重启前写入恢复基线 =="
docker compose run --rm -e RUN_ID="$RUN_ID" blackbox pre

echo "== 5/6 重启 app 容器（卷保留）=="
docker compose restart app
for i in $(seq 1 60); do
  if docker compose exec -T app node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
    echo "app healthy after restart"; break
  fi
  sleep 2
  [ "$i" = "60" ] && { echo "重启后未就绪"; docker compose logs app; exit 1; }
done

echo "== 6/6 重启后恢复校验（队列顺序/计数器/去重索引/清理计划）=="
docker compose run --rm -e RUN_ID="$RUN_ID" blackbox post

echo ""
echo "✅ 容器黑盒全部通过（RUN_ID=$RUN_ID）"
