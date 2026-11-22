#!/usr/bin/env bash
# 多随机种子重复：给主结果报「跨 seed 的范围」而不是单点数字。
#
# 审稿人一定会问：一个 seed 的死亡数 26，换个 seed 会不会变成 12 或 40？
# 这个脚本跑 3 个 seed × 2 个有代表性的工况（一个全天暴雨 + 一个傍晚短历时暴雨），
# 用同一套代码、同一批人（人数固定 1000），只换 seed。
#
# 用法：
#   bash sim/run_seeds_v1.sh [并发=2] [输出=out/seeds_v1]
# 前置：
#   - 不要在别的批跑进行时启动
# 说明：
#   - 结果落在 $OUT/u_p<rain>_s0__seed<seed>.json，可按 seed 分组求均值与范围
set -u
cd "$(dirname "$0")/.." || exit 1

CONC="${1:-2}"
OUT="${2:-out/seeds_v1}"
PEOPLE=1000
MINUTES=1440
# 只挑两个有代表性的工况：一个全天暴雨（u_p16）、一个傍晚短历时暴雨（u_p120）。
# 为什么不是全部 8 个：每个 run ~80 分钟，8×3=24 run ≈ 16 小时，一台机器排不下。
# 两个工况 × 3 seed = 6 run（约 4 小时），足够报「跨 seed 的范围」这一句，
# 论文里必须写明「seed 重复只做了这两个工况」。
CASES="u_p16_s0 u_p120_s0"
# 【2026-11-23】20261117 已经是主结果（out/sweep_v62 里的同参数 run），这里只补两个额外 seed。
SEEDS="20261123 20261129"

mkdir -p "$OUT"
echo "[seeds] 开始 $(date '+%F %T')  并发 $CONC · $PEOPLE 人 · 输出 $OUT"
echo "[seeds] 工况: $CASES"
echo "[seeds] 种子: $SEEDS"

running=0
for seed in $SEEDS; do
  for cs in $CASES; do
    out="$OUT/${cs}__seed${seed}.json"
    if [ -s "$out" ]; then
      echo "[seeds] skip 已存在 $out"
      continue
    fi
    (
      SIM_CASES_MAX=999 node sim/sim-day.mjs "$MINUTES" 24 "$PEOPLE" "$out" 0 "$cs" "$seed" \
        > "$OUT/${cs}__seed${seed}.log" 2>&1
      echo "[seeds] $cs seed=$seed exit=$? $(date '+%T')"
    ) &
    running=$((running + 1))
    if [ "$running" -ge "$CONC" ]; then
      wait -n 2>/dev/null || wait
      running=$((running - 1))
    fi
  done
done
wait

echo "[seeds] 结束 $(date '+%F %T')"
echo "[seeds] 汇总示例（死亡/被困/受伤）："
for cs in $CASES; do
  for seed in $SEEDS; do
    f="$OUT/${cs}__seed${seed}.json"
    [ -s "$f" ] || continue
    node -e '
      const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const i = (j.final && j.final.sim && j.final.sim.incidents) || {};
      const bad = j.final && j.final.error ? "  ❌ " + j.final.error : "";
      console.log(`  ${process.argv[2]} seed=${process.argv[3]}  死 ${i.dead ?? "?"} · 困 ${i.stranded ?? "?"} · 伤 ${i.injured ?? "?"}${bad}`);
    ' "$f" "$cs" "$seed"
  done
done
echo "[seeds] 注意：sim-day 单跑需要 127.0.0.1:8140 静态服务（本脚本不代起）。"