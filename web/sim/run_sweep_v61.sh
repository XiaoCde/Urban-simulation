#!/usr/bin/env bash
# 8 工况重跑（V6.1 口径）——过夜跑批的启动脚本
#
# 为什么写成脚本：过夜跑批不该靠「记得在窗口里敲一行」。双击/一条命令即可，
# 参数固定在这里，不会因为记忆偏差少传一个人数或并发。
#
# 用法（在本目录 = web/）：
#   bash sim/run_sweep_v61.sh          # 正式
#   bash sim/run_sweep_v61.sh 2 500    # 并发 2、500 人（先降压试跑）
#
# 产出：web/out/sweep_v61/ 下的每工况 JSON/MD/日志，以及 _sweep.json（含四条绊线汇总）
# 早上检查：cd web && node sim/sweep-report.mjs out/sweep_v61
set -u
CONC="${1:-2}"
PEOPLE="${2:-1000}"
OUT="${3:-out/sweep_v61}"

cd "$(dirname "$0")/.." || exit 1
mkdir -p "$OUT"

echo "[run_sweep_v61] 起始 $(date '+%F %T') · 并发 $CONC · $PEOPLE 人 · 全天 1440 分 · 输出 $OUT"
echo "[run_sweep_v61] 绊线：断流 8 分钟即杀、ETA 参照取同族已完成中位数、结果合理性对基线、NaN 路径"
node sim/sim-sweep.mjs all "$CONC" "$PEOPLE" 1440 "$OUT"
code=$?
echo "[run_sweep_v61] 结束 $(date '+%F %T') · 退出码 $code"
echo "[run_sweep_v61] 若退出码非 0：先看 $OUT/*.log 最后 20 行与 _sweep.json 的 tripwires 段，不要直接引用结果"
exit "$code"