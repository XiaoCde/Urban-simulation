#!/usr/bin/env bash
# V6 敏感性矩阵：一次只动一处（口径表 §六 的协议）。
# 固定：u_p80_s0（傍晚 80 mm/h 脉冲）· 1020→1200 分（3 小时）· 400 人 · 种子 20261117 · 时间层开。
# 每行只改一个开关，其余与基线完全一致；跑完由 tools/sens/summary.mjs 汇总增量。
set -u
cd "$(dirname "$0")/../.." || exit 1
OUT=web/out/_sens
mkdir -p "$OUT"
COMMON="180 24 400"
run () {
  local name="$1"; shift
  local out="$OUT/$name.json"
  echo "=== $name  $(date +%H:%M:%S)"
  env SIM_TL=1 "$@" node web/sim/sim-day.mjs $COMMON "$out" 1020 u_p80_s0 20261117 \
    > "$OUT/$name.log" 2>&1
  local rc=$?
  echo "=== $name exit=$rc  $(date +%H:%M:%S)"
}

run base
run kappa2      SIM_KAPPA=2
run kappa05     SIM_KAPPA=0.5
run crowd_off   SIM_CROWD=off
run slip_off    SIM_SLIP=off
run slip_hi     SIM_SLIP_LO=1.4
run recv_off    SIM_RECV=off

echo "ALL DONE $(date +%H:%M:%S)"