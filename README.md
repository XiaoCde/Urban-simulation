# Urban-simulation

> 华盛顿 DC 城市仿真（内涝仿真前序场景层）。**先读 [docs/交接速览_2026-11-19.md](docs/交接速览_2026-11-19.md)**（哪些数能用、代码怎么分、我犯过哪些错），再读 [项目总览.md](项目总览.md)（完整交接书：代码地图、数据台账、排水模型口径、验收、待办、红线、命令）。

## 最短上手

```bash
cd web
D:\AI\node.exe serve.js 8123        # 浏览器 http://127.0.0.1:8123/
# 全城演示：数字键 1–0 切机位，F 键开关积涝
# 单人个体追踪：http://127.0.0.1:8123/_legacy/office.html
```

## 单人个体追踪（当前阶段）

`_legacy/district.html` 是多人版（已归档，非当前主线）：同一场暴雨、同一个时钟，七个身份不同的人各自行动——办公楼里的职员和老板、正在做手术的医生、基坑里的钢筋工、咖啡店店员、戴耳机没收到预警的外卖骑手、被老师带着上楼的小学生。每个人只使用自己收到的信息和熟悉的路线；四座新建筑（Pavilion 咖啡馆、社区医疗中心、特许学校、10th St 工地）都可以走进去。

`_legacy/office.html` 只追踪一个角色（已归档，非当前主线）：36 岁项目职员马克·詹森。17:52 他坐在 FAA 办公楼 6F 工位，收到手机洪水预警后先打电话、交接工作、收电脑取伞；走楼梯下楼，穿过楼前停车场走到自己车边上车；沿 12th St 开到淹水路段（前方 0.44 m）停车掉头，改走 6th St；到 565 Penn 公寓楼下靠边停车，进大堂、乘电梯上 9F、进自家门到家。他只使用已收到的信息、熟悉的路线和现场看到的水，不读取全局最优避难答案。办公楼、停车场、公寓的室内外、车辆与逐帧状态都由本仓库代码生成；原有 3000 人全城演示保留在 `/`。

## 目录

- `项目总览.md` — 唯一入口文档（交接书）
- `历史文档-原文存档.md` — 15 份旧文档逐字原文（264 KB）
- `docs/` — 27 份专项文档，分类见交接速览 §四
- `web/` — 当前主线（Three.js 实时城市场景）
  - `src/` — 运行时内核与显示层（`src/kernel/` 纯计算，不碰 window / three）
  - `assets/` — 场景资源与积涝帧（生成产物，不进版本库）
  - `tests/` — 验收与回归脚本（40 个），`cd web && npm test` 跑其中 13 个纯 Node 自检，例：`node tests/check-floors.mjs`
  - `sim/` — 连续 24h 仿真与多工况并行（`sim-day.mjs`、`sim-sweep.mjs`、`sweep-report.mjs`）
  - `devtools/` — 一次性开发脚本：`probes/` 探针、`shots/` 截图、`diag/` 诊断、`misc/` 其他
  - `out/` — 仿真输出；`serve.js` — 静态服务（启动脚本引用，位置不变）
  - 2026-11-17 归组前这 104 个脚本全堆在 `web/` 根目录，新旧名对照见 `docs/脚本归组映射.md`
- `tools/` — 数据、模型、报告工具，分组说明见 `tools/README.md`。**下划线开头的（`_probe_*`、`_inspect_*`、`_bbox_ll.py` 等）是开发期一次性探测脚本，与交付无关，可忽略**
- `tools/flood/` — 排水与内涝模型，两套内核并存：
  - `simple_drainage.py` + `street_net.py` — 旧内核（fill-and-spill 填洼 + 一维街网），快、稳，但出不了路面连续水膜
  - `shallow2d.py` + `swe_numba.py` — **新内核**（二维浅水 inertial），路面上有连续水流；4 m 网格 6 h 工况约 4 min
  - `scenarios.py` — 情景库批量；`calibrate.py` 率定框架；`view_sw2d.py` / `plot_coupling.py` 出图
- `data/derived/` — 数据契约产物（DTM/DSM/下垫面/水体/建筑）
- `data/flood/tide/` — NOAA 8594900 实测水位过程线（Isabel 2003 / 2006-06）

新内核最短用法：

```bash
python tools/flood/shallow2d.py --res 4 --p-mm-h 110 --dur-h 2 --tail-h 10 \
    --surge-series data/flood/tide/isabel_2003.json --surge-t0-h 48 \
    --frames --out data/flood/sw2d_isabel
```

`--frames` 直接产出 `frames/*.u8 + manifest.json`，拷到 `web/assets/flood/<名字>/` 就能在网页 `#flCase` 里选到。


旧 md 已合并进总览；需要原文去 `历史文档-原文存档.md`（git 旧历史已于 2026-10-24 清空，`5931cd3` 不存在了）。