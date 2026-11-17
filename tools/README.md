# tools/ 工具目录说明

2026-11-17 整理。按用途分组，说明每个脚本是干什么的。这里只加说明，**不移动、不改名任何工具文件**——因为项目文档里写的是这些工具的精确路径，移动会断引用。

## 数据获取与原始数据处理

| 脚本 | 用途 |
|---|---|
| `fetch_*.py` | 从官方源抓取原始数据（OSM、DCGIS、ACS、NHTS 等） |
| `alias_blosm.py`、`clip_osm.py`、`add_dc_features.py` | OSM/Blender 城市模型的别名与裁剪 |
| `apply_dcgis_*.py` | 把 DCGIS 的真实高度、屋顶形状套到建筑上 |
| `convert_curves.py` | 曲线格式转换 |

## 地形 / 建筑 / 街道路网（`terrain/` 及根目录）

| 脚本 | 用途 |
|---|---|
| `terrain/build_dtm.py`、`build_dsm.py`、`build_landcover.py`、`build_water.py` | 从原始数据生成地形、地表覆盖、水体 |
| `terrain/export_web_*.py` | 导出到 `web/assets/` 供浏览器加载 |
| `terrain/fetch_dem.py`、`make_aitex.py` | DEM 下载、AI 贴图 |
| `build_city_drive_net.mjs`、`street_junctions.py`、`export_buildings.py` | 行车路网、路口、建筑轮廓 |
| `blender_*.py` | Blender 场景导出与探针（街道、雨伞、路面、角色） |

## 内涝模型（`flood/`）

| 脚本 | 用途 |
|---|---|
| `flood/shallow2d.py`、`swe_numba.py` | 浅水方程求解内核（含 numba 加速版） |
| `flood/simple_drainage.py`、`street_net.py` | 下渗/管网排水、街道汇流（有改动待提交时留意） |
| `flood/build_unified.py`、`scenarios.py`、`calibrate.py` | 统一工况生成、情景定义、参数率定 |
| `flood/export_web.py` | 导出帧序列到 `web/assets/flood/` |
| `flood/view_sw2d.py`、`plot_coupling.py`、`_preview.py`、`_probe_swe.py` | 可视化、耦合曲线、预览与探针 |

## 行人 / 疏散（`ped/`）

| 脚本 | 用途 |
|---|---|
| `ped/brain_test.mjs` | 决策模型离线测试 |
| `ped/export_ldt.py`、`export_ped_glb.py`、`export_walknet.py`、`export_office_worker.py` | 逃生余量表、行人模型、步行网络、办公人流 |
| `ped/make_lod.py` | 行人低模生成 |

## 数据导入导出（`data/`）

| 脚本 | 用途 |
|---|---|
| `data/import_acs.py`、`import_nhts.py` | ACS / NHTS 原始数据导入成 `data/real/*.json` |
| `data/export_kernel_data.py` | 内核用真实数据的导出 |

## 报告 / 文档（`report/` 及根目录）

| 脚本 | 用途 |
|---|---|
| `report/build_deliverables.py` | 从仿真 JSON 重建桌面汇报与配图 |
| `build_report_docx.py`、`make_*_sheet.py` | Word 报告、配图表格 |
| `extract_docs.py` | 把 `from muse/` 下的 PDF/DOCX/HTML 抽成纯文本到 `_text_all/` |
| `reorganize_web_scripts.py` | 2026-11-17 一次性脚本：web/ 下 104 个开发脚本归组与改名（已执行，保留备查） |

## 一次性探针与校验（根目录 `probe_*`、`diag_*`、`check_*`、`verify_*`、`repro_*.sh`、`regress.sh`）

这些是排查具体问题时写的，多数是一次性的。少数仍在用：`check_closed.py`、`check_features.py`、`check_osm.py`、`check_roof_match.py`、`check_root_motion.py`。

## 自检入口（2026-11-17 补）

`web/tests/` 下 40 个脚本里，13 个是纯 Node（不启浏览器），26 个是 Puppeteer 页面验收，另 1 个是总入口。改了内核或运行时代码，先跑总入口：

```bash
cd web
npm test          # 等价于 node tests/run-node-checks.mjs
```

总入口会把 13 个纯 Node 自检一次跑完并汇总退出码，**不启动服务、不写文件**。要看画面那类验收，按项目约定自己临时起 8140、跑完即关，例如 `node tests/check-replay-visible.mjs`；服务不常驻，所以总入口不自动代劳。

`tests/check-kernel-boundaries.mjs` 是 2026-11-17 新增的边界自检：一半断言钉住 28 组正常输入的黄金值（防「修边界改坏正常路径」），一半断言钉住 NaN／Infinity／空表／越界等病态输入（防崩溃与错误数字）。新增内核函数时，正常路径的黄金值要保持逐字段不变。

## 约定

- 生成产物（大文件）放 `data/`、`web/assets/`，不进版本库；工具只负责重建它们。
- 新增工具时按上表归到对应子目录；找不到归类的放根目录并在本表加一行。
- 改动 `tools/flood/simple_drainage.py`、`street_net.py` 这类被文档点名的文件，要同步更新 `docs/依据台账.md` 里的路径描述。
