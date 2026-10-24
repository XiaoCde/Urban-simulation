# -*- coding: utf-8 -*-
r"""生成组会汇报 Word 文档。

用法：
    <python> tools\build_report_docx.py
输出：
    D:\Users\asus\Desktop\项目\组会汇报-华盛顿建筑真实化-2026-10-16.docx
"""
import os

from docx import Document
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor

ROOT = r"D:\Users\asus\Desktop\项目"
FIG = os.path.join(ROOT, "out", "报告图")
OUT = os.path.join(ROOT, "组会汇报-华盛顿建筑真实化-2026-10-16.docx")

BODY_FONT = "微软雅黑"


def set_font(run, name=BODY_FONT, size=None, bold=None, color=None):
    run.font.name = name
    run._element.rPr.rFonts.set(qn("w:eastAsia"), name)
    if size is not None:
        run.font.size = Pt(size)
    if bold is not None:
        run.font.bold = bold
    if color is not None:
        run.font.color.rgb = RGBColor(*color)


def para(doc, text="", size=10.5, bold=False, align=None, space_after=6,
         space_before=0, line=1.4, color=None, indent=None):
    p = doc.add_paragraph()
    pf = p.paragraph_format
    pf.space_after = Pt(space_after)
    pf.space_before = Pt(space_before)
    pf.line_spacing = line
    if indent is not None:
        pf.left_indent = Cm(indent)
    if align is not None:
        p.alignment = align
    if text:
        set_font(p.add_run(text), size=size, bold=bold, color=color)
    return p


def heading(doc, text, size=13.5):
    p = para(doc, text, size=size, bold=True, space_before=14, space_after=6, line=1.2)
    return p


def picture(doc, path, width_cm, caption):
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.space_before = Pt(6)
    p.paragraph_format.space_after = Pt(2)
    p.add_run().add_picture(path, width=Cm(width_cm))
    c = para(doc, caption, size=9, align=WD_ALIGN_PARAGRAPH.CENTER,
             space_after=10, line=1.2, color=(0x59, 0x59, 0x59))


def table(doc, rows, widths=None, header=True):
    t = doc.add_table(rows=0, cols=len(rows[0]))
    t.style = "Table Grid"
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    t.autofit = False
    tblPr = t._tbl.tblPr
    layout = OxmlElement("w:tblLayout")
    layout.set(qn("w:type"), "fixed")
    tblPr.append(layout)
    for r_i, row in enumerate(rows):
        cells = t.add_row().cells
        for c_i, val in enumerate(row):
            cp = cells[c_i].paragraphs[0]
            cp.paragraph_format.space_after = Pt(2)
            cp.paragraph_format.space_before = Pt(2)
            cp.paragraph_format.line_spacing = 1.15
            set_font(cp.add_run(str(val)), size=9.5,
                     bold=(header and r_i == 0))
    if widths:
        grid = t._tbl.find(qn("w:tblGrid"))
        for gc, w in zip(grid.findall(qn("w:gridCol")), widths):
            gc.set(qn("w:w"), str(int(w * 567)))
        for i, w in enumerate(widths):
            t.columns[i].width = Cm(w)
        for row in t.rows:
            for i, w in enumerate(widths):
                row.cells[i].width = Cm(w)
        tw = OxmlElement("w:tblW")
        tw.set(qn("w:type"), "dxa")
        tw.set(qn("w:w"), str(int(sum(widths) * 567)))
        tblPr.append(tw)
    para(doc, "", size=6, space_after=2)
    return t


