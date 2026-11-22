#!/usr/bin/env bash
# 决策结构消融：五道门（gate） vs 单式基线（single/merge），4 个全天雨强工况
#   用法: bash sim/run_ablate_v1.sh [并发=2] [人数=1000] [分钟=1440] [输出目录=out/ablate_v1]
#
# 为什么两族都要用「同一份代码」重跑：sweep_v61 那批是旧的邻居网络规则跑的，
# 而 crowd-life 现在默认合成网络。直接拿旧批当 gate 基线会把「换网络」和
# 「换决策结构」混在一起，分不清差异来源。
#
# 每个工况两个模式，同一个 seed，只有 SIM_DECIDE 不同。
set -u
CONC="${1:-2}"
PEOPLE="${2:-1000}"
MINUTES="${3:-1440}"
OUT="${4:-out/ablate_v1}"
SEED=20261117
CASES="u_p8_s0 u_p16_s0 u_p24_s0 u_p32_s0"

mkdir -p "$OUT"
echo "[ablate] 开始 $(date '+%F %T')  并发 $CONC · $PEOPLE 人 · $MINUTES 分 · seed $SEED"
echo "[ablate] 工况: $CASES"
echo "[ablate] 模式: gate（五道门） / single（单式基线 merge）"

jobs_list=""
for c in $CASES; do
  for m in gate single; do
    jobs_list="$jobs_list$m $c\n"
  done
done

printf "%b" "$jobs_list" | xargs -P "$CONC" -n 2 bash -c '
  m="$0"; c="$1"
  out="'"$OUT"'/${m}__${c}.json"
  log="'"$OUT"'/${m}__${c}.log"
  if [ -s "$out" ]; then echo "[skip] $m $c 已有结果"; exit 0; fi
  t0=$(date +%s)
  # SIM_CASES_MAX=999：导出全部个案（否则只导出「最深的 12 个死者」，
  # 统计死因构成会系统性偏深水）。注意这个变量必须在 Node 侧被读到、再由 URL
  # 传进页面——直接在 page.evaluate 里读 process 会每次收尾抛错、final.sim=null。
  SIM_CASES_MAX=999 SIM_DECIDE="$m" SIM_SINGLE=merge node sim/sim-day.mjs '"$MINUTES"' 24 '"$PEOPLE"' "$out" 0 "$c" '"$SEED"' > "$log" 2>&1
  rc=$?
  t1=$(date +%s)
  echo "[done] $m $c 退出码 $rc 墙钟 $((t1-t0))s  $(date +%T)"
  exit $rc
'

echo "[ablate] 结束 $(date '+%F %T')"
echo "[ablate] 结果表: node tools/check/decide-ab.mjs $OUT/gate__u_p16_s0.json $OUT/single__u_p16_s0.json"
echo "[ablate] 若退出码非 0，先看 $OUT/<模式>__<工况>.log 尾部的 [stuck] / PROG 段"