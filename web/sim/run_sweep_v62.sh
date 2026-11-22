#!/usr/bin/env bash
# V6.2 主结果：8 工况重跑（合成同伴网络 + 门5 三条 + 车速受水约束）
#
# 为什么必须重跑：`out/sweep_v61` 那批是 2026-11-22 04:14 跑完的，当时同伴网络还是
# 「同户 + 120 m 内 3 邻居」的自设规则；现在默认已换成 Kleinberg 小世界合成网络
# （`web/src/kernel/peer-network.js`，Borowski QA9 的 5 人上限）。两份数字不能混引。
#
# 用法：
#   bash sim/run_sweep_v62.sh [并发=2] [人数=1000] [输出=out/sweep_v62]
# 前置：
#   - 本脚本会自己起临时静态服务（sim-sweep 内置），不需要手工开 8140
#   - 不要与其它批跑同时跑（会拉长墙钟，让 ETA 参照失效）
set -u
cd "$(dirname "$0")/.." || exit 1

CONC="${1:-2}"
PEOPLE="${2:-1000}"
OUT="${3:-out/sweep_v62}"
mkdir -p "$OUT"

echo "[v62] 开始 $(date '+%F %T')  并发 $CONC · $PEOPLE 人 · 输出 $OUT"
echo "[v62] 同伴网络：synthetic（Kleinberg 小世界，d_sr=120 m，q=1，上限 5 人）"

# SIM_CASES_MAX 必须在 Node 侧读（页面闭包里没有 process —— 2026-11-22 的教训）
# 【2026-11-23 00:10 教训】sim-sweep 的工况表必须是**一个**逗号分隔的参数
# （process.argv[2]），不能写成 8 个空格分隔的参数——否则它会只认第一个工况、
# 把第二个工况名当输出目录，然后在 1 秒内"成功"退出（exit 0，产出 0 个结果）。
CASES="u_p8_s0,u_p16_s0,u_p24_s0,u_p32_s0,u_p20_s0,u_p40_s0,u_p80_s0,u_p120_s0"
SIM_CASES_MAX=999 node sim/sim-sweep.mjs "$CASES" \
  "$CONC" "$PEOPLE" 1440 "$OUT" \
  > "$OUT/_runner.log" 2>&1
CODE=$?

echo "[v62] 结束 $(date '+%F %T') 退出码 $CODE"
if [ "$CODE" -ne 0 ]; then
  echo "[v62] 退出码非 0：先看 $OUT/_runner.log 里的「绊线」段与 *_stderr.log"
  exit "$CODE"
fi

echo "[v62] 生成对比表："
node sim/sweep-report.mjs "$OUT" || true
echo
echo "[v62] 与 V6.1 的差异（同工况同 seed，只差同伴网络与门5）："
echo "  node tools/check/peer-ab.mjs $OUT/u_p24_s0.json out/sweep_v61/u_p24_s0.json"
echo "[v62] 与消融对照组并排（若 out/ablate_v1 已跑完）："
echo "  node tools/check/decide-ab.mjs $OUT/u_p16_s0.json $OUT/u_p24_s0.json out/ablate_v1/gate__u_p16_s0.json out/ablate_v1/gate__u_p24_s0.json"