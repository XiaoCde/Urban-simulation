"""
从新的全量仿真结果生成汇报材料（Markdown + 五张配图 + 预览页）。

用法：
    python tools/report/build_deliverables.py [数据JSON路径] [输出目录]

默认数据：web/out/sim_day_new.json
默认输出：桌面的「两周汇报配图」文件夹，MD 写在桌面。

【为什么要这个脚本】模型换过之后，桌面那份旧汇报和五张配图里的数字
全是旧线性打分模型跑出来的，整批作废。以后每次重跑，只要把新 JSON
喂给这个脚本，表格、图、预览页一起更新，不会出现新旧数字混用。

【口径】表里只放数据和依据，不放讲稿、路径、命令、验证人数。
文末附「附录：数据来源」，按来源逐条写真实的文章、网站、机构，
并分清真实数据集 / 文献里的实测值 / 模型跑出来的数（不是实测） / 目前自己定的。
"""
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "web/out/sim_day_new.json"
DESKTOP = Path("D:/Users/asus/Desktop")
OUTDIR = Path(sys.argv[2]) if len(sys.argv) > 2 else DESKTOP / "两周汇报配图"
MD_PATH = Path(sys.argv[3]) if len(sys.argv) > 3 else DESKTOP / "两周工作汇报_讲稿与数据.md"

OUTDIR.mkdir(parents=True, exist_ok=True)
d = json.loads(DATA.read_text(encoding="utf-8"))
F = (d.get("final") or {}).get("sim") or {}
L = F.get("live") or {}
D = F.get("driving") or {}
I = F.get("incidents") or {}
C = F.get("circles") or {}
by_action = L.get("byAction") or d.get("totalByAction") or {}

n = lambda v: f"{int(v or 0):,}"
pct = lambda v, total: (100.0 * (v or 0) / total) if total else 0.0
total_actions = sum(by_action.values())
judged = L.get("judged") or total_actions
hourly = d.get("hourly") or []

# ---------------------------------------------------------------- 配图
INK = "#1f2933"
MUTED = "#5b6b77"
ACCENT = "#1d6fb8"
WARM = "#c0562f"
BG = "#fbfcfe"
LINE = "#d9e2ea"


