# 条1 · Thieken 2023 有序 logit 阈值（cut points）与调查微观数据

（第六轮回件，2026-11-16。内容为检索原件的逐字抄录与出处标注；标「没有」者附检索记录。）

## 条 1 · Thieken et al. 2023 有序 logit 的 cut points / 调查微观数据存放处

目标文献：Thieken, A. H., Bubeck, P., Heidenreich, A., von Keyserlingk, J., Dillenardt, L., Otto, A., "Performance of the flood warning system in Germany in July 2021 – insights from affected residents", *Natural Hazards and Earth System Sciences* 23:973–990, 2023. DOI 10.5194/nhess-23-973-2023。调查为 2021 年 7 月洪水后在线调查，摘要口径 n = 1315（NW 与 RP 两州）[索引，文章摘要]。

### 结论：没有（cut points 与微观数据两个分支均没有）

### 1.1 cut points 的新路径检索结果（逐项）

- **GESIS 数据目录（search.gesis.org）**：检索词 "Thieken"，研究数据（Research data）类**零命中**，页面原文："To your query "Thieken" we did not find results in the category "Research data""（仅 Publications 类 3 条）[全文-目录页]。检索词 "Hochwasser 2021" 命中的研究数据为 ZA7824（Trend Questions (October 2021): Climate Change Impacts，Kantar/联邦政府新闻局，doi:10.4232/1.13901）、ZA8799（Environmental Consciousness in Germany 2020）、ZA5664/ZA5665（GESIS Panel），均非该调查，无 ZA 编号对应 Thieken 团队 2021 洪水预警调查 [索引]。
- **Zenodo**：API 以 creators.name:"Thieken" 检索，共 4 条记录：10.5281/zenodo.6426825（急救派遣数据与 R 代码）、10.5281/zenodo.18694338（高温风险感知调查，Otto/Heidenreich 等）、10.5281/zenodo.15574535（209 个德国市镇气候数据）、10.5281/zenodo.14447432（期刊 Preface）。无 2021 洪水预警调查数据 [索引]。
- **DataCite 全量聚合检索**（query=creators.name:Thieken，共 107 条，其中 resourceTypeGeneral = Dataset 共 17 条）：Dataset 逐条为——GFZ Data Services：10.5880/fidgeo.2017.015（Braunsbach 2016 山洪损害评估数据收集）、10.5880/gfz.1.4.2023.003（Eifel Flood 2021 机载激光扫描与正射影像）；Zenodo 上列 3 项；4TU.ResearchData：10.4121/8f7a21d3-…（Ahr 河谷建筑损害遥感制图）；Mendeley Data 3 项（城市增长/元胞自动机）；figshare 1 项（社区预警系统论文补充材料）。**无该调查的微观数据记录** [索引]。
- **OSF**：OSF API 搜索端点返回 Not found、SHARE 接口只返回应用外壳，未能机器检索；以网页检索 "osf.io Thieken flood survey" 未见该调查的 OSF 项目/数据页 [索引]。
- **GFZ / Potsdam 机构库**：gfzpublic 与 dataservices.gfz-potsdam.de 检索仅见上列 Eifel Flood 2021 ALS 数据集（Thieken 为共同作者，数据类型为激光扫描/影像，非调查数据）；publishup（波茨坦大学库）经 DataCite 命中该团队报告若干（10.25932/publishup-71269、10.25932/publishup-69417 等），无调查数据文件 [索引]。
- **作者 GitHub**：GitHub 仓库检索 "thieken" 共 3 条，均与该团队无关（课程/实验室练习仓库）；检索 "hochwasser befragung" 0 条 [索引]。
- **作者对评审的回复文件**（Copernicus 编辑站公开文件 "Responses_NHESS_Warning2021_FINAL"，6 页，已存 files-A/thieken2023-reviewer-responses.pdf）：全文文本检索 "cut"、"threshold"、"intercept" 均无命中；唯一 "constant" 命中为 "variables in the model are held constant"。该文件 Response 15 仅讨论有序 logit 的解释方式，未印阈值 [全文]。
- **使用同一调查/同一团队问卷的后续论文附录**：
  - Murdock, H. J., Rodriguez Castro, D., Dewals, B., Heidenreich, A., Thieken, A. H., "Learning from the past to inform flood risk management: Analysis of public survey data in Belgium on flood early warning and response during the July 2021 flood", EGUsphere 预印本，DOI 10.5194/egusphere-2025-6376（比利时 Wallonia 样本，n = 550，同团队问卷）：正文方法为 "logistic and linear regression models"，其补充材料（egusphere-2025-6376-supplement.pdf）为问卷全文（S1. Questionnaire），未重印 Thieken 2023 的 S2/S3 有序 logit 输出 [索引]。
  - Silva, A. F. R., Eleutério, J. C., Apel, H., Kreibich, H., "Assessing the impact of early warning and evacuation on human losses during the 2021 Ahr Valley flood in Germany using agent-based modelling"（NHESS 预印本 nhess-2024-183）：用该调查的汇总比例（如 "Only 17.5 % of those affected received a warning with evacuation instructions"）设定 LifeSim 的 FEWE 时间线，未印有序 logit 阈值 [摘要]。
  - Rhein, B. & Kreibich, H. (2025), "Causes of the exceptionally high number of fatalities in the Ahr valley, Germany, during the 2021 flood", *Nat. Hazards Earth Syst. Sci.* 25:581–589, DOI 10.5194/nhess-25-581-2025：数据为科布伦茨检察官办公室死亡调查档案，非该调查，无回归附录 [摘要]。
  - Thieken et al. 2026（*Earth's Future*，死亡个案重建）：非该调查微观数据（第四轮 §B4 已核）。

### 1.2 微观数据存放处

没有公开存放处。正文 Data availability 原文逐字（文章 XML [全文]，已存 files-A/thieken2023-nhess.xml）：

> "Data availability. The survey data are owned by the authors and can currently be provided upon reasonable request only. The supplement related to this article is available online at: https://doi.org/10.5194/nhess-23-973-2023-supplement."

### 1.3 最接近的相关内容（同事件、同团队口径的调查数据公开声明）

Ommer, J., et al., "Surprise floods: the role of our imagination in preparing for disasters", *Nat. Hazards Earth Syst. Sci.* 24:2633–2646, 2024, DOI 10.5194/nhess-24-2633-2024（2021 洪水受影响地区半结构化在线调查）。其 Data availability 原文逐字 [全文-文章 XML 摘录]：

> "The participants of this study did not give written consent for their data to be shared publicly, so due to the sensitive nature of the research, the survey data is not available."

---

