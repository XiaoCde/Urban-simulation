#!/usr/bin/env bash
# run_surge_v1.sh — 纯增水（河道漫堤）三档驱动实验的仿真批次。
#
# 为什么单独一个脚本：这批不是「同族雨强对照」，不能进 sweep 的雨强表，也不能
# 和降雨工况混在一起算 ETA 参照（同族参照只对同雨型的工况有意义）。
#
# 前置：静态服务已在 127.0.0.1:8140（sim-day.mjs 需要），帧已由
#       python tools/flood/build_surge_only.py 生成到 web/assets/flood/u_p0_s*/。
#
# 用法：
#   bash web/sim/run_surge_v1.sh [people=1000] [minutes=1440] [outdir=out/surge_v1]
set -u

PEOPLE="${1:-1000}"
MINUTES="${2:-1440}"
OUT="${3:-out/surge_v1}"
SEED=20261117
CASES="u_p0_s2.71 u_p0_s4 u_p0_s6"    # 2.71=负对照（低于堤顶，不应淹）/4.0/6.0 漫堤
cd "$(dirname "$0")/.." || exit 1
mkdir -p "$OUT"            # 必须在 cd 之后：路径是相对 web/ 的

CURL=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8140/index.html || true)
if [ "$CURL" != "200" ]; then
  echo "[surge] 静态服务未就绪（http $CURL）。先起：node serve.js 8140" >&2
  exit 1
fi

echo "[surge] 开始 $(date '+%F %T') · ${PEOPLE} 人 · ${MINUTES} 分 · seed $SEED"
for c in $CASES; do
  out="$OUT/$c.json"
  if [ -s "$out" ]; then echo "[surge] skip $c（已有 $out）"; continue; fi
  echo "[surge] $c 起 $(date '+%H:%M:%S')"
  # SIM_CASES_MAX=999：导出全部个案（死者逐个可追溯），见 sim-day.mjs 的说明
  SIM_CASES_MAX=999 node sim/sim-day.mjs "$MINUTES" 24 "$PEOPLE" "$out" 0 "$c" "$SEED" \
    > "$OUT/$c.log" 2>&1
  rc=$?
  echo "[surge] $c 完 $(date '+%H:%M:%S') exit=$rc"
  if [ $rc -ne 0 ]; then echo "[surge] $c 退出码非 0，先看 $OUT/$c.log 尾部（[stuck]/[sim] 行）" >&2; fi
done
echo "[surge] 全部结束 $(date '+%F %T')"
echo "[surge] 并排：cd web && node tools/check/driver-ab.mjs $OUT/u_p0_s40.json out/ablate_v1/gate__u_p24_s0.json"