def svg(title, subtitle, body, height=460):
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 {height}" width="1000" height="{height}">
<rect width="1000" height="{height}" fill="{BG}"/>
<text x="40" y="46" font-family="Microsoft YaHei, PingFang SC, sans-serif" font-size="27" font-weight="700" fill="{INK}">{title}</text>
<text x="40" y="76" font-family="Microsoft YaHei, PingFang SC, sans-serif" font-size="14" fill="{MUTED}">{subtitle}</text>
<line x1="40" y1="92" x2="960" y2="92" stroke="{LINE}" stroke-width="1.5"/>
{body}
</svg>'''


def esc(s):
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


# 图 1：同一根时间轴
rows1 = [
    ("人", "按真实人口记录抽，全天连续走", 132),
    ("车", "绑定车主，同一时钟", 182),
    ("水", "离线算好，实时查表", 232),
    ("判断", "每 0.5–1 仿真秒一次", 282),
    ("动作 / 伤亡", "真实位移与状态累计", 332),
]
body1 = [f'<line x1="80" y1="384" x2="925" y2="384" stroke="{INK}" stroke-width="3"/>']
for i in range(25):
    x = 80 + i * (845 / 24)
    h = 12 if i % 6 == 0 else 6
    body1.append(f'<line x1="{x:.1f}" y1="384" x2="{x:.1f}" y2="{384-h}" stroke="{INK}" stroke-width="1.5"/>')
    if i % 6 == 0:
        body1.append(f'<text x="{x:.1f}" y="406" text-anchor="middle" font-family="Microsoft YaHei, sans-serif" font-size="13" fill="{MUTED}">{i:02d}:00</text>')
for label, desc, y in rows1:
    body1.append(f'<rect x="80" y="{y}" width="845" height="38" rx="6" fill="#eef4fa" stroke="{LINE}"/>')
    body1.append(f'<text x="96" y="{y+25}" font-family="Microsoft YaHei, sans-serif" font-size="16" font-weight="700" fill="{ACCENT}">{esc(label)}</text>')
    body1.append(f'<text x="190" y="{y+25}" font-family="Microsoft YaHei, sans-serif" font-size="15" fill="{INK}">{esc(desc)}</text>')
body1.append(f'<text x="80" y="445" font-family="Microsoft YaHei, sans-serif" font-size="14" fill="{MUTED}">×24 只是把每帧分成更多子步，不是跳过时间；人、车、水、判断、动作、伤亡共用同一个仿真秒</text>')
svg1 = svg("人、车、水共用一根 0:00 → 24:00 的时钟", "连续推进，不是预写动画；拖动时间轴看的是按时刻重建的快照", "\n".join(body1), 470)

# 图 2：全天动作分布
ORDER = ["continue", "slow", "hurry", "wait", "detour", "turnback", "abandon"]
CN = {"continue": "继续", "slow": "放慢", "hurry": "加快", "wait": "等待",
      "detour": "换街", "turnback": "掉头", "abandon": "放弃"}
items = [(CN.get(k, k), by_action.get(k, 0)) for k in ORDER if k in by_action]
items += [(k, v) for k, v in by_action.items() if k not in ORDER]
items.sort(key=lambda x: -x[1])
body2 = []
maxv = max((v for _, v in items), default=1) or 1
for i, (label, v) in enumerate(items[:9]):
    y = 126 + i * 38
    w = 620 * v / maxv
    color = ACCENT if i == 0 else "#8fb6d8"
    body2.append(f'<text x="60" y="{y+20}" font-family="Microsoft YaHei, sans-serif" font-size="15" fill="{INK}">{esc(label)}</text>')
    body2.append(f'<rect x="150" y="{y}" width="{w:.1f}" height="25" rx="4" fill="{color}"/>')
    body2.append(f'<text x="{150+w+10:.1f}" y="{y+19}" font-family="Microsoft YaHei, sans-serif" font-size="14" fill="{MUTED}">{n(v)} · {pct(v,total_actions):.2f}%</text>')
body2.append(f'<text x="60" y="440" font-family="Microsoft YaHei, sans-serif" font-size="14" fill="{MUTED}">合计 {n(total_actions)} 次判断；动作是抽样决定，「继续日常 / 启动保护行动」是离散选择，细动作属于路径执行</text>')
svg2 = svg("全天判断次数里各动作占多少", "模型跑出来的数，不是实测；来源：本次连续 24 小时全量仿真", "\n".join(body2), 470)

# 图 3：一次判断的四层流程
steps = [
    ("读输入", "水深、雨强、目标、身体状态、今日经历、社会身份、灾害履历、同伴比例"),
    ("认知层", "情境知识有序 logit 预测子 — Thieken 2023 补充材料 Table S2"),
    ("行动层", "感知减损行为评分有序 logit — Thieken 2023 补充材料 Table S3"),
    ("选择层", "继续日常 / 启动保护行动 二元随机参数 logit — Borowski & Stathopoulos 2023 Table 4"),
    ("时间层", "预警多久、动员率 — Silva 2025 补充材料 Eq.(S2) 与 Table S2 实测点"),
    ("抽样 → 执行", "按概率抽一次；绕哪条街、等在哪由真实几何与实测步速决定"),
]
body3 = []
for i, (name, desc) in enumerate(steps):
    y = 118 + i * 55
    body3.append(f'<rect x="70" y="{y}" width="860" height="44" rx="7" fill="#eef4fa" stroke="{LINE}"/>')
    body3.append(f'<circle cx="100" cy="{y+22}" r="14" fill="{ACCENT}"/>')
    body3.append(f'<text x="100" y="{y+27}" text-anchor="middle" font-family="sans-serif" font-size="13" fill="white">{i+1}</text>')
    body3.append(f'<text x="128" y="{y+28}" font-family="Microsoft YaHei, sans-serif" font-size="16" font-weight="700" fill="{INK}">{esc(name)}</text>')
    body3.append(f'<text x="260" y="{y+28}" font-family="Microsoft YaHei, sans-serif" font-size="14" fill="{MUTED}">{esc(desc)}</text>')
    if i < len(steps) - 1:
        body3.append(f'<line x1="500" y1="{y+44}" x2="500" y2="{y+55}" stroke="{ACCENT}" stroke-width="2"/>')
body3.append(f'<text x="70" y="455" font-family="Microsoft YaHei, sans-serif" font-size="14" fill="{MUTED}">系数全部抄自实测论文；没有阈值开关，同一处境不同人、不同次结果不同</text>')
svg3 = svg("一次判断是怎么算出来的", "四层离散选择，替换了旧的手写线性打分公式与二元门控", "\n".join(body3), 480)

# 图 4：先验方向（实测系数与实测编码；不把模型输出的比例当实测）
arrows = [
    ("既往洪水次数增加", "↑", "知识与行动先验升高",
     "Thieken 2023 补充材料 Table S2（0.680 / 0.901 / 2.010）、Table S3（0.212）"),
    ("收到官方预警、信息更全", "↑", "情境知识先验升高",
     "Thieken 2023 补充材料 Table S2（0.571 / 0.147）"),
    ("预警发出更久", "↑", "动员率升高",
     "Silva 2025 补充材料 Table S2 实测 8 / 24 / 72 小时 88.8 / 95.7 / 98.6%"),
    ("同伴都留下", "↓", "更倾向一起留下",
     "Borowski 2023 Table 4（7.76）；危险升高时该效应被抵消"),
]
body4 = []
for i, (name, arrow, result, src) in enumerate(arrows):
    y = 126 + i * 76
    body4.append(f'<rect x="60" y="{y}" width="880" height="64" rx="7" fill="#eef4fa" stroke="{LINE}"/>')
    body4.append(f'<text x="82" y="{y+26}" font-family="Microsoft YaHei, sans-serif" font-size="17" font-weight="700" fill="{INK}">{esc(name)}</text>')
    body4.append(f'<text x="82" y="{y+49}" font-family="Microsoft YaHei, sans-serif" font-size="12.5" fill="{MUTED}">{esc(src)}</text>')
    body4.append(f'<text x="690" y="{y+40}" font-family="sans-serif" font-size="30" font-weight="700" fill="{WARM if arrow=="↓" else ACCENT}">{arrow}</text>')
    body4.append(f'<text x="740" y="{y+40}" font-family="Microsoft YaHei, sans-serif" font-size="15" fill="{INK}">{esc(result)}</text>')
body4.append(f'<text x="60" y="446" font-family="Microsoft YaHei, sans-serif" font-size="13.5" fill="{MUTED}">箭头来自实测系数的符号，不是模型比例；危险等级来自 DEFRA HR 分级，水深按 Thieken Table S1 的 1–7 级编码归一（归一方式目前自己定的）</text>')
body4.append(f'<text x="60" y="468" font-family="Microsoft YaHei, sans-serif" font-size="13.5" fill="{MUTED}">注意：Table S3 的水深系数 −0.28 因变量是「觉得减灾措施有没有用」，不是「撤不撤离」，不能当撤离概率的依据</text>')
svg4 = svg("哪些先验会改变一个人的选择", "按论文实测系数方向画；模型输出的比例另标，不冒充实测", "\n".join(body4), 490)

# 图 5：水怎么算
body5 = [
    f'<rect x="60" y="130" width="270" height="120" rx="8" fill="#eef4fa" stroke="{LINE}"/>',
    '<text x="82" y="162" font-family="Microsoft YaHei, sans-serif" font-size="17" font-weight="700" fill="#1f2933">同一小步里两笔账</text>',
    '<text x="82" y="192" font-family="Microsoft YaHei, sans-serif" font-size="15" fill="#1f2933">＋ 这一会儿下的雨</text>',
    '<text x="82" y="218" font-family="Microsoft YaHei, sans-serif" font-size="15" fill="#1f2933">－ 下渗 / 管网 / 入河</text>',
    f'<rect x="365" y="130" width="270" height="120" rx="8" fill="#eef4fa" stroke="{LINE}"/>',
    '<text x="387" y="162" font-family="Microsoft YaHei, sans-serif" font-size="17" font-weight="700" fill="#1f2933">逐格推进</text>',
    '<text x="387" y="192" font-family="Microsoft YaHei, sans-serif" font-size="15" fill="#1f2933">按相邻格水面高差算流量</text>',
    '<text x="387" y="218" font-family="Microsoft YaHei, sans-serif" font-size="15" fill="#1f2933">地形与街道决定往哪漫</text>',
    f'<rect x="670" y="130" width="270" height="120" rx="8" fill="#eef4fa" stroke="{LINE}"/>',
    '<text x="692" y="162" font-family="Microsoft YaHei, sans-serif" font-size="17" font-weight="700" fill="#1f2933">提前算好存成图</text>',
    '<text x="692" y="192" font-family="Microsoft YaHei, sans-serif" font-size="15" fill="#1f2933">一整天各时刻的水深帧</text>',
    '<text x="692" y="218" font-family="Microsoft YaHei, sans-serif" font-size="15" fill="#1f2933">网页与人只查表，不解方程</text>',
    f'<line x1="330" y1="190" x2="365" y2="190" stroke="{ACCENT}" stroke-width="3"/>',
    f'<line x1="635" y1="190" x2="670" y2="190" stroke="{ACCENT}" stroke-width="3"/>',
    '<text x="60" y="300" font-family="Microsoft YaHei, sans-serif" font-size="16" font-weight="700" fill="#1f2933">雨和排水是同时算的</text>',
    '<text x="60" y="330" font-family="Microsoft YaHei, sans-serif" font-size="15" fill="#5b6b77">不是先下完再排；雨停后「加的那笔」没了、「减的那笔」还在，所以水会慢慢退。</text>',
    '<text x="60" y="366" font-family="Microsoft YaHei, sans-serif" font-size="15" fill="#5b6b77">现在出数的只有二维浅水这套新内核；旧的填洼内核留在文件夹里，不再出数。</text>',
    '<text x="60" y="440" font-family="Microsoft YaHei, sans-serif" font-size="14" fill="#5b6b77">口径来源：项目内二维浅水模型与离线帧序列；逐文件来源见文末附录</text>',
]
svg5 = svg("水是怎么算的", "二维浅水逐格推进，雨和排水同一小步一起记账", "\n".join(body5), 470)

FILES = [
    ("01-同一根时间轴.svg", svg1, "人、车、水、判断、动作、伤亡共用一根 24 小时时钟"),
    ("02-动作分布.svg", svg2, "全天判断里各动作占多少（模型输出，不是实测）"),
    ("03-一次判断.svg", svg3, "四层离散选择的流程与每层的实测出处"),
    ("04-先验方向.svg", svg4, "水深、经历、预警、同伴如何改变保护倾向（方向来自实测系数）"),
    ("05-水怎么算.svg", svg5, "雨与排水同时算，提前烘成水深帧，网页只查表"),
]
for name, content, _ in FILES:
    (OUTDIR / name).write_text(content, encoding="utf-8")

# ---------------------------------------------------------------- 正文
def table_row(cells):
    return "| " + " | ".join(str(c) for c in cells) + " |"

action_rows = "\n".join(
    table_row([CN.get(k, k), n(by_action.get(k, 0)), f"{pct(by_action.get(k,0), total_actions):.2f}%"])
    for k in ORDER if k in by_action)
hour_rows = "\n".join(
    table_row([f"{h.get('hour',0):02d}:00", n(h.get("judged")), n(h.get("driving")),
               n(h.get("redLightWaits")), n(h.get("yields")), n(h.get("wading")),
               n(h.get("stranded")), n(h.get("injured")), n(h.get("dead")),
               n(h.get("evacuated")), n(h.get("maxDepthCm"))])
    for h in hourly)

imgs = [f"![{cap}](两周汇报配图/{name})\n\n*{cap}*" for name, _, cap in FILES]
last_sync = (d.get("last") or {}).get("tMinSync", "—")

md = f'''# 两周工作汇报 · 数据与计划

