#!/usr/bin/env bash
# 机检「真的会红」演示（创新点 ② 的证据）
#
# 主张是「新加一个没出处的常数会被拦住」。光说没用——这里真往登记表里塞两种
# 典型错误，看检查器是不是当场打红，然后原样还原。
#
#   错误 A：改了运行时真值却没改登记的 expect（数字漂移，最常见）
#   错误 B：新加一条「自设」常数，但没写为什么是这个数、也没写敏感性
#
# 用法：cd web && bash tools/check/inject-demo.sh
# 还原靠 trap，中途 Ctrl-C 也不会把仓库留在坏状态。
set -e
cd "$(dirname "$0")/../.." || exit 1

REG=src/kernel/param-registry.js
BAK=$(mktemp)
cp "$REG" "$BAK"
trap 'cp "$BAK" "$REG"; rm -f "$BAK"; echo "[demo] 已还原 $REG"' EXIT

run_case () {
  local name="$1"
  echo "── 注入：$name"
  node tests/check-param-evidence.mjs 2>&1 | grep -E "✗|FAIL|不通过|未通过|失败" | head -4 || true
  node tests/check-param-evidence.mjs >/dev/null 2>&1 && echo "    ❌ 检查器没报错——这条规则没生效" || echo "    ✅ 检查器打红（符合预期）"
  cp "$BAK" "$REG"
}

# A: 数字漂移（登记表写 0.31，代码里其实还是 0.30）
# 注意别拿 ch.costUnit 演示：它没有 get()，只靠 probe 钉字面量，
# 改 expect 不会红——这本身就是「哪类常数靠 probe、哪类靠 get」的分界。
python - "$REG" <<'PY'
import io,sys
p=sys.argv[1]; s=io.open(p,encoding='utf-8').read()
s=s.replace("expect: 0.30, kind: 'selfSet',", "expect: 0.31, kind: 'selfSet',", 1)
io.open(p,'w',encoding='utf-8',newline='\n').write(s)
PY
run_case "改 expect（数字漂移）"

# B: 自设常数缺理由
python - "$REG" <<'PY'
import io,sys
p=sys.argv[1]; s=io.open(p,encoding='utf-8').read()
anchor="const ENTRIES = ["
add="""const ENTRIES = [
  // 演示用：故意少写 why / sens 的自设常数
  { id: 'demo.nope', chain: 'population', label: '演示常数', unit: '-', expect: 0.42,
    kind: 'selfSet', source: '自己拍的', why: '', sens: '' },
"""
s=s.replace(anchor,add,1)
io.open(p,'w',encoding='utf-8',newline='\n').write(s)
PY
run_case "加一条自设常数但不写为什么"

echo "── 还原后复跑"
node tests/check-param-evidence.mjs 2>&1 | tail -1