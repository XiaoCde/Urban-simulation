# DTG 论文：五类基线设定与 JSD / diff-ACC 定义（第六轮补件，对应待补清单 §二.6）

来源：Zhang, Z., Huang, F., Tang, J., Zhao, P., "Reconstructing flood-induced human mobility using LLM agent with disaster context adaptation", *Transportation Research Part D* 162 (2027) 105685. DOI 10.1016/j.trd.2026.105685，PII S1361920926004773。
全文 PDF 由 James 经西安交通大学图书馆下载，2026-11-16；原件同存本目录（DTG-Zhang-2027-TRD-105685.pdf）。
以下为 §4.3（期刊第 11 页）原文逐字抄录；公式有无已经全文检索 + 原页影像核对。

## 1. 五类基线设定（§4.3，原文）

> "Baselines. We compare against rule-driven and LLM-driven agent-based approaches that require minimal real trajectory data. Rule-driven baselines include Random Walk (Rhee et al., 2011), Gravity Model (Truscott and Ferguson, 2012), and Markov Model (Qiao et al., 2018). LLM-driven baselines include LLM-Mob (Wang et al., 2023), which models spatiotemporal dependencies, and CoPB (Shao et al., 2024), which combines chain-of-thought reasoning with geographic information."

五类即：Random Walk、Gravity Model、Markov Model（规则驱动三类）；LLM-Mob、CoPB（LLM 驱动两类）。

输入接口与共同评估条件（§4.3，原文）：

> "Baselines operate within their native information interfaces. Rule-driven baselines use the structured inputs represented by their predefined transition, distance-decay, or historical-pattern mechanisms; they cannot directly take POI semantics and unstructured disaster text information as input. LLM-driven baselines are provided with POI information, disaster context, shelter information, and flood-affected areas through the input formats supported by their original frameworks. Because their prompting, architecture, and decision pipelines differ, these shared inputs are not processed through an identical end-to-end interface. All methods are evaluated in the same Zhengzhou study area, time period, initial spatial distribution, POI database, trajectory scale, 1-km evaluation grid, and metric system."

各基线自身的参数取值：论文没有逐一给出，只写明各基线按其原始框架（native interfaces / original frameworks）运行。

## 2. JSD 公式

**论文没有印出 JSD 的公式**（§4.3 只有命名与口径，对数底未注明）。原文：

> "Statistical metrics: JSD-inflow/outflow (grid-level flow divergence), JSD-OD (OD distance distribution divergence), and flow Correlation (Corr.)."

## 3. diff-ACC 公式

**论文没有印出 diff-ACC 的公式**，只有文字定义（§4.3，原文）：

> "Disaster-adaptation metric (diff-ACC): a noise-filtered classification accuracy measuring agreement between modeled and observed inflow-change patterns (increase vs. decrease) across grid cells during the disaster-phase transition. This metric directly captures whether the model reproduces the directional flow reorganization induced by the flood, beyond pure distributional similarity."

定义要素：对象 = 各网格（1 km）流入量在灾前→灾中相位转换期的变化方向（increase vs. decrease）；模型与观测方向一致的分类准确率；带 noise filtering，但**过滤的阈值数值文中没有给出**（全文检索无阈值数字）。

## 4. 结果表数值（Table 1、Table 2，已与原页核对）

Table 1（Before vs. During；JSD 越小越好）：

| Model | JSD(inflow) 前/灾中 | JSD(outflow) 前/灾中 | JSD(OD) 前/灾中 | Corr. 前/灾中 | Semantic 前/灾中 |
|---|---|---|---|---|---|
| RandomWalk | 0.0868 / 0.0945 | 0.0991 / 0.0784 | 0.0464 / 0.0801 | 0.7012 / 0.6805 | 0.4313 / 0.5288 |
| GravityModel | 0.1021 / 0.1193 | 0.1076 / 0.1061 | 0.0551 / 0.0900 | 0.7145 / 0.6035 | 0.4643 / 0.4005 |
| MarkovModel | 0.0840 / 0.1044 | 0.0855 / 0.0978 | 0.0452 / 0.0702 | 0.6902 / 0.6871 | 0.5008 / 0.4565 |
| LLM Mob | 0.1174 / 0.0944 | 0.0954 / 0.0863 | 0.0651 / 0.0677 | 0.7153 / 0.7202 | 0.6330 / 0.6465 |
| CoPB (LLM) | 0.0762 / 0.1185 | 0.0785 / 0.1053 | 0.0326 / 0.0938 | 0.8203 / 0.7951 | 0.7455 / 0.7021 |
| DTG (Ours) | 0.0603 / 0.0707 | 0.0528 / 0.0690 | 0.0263 / 0.0476 | 0.882 / 0.8667 | 0.7633 / 0.7318 |

Table 2（diff-ACC，灾中相对灾前的差分）：RandomWalk 0.4943；GravityModel 0.4391；MarkovModel 0.5013；LLM Mob 0.6013；CoPB 0.5356；DTG 0.7134。

其他相关原文数字：评估用手机信令数据约 13.2 亿条（郑州 2021-07-13 至 07-19 灾前、07-20 至 07-23 灾中），聚合到 1 km 网格、小时级 OD（§4.2）；每场景建模 10,000 条轨迹（§4.4）。

## 5. 数据可得性（原文）

> "Data availability — Data will be made available on request."

论文未给代码仓库链接。