> 展示用。正文只放数据和计划，不放讲稿、路径、命令、验收人数。
> 所有数据的真实出处统一写在文末「附录：数据来源」。

## 一、做了什么

| 项 | 内容 |
|---|---|
| 城市 | 华盛顿特区 5,978 × 5,120 m 全城，真实测绘地形、建筑、门牌、路网、水体 |
| 人 | 按美国人口普查局 ACS 真实个体记录抽，年龄／性别／职业／家庭／通勤／车联合一致；全城逐人实时 |
| 一天 | 按 FHWA 全国出行调查的真实加权分布排日程；官方每人每天 2.28 次出行，不是固定几个节点 |
| 判断 | 每 0.5–1 仿真秒一次「现在该干什么」，四层离散选择，系数全部来自实测论文 |
| 水 | 二维浅水方程离线算好一整天的水深帧，网页与人只查表；雨和排水同一小步一起算 |
| 车 | 绑定真实车主，右侧通行、红绿灯、让行、限速、跟车、积水熄火，车是代步工具 |
| 时钟 | 人、车、水、判断、动作、伤亡共用一根 0:00 → 24:00 的轴；×24 只是多算子步 |
| 事故 | 记录带人、时刻、坐标、水深、原因；伤亡判定明确标注哪些是实测分级、哪些是自己定的 |

