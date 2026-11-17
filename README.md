# Urban-simulation

> 华盛顿 DC 城市仿真（内涝仿真前序场景层）。**先读 [项目总览.md](项目总览.md)** —— 这是**交接书**：现状、代码地图、数据台账、排水模型口径、验收、待办、红线、命令全在里面。

## 最短上手

```bash
cd web
D:\AI\node.exe serve.js 8123        # 浏览器 http://127.0.0.1:8123/
# 全城演示：数字键 1–0 切机位，F 键开关积涝
# 单人个体追踪：http://127.0.0.1:8123/office.html
```

## 单人个体追踪（当前阶段）

`district.html` 是多人版：同一场暴雨、同一个时钟，七个身份不同的人各自行动——办公楼里的职员和老板、正在做手术的医生、基坑里的钢筋工、咖啡店店员、戴耳机没收到预警的外卖骑手、被老师带着上楼的小学生。每个人只使用自己收到的信息和熟悉的路线；四座新建筑（Pavilion 咖啡馆、社区医疗中心、特许学校、10th St 工地）都可以走进去。

`office.html` 只追踪一个角色：36 岁项目职员马克·詹森。17:52 他坐在 FAA 办公楼 6F 工位，收到手机洪水预警后先打电话、交接工作、收电脑取伞；走楼梯下楼，穿过楼前停车场走到自己车边上车；沿 12th St 开到淹水路段（前方 0.44 m）停车掉头，改走 6th St；到 565 Penn 公寓楼下靠边停车，进大堂、乘电梯上 9F、进自家门到家。他只使用已收到的信息、熟悉的路线和现场看到的水，不读取全局最优避难答案。办公楼、停车场、公寓的室内外、车辆与逐帧状态都由本仓库代码生成；原有 3000 人全城演示保留在 `/`。

## 目录

- `项目总览.md` — 唯一入口文档（交接书）
- `行人Demo-计划表.md` — 行人 Demo 验收标准原文（B 线已冻结）
- `历史文档-原文存档.md` — 15 份旧文档逐字原文
- `web/` — 当前主线（Three.js 实时城市场景）
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