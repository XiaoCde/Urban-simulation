# 条6 · Jonkman 水深→死亡率函数原文参数（含对第五轮的纠正）

（第六轮回件，2026-11-16。内容为检索原件的逐字抄录与出处标注；标「没有」者附检索记录。）

## 条6 · Jonkman 水深→死亡率函数的原文参数

**结论：找到。**[全文]

### 文献

1. Jonkman, S. N. & Vrijling, J. K. (2008). "Loss of life due to floods." *Journal of Flood Risk Management* 1(1): 43–56. DOI: 10.1111/j.1753-318X.2008.00006.x。公开 PDF 为作者 TU Delft 员工页副本：https://filelist.tudelft.nl/CiTG/Over%20faculteit/Afdelingen/Hydraulic%20Engineering/Hydraulic%20Structures%20and%20Flood%20Risk/staff/Jonkman_SN/jfrm6.pdf（已存 files-D）。[全文]
2. Jonkman, S. N. (2007). *Loss of life estimation in flood risk assessment: Theory and applications.* PhD thesis, Delft University of Technology（2007-06-18 答辩），ISBN 978-90-9021950-9，354 pp。机构库记录：https://repository.tudelft.nl/record/uuid:bc4fb945-55ef-4079-a606-ac4fa8009426 （旧 assets 直链现返回 HTML；本轮全文 PDF 取自公开镜像副本，题名页/ISBN 与机构库记录一致，已存 files-D）。[全文]

### JFRM 论文正文中的呈现方式

JFRM 论文第 51–53 页（方法节 "A new method for the estimation of loss of life due to floods"）只给出三区定义与 Figure 6–8 的函数曲线，**未在正文印出解析式参数**，图注均标注来源 "(Jonkman, 2007)"。正文可抄录的数值只有分区阈值：涨水区判据 "A location is assumed to be in the zone with rapidly rising water if the rise rate exceeds 0.5 m/h"（p. 51）；remaining zone 典型水深 0–4 m 时死亡率 "generally between 0 and 0.01"（p. 52）。解析式与参数在博士论文第 7 章，如下。

### 博士论文 §7.4 原文（逐字抄录；原文用欧式小数逗号，下式照印）

**(1) Breach zone（溃决区）—— §7.4.3，pp. 202–204；汇总 §7.4.8，p. 214**

建筑物完全摧毁判据（Eq. 7-3，p. 203；原文引 Clausen (1989)，并由 RESCDAM 研究 Karvonen et al. (2000) 支持）：

> "Total destruction of masonry, concrete and brick houses occurs if the product of water depth and flow velocity exceeds the following criteria simultaneously: **hv ≥ 7 m²/s and v ≥ 2 m/s** (Eq. 7-3)"

以此判据界定 breach zone 边界，区内死亡率假设（p. 203）：

> "it can be assumed that mortality in the breach zone equals **FD = 1**."

§7.4.8 汇总式（p. 214）："Mortality in the breach zone: FD = 1 if hv ≥ 7 m²/s and v ≥ 2 m/s"。
溃决区半径近似（Eq. 7-5，p. 203）：RC ≈ Qbreach /(π·hvc) = Cc·Qbreach，其中 "Cc - constant which equals: 1/(πhvc) = 0,045 s/m²"（hvc = 7 m²/s）。

**(2) Zone with rapidly rising water（快速涨水区）—— §7.4.4，p. 206**

> FD(h) = ΦN( (ln(h) − μN) / σN )  (Eq. 7-6)
> **μN = 1,46　　σN = 0,28**

（已对 PDF 第 206 页原页影像逐字核对。）拟合数据：Netherlands 1953（12 个地点）、UK 1953（1）、Japan 1959（2）；R² = 0,76（p. 207）。原文另注：50% 死亡率对应水深 4,3 m（= exp(μN)，p. 207）；同节指数型备选拟合 A = 4,57、B = 0,69（式 2-6 形式），R² = 0,74（p. 207）。脚注 25（p. 206）印出的 probit 形式常数照抄："constants a=-0,21; b=3,57 n=1 and Pr=a+b*ln(h)"。
分区阈值：该区地点涨水率均 ≥ 0,5 m/hr；0,5 m/hr 被提为涨水区与 remaining zone 的保守分界（原文同时写明按图 7-11 该阈值可取 0,5–4 m/hr 之间任意值，p. 205）。

**(3) Remaining zone（其余区）—— §7.4.5，p. 209**

> FD(h) = ΦN( (ln(h) − μN) / σN )  (Eq. 7-7)
> **μN = 7,60　　σN = 2,75**

（已对 PDF 第 209 页原页影像逐字核对。）拟合数据：93 个地点（Japan 1934、1950、1959，Netherlands 与 UK 1953，US 1965）；R² = 0,09；脚注 30 指数型备选 A = 12,4、B = 1,99，R² = 0,10（p. 209）。原文对该函数量级的说明："mortality … is generally between 0 and 0,02"（p. 209 讨论段）。

**(4) 适用条件汇总 —— §7.4.8，pp. 214–215（图 7-20）**

- 涨水区函数仅当其给出高于 remaining zone 的死亡率时使用，即条件：**h ≥ 2,1 m 且 w ≥ 0,5 m/hr，且不满足 breach 判据（hv < 7 m²/s 或 v < 2 m/s）**。
- 建筑质量修正（"improved building quality to current standards"，一阶估计，p. 214）：涨水区函数常数改用 **μN = 1,68、σN = 0,37**。
- Remaining zone 函数条件：**w < 0,5 m/hr，或（w ≥ 0,5 m/hr 且 h < 2,1 m），且不满足 breach 判据**。

### 与 UNSW WRL TR 2015/09 转引值的差异（显式标出）

| 项 | WRL TR 2015/09 转引（第四轮所记） | 原文（本轮核实） |
|---|---|---|
| remaining zone 参数 | μN = 2.00、σN = 5.20 | 所提方法 Eq. 7-7：**μN = 7,60、σN = 2,75**（论文 p. 209） |
| 5,20 / 2,00 这对数 | 记作 remaining zone 的 σN / μN | 是论文第 8 章 New Orleans 个案合并拟合 Eq. 8-4 的参数，且原文印作 **μN = 5,20、σN = 2,00**（Orleans 与 St. Bernard 两 bowl 其余地点，R² = 0,42，论文 p. 248）——与 WRL 的标注正好互换，且不是所提方法的参数 |
| breach zone | FD = 0.053 for h·v ≥ 5 | 所提方法：**FD = 1，条件 hv ≥ 7 m²/s 且 v ≥ 2 m/s**（Eq. 7-3，pp. 203、214）。0,053 的出处是论文 p. 248 对 St. Bernard bowl（Lower 9th Ward）溃决区的**实测平均死亡率 5,3%**，原文："In this area the (average) mortality was 5,3%. By approximation this breach zone was characterised by the following values of the depth velocity product: hv > 5 m²/s."——案例观测值，非函数常数 |
| Waarts 组合式 FD(h,v,TA) = (FD(h)+FD(v))(1−FE(TA)) | WRL 称其为 Jonkman & Vrijling (2008) Eq. 7 | 本轮所读 JFRM 全文与论文第 7 章的所提方法部分未出现该式；它属两文综述的早期方法（Waarts 1992 / Vrouwenvelder & Steenhuis 1997 一线），不在所提三区函数之内 |

附带抄录（个案拟合，非所提方法）：Orleans East bowl 拟合 Eq. 8-3：μN = 4,29、σN = 1,30，R² = 0,23（论文 pp. 247–248；原文注明该 bowl 未并入合并分析）。

---