{imgs[0]}

## 二、全天连续运行的数据

> 下表是**模型跑出来的数，不是实测**。模型替换后旧一批数字已整批作废，这里是全量重跑的结果。

| 指标 | 值 |
|---|---|
| 快层判断总数 | **{n(judged)}** 次 |
| 有效帧 / 墙钟 | {n(d.get("frames"))} 帧 / {n(d.get("wallSec"))} 秒 |
| 页面脚本错误 | {len(d.get("pageErrors") or [])} |
| 无依据改道 | {n(d.get("unjustified"))} 次（应接近 0） |
| 积水与时钟同层 | {"是" if last_sync is True else last_sync} |
| 圈层种类 | {n(C.get("distinctCircles"))} 种，最大一种 {n(C.get("largestCircle"))} 人 |
| 决定开车 / 到达下车 | {n(D.get("driveChosen"))} / {n(D.get("arrivals"))} 次 |
| 累计行驶 | {(D.get("carKm") or 0):.1f} km |
| 等红灯 / 礼让行人 | {n(I.get("redLightWaits"))} / {n(I.get("yields"))} 次 |
| 车辆熄火 / 弃车 | {n(I.get("stalled"))} / {n(I.get("abandonedCar"))} |
| 困死 / 累计被困 / 累计受伤 | {n(I.get("dead"))} / {n(I.get("everStranded"))} / {n(I.get("everInjured"))} 人 |
| 若计非溺亡（文献比例外推，不是模型算的） | 约 {round((I.get("dead") or 0) / 0.676)} 人，其中非溺亡约 {round((I.get("dead") or 0) * 0.324 / 0.676)} 人 |
| 避险成功 / 水位退下脱困 | {n(I.get("evacuated"))} / {n(I.get("rescued"))} 人 |
| 事件最深水 | {n(round((I.get("maxDepth") or 0) * 100))} cm |