def build():
    doc = Document()

    st = doc.styles["Normal"]
    st.font.name = BODY_FONT
    st.font.size = Pt(10.5)
    st.element.rPr.rFonts.set(qn("w:eastAsia"), BODY_FONT)

    sec = doc.sections[0]
    sec.page_width, sec.page_height = Cm(21.0), Cm(29.7)
    sec.left_margin = sec.right_margin = Cm(2.4)
    sec.top_margin = sec.bottom_margin = Cm(2.2)

    # ---- 标题 ----
    para(doc, "组会汇报：华盛顿城市三维基座的建筑真实化", size=17, bold=True,
         align=WD_ALIGN_PARAGRAPH.CENTER, space_after=4, line=1.2)
    para(doc, "汇报人：      　　日期：2026 年 10 月 16 日　　范围：华盛顿市中心 4.4 km × 5.2 km",
         size=9.5, align=WD_ALIGN_PARAGRAPH.CENTER, space_after=12, line=1.2,
         color=(0x59, 0x59, 0x59))

    # ---- 一 ----
    heading(doc, "一、这次解决的问题")
    para(doc, "上次汇报后老师反馈建出来的城市「不像华盛顿」。查下来不是建模流程的问题："
              "城市骨架、道路、水系、建筑轮廓都建出来了，问题在建筑本身——模型里几乎全是等高的平顶方盒子。")
    para(doc, "这周做的事，就是把 OSM 里缺失的建筑高度和屋顶形状，用华盛顿特区官方公开的 DCGIS 数据补齐。"
              "补齐后同一套流程重新建模，市中心的连排屋终于能看出锯齿状的真实坡屋顶。")

    # ---- 二 ----
    heading(doc, "二、问题出在数据标签上")
    para(doc, "把这次范围内的 OSM 原始数据统计了一遍，2.19 万栋建筑的关键标签覆盖率是这样的：")
    table(doc, [
        ["标签", "含义", "有标签的栋数", "覆盖率"],
        ["height", "建筑高度", "213", "0.97%"],
        ["roof:shape", "屋顶形状", "48", "0.22%"],
        ["building:colour", "建筑颜色", "6", "0.03%"],
        ["building", "建筑轮廓（有即可建模）", "21,899", "100%"],
    ], widths=[3.2, 4.6, 3.2, 2.4])
    para(doc, "也就是说 99% 以上的建筑，建模软件只能用面板上的默认值：默认屋顶形状是 flat（平顶），"
              "默认高度按随机分配。所以不是插件算错了，是数据里本来就没有这些信息。")

    # ---- 三 ----
    heading(doc, "三、真实数据从哪来、怎么对上")
    para(doc, "华盛顿特区的建筑数据公开在 DCGIS 服务上（maps2.dcgis.dc.gov），用的是这三层：")
    table(doc, [
        ["DCGIS 图层", "内容", "用到的字段"],
        ["Planimetrics_2023 / 1\nBuilding Footprints", "2023 年实测建筑轮廓（2.27 万个多边形）", "OBJECTID"],
        ["Facility_and_Structure / 2\nBuildings - 3D", "2024 年激光雷达，每栋楼的 Z 统计", "MAX_Z、MEDIAN_Z、MIN_Z"],
        ["Facility_and_Structure / 13\nBuildings (Detailed Roof)", "屋顶坡度与形式（9 千条）", "SLOPE_MEAN、ROOF_TYPE"],
    ], widths=[5.4, 5.8, 3.4])
    para(doc, "难点在两边的建筑怎么对上。OSM 数据里没有 DCGIS 的编号，一开始只能靠几何位置猜测。"
              "后来发现一个确定性的对应关系：")
    para(doc, "Facility_and_Structure/1 的 OBJECTID，正好等于 Buildings - 3D 图层里 GIS_ID 的「BldgPly_<N>」那个 N；"
              "而 Planimetrics_2023/1 的 OBJECTID 与它 100% 重合（22,697 / 22,697 条全中）。"
              "于是用「建筑中心点落在哪个 2023 轮廓里」就能一步拿到真实高度，不需要做模糊的空间匹配，也不需要解算三维几何。",
         indent=0.6)

    # ---- 四 ----
    heading(doc, "四、屋顶形状怎么判")
    para(doc, "屋顶坡度图层只覆盖 9 千栋，而且它的编号体系跟轮廓图层对不上，得绕一层才能接到。"
              "剩下的一万多栋改用激光雷达的「屋顶最高点减中位高」，也就是屋顶相对屋面的隆起高度来推。规则如下：")
    table(doc, [
        ["判定依据", "结果"],
        ["有真实坡度，SLOPE_MEAN < 3°", "平顶 flat"],
        ["有真实坡度，形式为 Pyramid_Hip 或坡度 ≥ 15°", "四坡顶 hipped / 双坡顶 gabled"],
        ["有真实坡度，形式为 Saddle / Shed / Butterfly", "双坡顶 gabled"],
        ["无坡度，隆起 < 0.5 m", "平顶 flat"],
        ["无坡度，隆起 0.5 ~ 1.2 m", "四坡顶 hipped（屋顶高度取 1~3 m）"],
        ["无坡度，隆起 ≥ 1.2 m", "双坡顶 gabled（屋顶高度取隆起值，上限 6 m）"],
        ["总高超过 30 m 但隆起很小", "强制平顶（避免把高层办公楼误判成坡顶）"],
    ], widths=[8.0, 6.6])

    # ---- 五 ----
    heading(doc, "五、结果")
    table(doc, [
        ["指标", "补数据之前", "补数据之后"],
        ["有真实高度的建筑", "213（0.97%）", "21,233（97.0%）"],
        ["有屋顶形状的建筑", "48（0.22%）", "21,779（99.5%）"],
        ["模型里含斜面的构件数", "11,167", "16,836"],
    ], widths=[5.2, 4.4, 4.8])
    para(doc, "补进去的高度也是实测的：最低 1.2 m，25 分位 8.6 m，中位 10.6 m，75 分位 13.4 m，最高 169.3 m。"
              "平顶建筑最终占 23%，与华盛顿全城实测的 26.1% 平顶比例接近，说明判定规则没有系统性偏向。")

    picture(doc, os.path.join(FIG, "fig1_连排屋对比.png"), 15.8,
            "图 1　Shaw 街区连排屋，同一机位、同一配色。左：补数据之前，整片等高平顶盒子；"
            "右：补数据之后，锯齿状的真实坡屋顶")
    picture(doc, os.path.join(FIG, "fig2_全城.png"), 15.0,
            "图 2　华盛顿市中心全景（真实高度 + 真实屋顶形状），约 4.4 km × 5.2 km")
    picture(doc, os.path.join(FIG, "fig3_全城对比.png"), 15.8,
            "图 3　全城视角的前后对照")

    # ---- 六 ----
    heading(doc, "六、目前还差什么")
    for t in [
        "白宫、海军天文台一带没有激光雷达数据。官方说明是按美国特勤局的要求删除的，那片只能用 OSM 原有的少量信息。",
        "屋顶坡度图层来自 2005 / 2010 / 2013 年的立体影像，数据偏旧；连排屋常常整排合成一个要素，分不开具体每一户。",
        "颜色不是实测的。华盛顿建筑的真实颜色没有公开数据，现在用的是按石材和石灰岩调的一组灰白色，只是看着合理。",
        "外墙还没有做，墙面现在是纯色，窗户、门、檐口都还没有。",
        "坡度分档用的 3° 和 15° 两个阈值是我自己定的，没有权威依据，可能还有调整空间。",
    ]:
        para(doc, "· " + t, size=10.5, space_after=4, indent=0.4)

    # ---- 七 ----
    heading(doc, "七、下一步")
    para(doc, "外墙窗户是眼下最能提升辨识度的一环，打算用程序化的方式按建筑类型和层数生成，"
              "不依赖付费素材包。做完之后再考虑真实颜色，以及用 DCGIS 的 2023 轮廓替换 OSM 轮廓。"
              "纽约那边先放着，等华盛顿这条链走稳再套过去。")

    doc.save(OUT)
    print("已生成：%s  (%d KB)" % (OUT, os.path.getsize(OUT) // 1024))


if __name__ == "__main__":
    build()