**各动作占全天判断的比例**

| 动作 | 次数 | 占比 |
|---|---|---|
{action_rows}

{imgs[1]}

**逐时曲线**

| 时刻 | 累计判断 | 在开车 | 等红灯 | 礼让 | 涉水 | 被困 | 受伤 | 死亡 | 避险 | 最深水 cm |
|---|---|---|---|---|---|---|---|---|---|---|
{hour_rows}

## 三、判断是怎么算出来的

选择层按概率抽样，没有「威胁超过阈值才放开动作池」的二元开关。系数、符号、显著性照抄原文；不显著的系数不接入。下面四层里，前两层是有序 logit 的**线性预测子**，只作先验，不是行动概率。

```text
认知层  情境知识 = 0.571×官方预警 + 0.147×预警信息 + 0.493×女性
                 − 0.648×意外 − 0.078×洪水影响 + 既往洪水次数分档系数
        （有序 logit 预测子，Table S2 未印阈值，不输出绝对概率）
行动层  感知减损行为评分 = 0.296×情境知识 − 0.012×年龄 + 0.212×既往洪水次数
                          − 0.248×意外 − 0.28×水深有序编码
        （因变量是「觉得减灾措施有没有用」，不是「撤不撤离」）
选择层  V_疏散 = 4.22 − 3.71×成本 − 1.27×同伴乘车 − 0.02×旅行时间
                − 0.03×等待时间 − 1.08×步行距离 + 0.21×标准化年龄
                + 随机参数偏差 + 威胁等级主效应
        V_留下 = 7.76×同伴留下比例 + 威胁等级交互项
                （moderate −9.27、extreme −21.13：危险越大从众越弱）
        P(启动保护) = 1 / (1 + exp(−V))，V = (V_疏散 − V_留下)×0.25
                      + 认知／行动先验 + 威胁等级主效应
时间层  P_动员(t) = 1 − exp(−(t/bm)^(2/am))，Silva 2025 补充材料 Eq.(S2)
        运行时概率用 Table S2 印刷的 8 / 24 / 72 小时实测值 88.8 / 95.7 / 98.6%
最终    P(启动保护) = P(启动保护) × 水深暴露权重 × 动员率
        水深暴露权重按 Table S1 的 1–7 有序编码归一，没水时为 0
```

- 水深用 Thieken 2023 补充材料 Table S1 印刷的 1–7 有序编码（1 无水 / 3 ≤0.5 m / 4 >0.5–1 m / 5 >1–2 m / 6 >2–4 m / 7 >4 m），不是自己定的厘米阈值。
- 属性量纲按 Borowski 2023 Table 3 的实验设计范围归一化：Cost 0–40 美元、时间 0–60 分钟、步行距离 0–0.5 英里；绕路距离按该文实测的 32.78 美元/英里换算。
- 选完之后「绕哪条街 / 等在哪 / 走多快」是路径执行，由真实几何与实测步速决定，不再是一个行为决策模型。
- 绝对概率还受几个自设缩放影响（认知层 0.50、行动层 0.80、效用 0.25、威胁主效应、暴露起点 0.15），全部集中登记并做敏感性分析；实测动员率整体 ×0.5 / ×1.5 时保护概率分别下降 / 上升，方向稳定。

{imgs[2]}

{imgs[3]}

## 四、依据与限制

| 类别 | 本项目里的内容 |
|---|---|
| 真实数据集 | 人口画像（ACS 2020–2024 DC 微观样本）、日常出行（2022 NHTS）、城市环境（USGS / DCGIS / OSM / NOAA） |
| 文献里的实测值 | 四层决策系数、年龄别步速、涉水步速与通行能力、危险分级限值、车辆漂浮深度 |
| 模型跑出来的数（不是实测） | 第二节全部数字、动作分布图；不能当研究结论的证据 |
| 目前自己定的 | 认知层与效用层的量纲缩放、威胁等级主效应、属性归一化、时段分档、暴露耐受时长、滑倒／被困／弃车时长 |

**明确说明**：有序 logit 的阈值四轮检索都没有公开；「水深 → 涉水／绕行／等待」的三分选择实验没有原始实测比例；「失稳 → 伤亡」没有定量函数。所以由这些自设项算出的伤亡／被困数是模型输出，交付时必须附敏感性分析，不能当实测结论。

### 水是怎么算的

{imgs[4]}

## 五、下一步计划

1. 向三篇论文通讯作者索取原始微观数据与有序 logit 阈值，拿到后自己重新拟合，删掉剩下的自设缩放。
2. 把「同伴留下／撤离比例」从周围人的真实状态统计出来（公开定义已拿到：自我中心网络最多 5 人）。
3. 做可追溯的个案回放：从一条事故记录反查那个人逐帧的位置、水深、每次判断与动作；加缩小区域开关。
4. 按方法学文献补上对照基线、留出验证集、消融与统计检验，回答「问题是什么、别人怎么做、怎么验证我们的方法更好」。
5. 继续划清内核与显示层边界，做离线跑一晚存快照的两轨方案与分片并行。

---

## 附录：数据来源

**真实数据集／官方文件**

| 来源 | 出处 |
|---|---|
| 人口画像 | U.S. Census Bureau, American Community Survey 2020–2024 5-Year PUMS, District of Columbia，2026-03-05 发布，`www2.census.gov/programs-surveys/acs/data/pums/2024/5-Year/`；人表 `csv_pdc.zip`、户表 `csv_hdc.zip`、字典 `PUMS_Data_Dictionary_2020-2024.csv` |
| 日常出行 | U.S. Federal Highway Administration / Oak Ridge National Laboratory, 2022 NextGen NHTS V2.1，Codebook V2.1（2025-04）、V2.1 Release Notes（2025-04）、*2022 Summary of Travel Trends*，`nhts.ornl.gov/downloads` |
| 城市环境 | USGS 3DEP 地形、DCGIS 下垫面与门牌、OpenStreetMap 路网、NOAA 潮位；逐文件出处见《数据来源》清单 |

**文献里的实测值／系数表**

| 来源 | 出处 |
|---|---|
| 情境知识与感知减损行为有序 logit | Thieken, A. H. et al. (2023), "Performance of the flood warning system in Germany in July 2021", *Natural Hazards and Earth System Sciences* 23:973–990, DOI 10.5194/nhess-23-973-2023；补充材料 Table S1/S2/S3, DOI 10.5194/nhess-23-973-2023-supplement |
| 疏散选择与同伴效应 | Borowski, E. & Stathopoulos, A. (2023), "Protection or Peril of Following the Crowd in a Pandemic-Concurrent Flood Evacuation", *Natural Hazards Review* 24(1):04022045, DOI 10.1061/(ASCE)NH.1527-6996.0000577, Table 3 / Table 4 |
| 警告扩散与动员曲线 | Silva, A. F. R. et al. (2025), *NHESS* 25:1501–1520, DOI 10.5194/nhess-25-1501-2025；补充材料 Eq.(S1)/(S2) 与 Table S2, DOI 10.5194/nhess-25-1501-2025-supplement |
| 年龄别舒适步速 | Bohannon, R. W. & Andrews, A. W. (2011), "Normal walking speed: a descriptive meta-analysis", *Physiotherapy* 97:182–189, Table 2 |
| 无阻自由步速 | Weidmann, U. (1993), *Transporttechnik der Fussgänger*, IVT Schriftenreihe Nr. 90, ETH Zürich |
| 涉水步速与通行能力 | Li, X. et al. (2026), *Journal of Hydrology* 672:135395, DOI 10.1016/j.jhydrol.2026.135395 |
| 行人危险分级与 HR | Cox, Shand & Blacka (2010), ARR Project 10 Stage 1 Report P10/S1/006, UNSW WRL；H1–H6 见 Smith, Davey & Cox (2014), WRL TR 2014/07；DEFRA / Environment Agency (2006), FD2321/TR2 与 (2008) 补充说明 FD2321/TR1 Table 3.1 |
| 车辆涉水 | Smith et al. (2017), WRL Technical Report 2017/07, UNSW, DOI 10.26190/unsworks/27416 |
| 行人让行研究（只存档，未接入判定） | Fitzpatrick et al. (2006), NCHRP Report 562 / TCRP Report 112, Transportation Research Board |
| 外部对照（只存档，不进效用） | Ahsanuzzaman & Messer (2021) *JFRM* 14(4):e12753 Table 3；Ha, Dinh & Mizunoya (2025) *IJDRR* 119:105315 Table 5；Xu et al. (2026) *JFRM*, DOI 10.1111/jfr3.70272 Table 3；Arshaghi et al. (2026) *NHESS* 26:981–1000 Table 2 |
| 方法学与验证口径 | Grimm et al. (2005) *Science* 310:987–991；Grimm et al. (2006/2010) *Ecological Modelling*；Windrum, Fagiolo & Moneta (2007) *JASSS* 10(2):8；Tang et al. (2026) *Nature Sustainability* 9:1569–1581 补充信息 Table 3 |

**模型跑出来的数（不是实测）**：第二节全部数字、动作分布图、保护行动概率。
**目前自己定的**：第四类列出的缩放系数、工程映射与阈值，逐条待补依据见《待补依据清单》。
'''
MD_PATH.write_text(md, encoding="utf-8")

# ---------------------------------------------------------------- 预览页
cards = "\n".join(
    f'<section><h2>{cap}</h2><img src="{name}" alt="{cap}"/></section>'
    for name, _, cap in FILES)
preview = f'''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>两周工作汇报 · 五张配图</title>
<style>
body{{margin:0;padding:32px;background:#f4f7fa;color:#1f2933;font-family:"Microsoft YaHei","PingFang SC",sans-serif}}
h1{{font-size:26px;margin:0 0 6px}} p{{color:#5b6b77;margin:0 0 26px}}
section{{background:#fff;border:1px solid #d9e2ea;border-radius:10px;padding:18px;margin-bottom:22px}}
h2{{font-size:16px;font-weight:600;margin:0 0 12px;color:#1d6fb8}}
img{{width:100%;height:auto;display:block}}
</style></head><body>
<h1>两周工作汇报 · 五张配图</h1>
<p>点击单张图片可单独保存。数据与配图由新的全量仿真结果生成，旧数字已作废。</p>
{cards}
</body></html>'''
(OUTDIR / "预览.html").write_text(preview, encoding="utf-8")

print("数据：", DATA)
print("汇报 MD：", MD_PATH)
print("配图目录：", OUTDIR)
print("判断总数：", n(judged), "| 动作种类：", len(items), "| 逐时行：", len(hourly))
