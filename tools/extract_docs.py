"""把 from muse 下的 PDF / XML / DOCX / HTML 统一抽成纯文本，便于 grep 核对数字。
输出到 from muse/_text_all/，文件名用相对路径（分隔符换成 __），保留可反查。
只读原件，不删不改。"""
import os, re, sys, html, zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "from muse"
OUT = ROOT / "_text_all"
OUT.mkdir(exist_ok=True)

def pdf_text(p):
    import pymupdf
    doc = pymupdf.open(p)
    parts = []
    for i, page in enumerate(doc):
        parts.append(f"\n\n===== [page {i+1}] =====\n")
        parts.append(page.get_text("text"))
    n = doc.page_count
    doc.close()
    return "".join(parts), n

def xml_text(p):
    s = p.read_text(encoding="utf-8", errors="replace")
    s = re.sub(r"<[^>]+>", " ", s)
    return html.unescape(re.sub(r"[ \t]+", " ", s)), 0

def docx_text(p):
    with zipfile.ZipFile(p) as z:
        names = [n for n in z.namelist() if n.startswith("word/") and n.endswith(".xml")]
        parts = []
        for n in ["word/document.xml"] + [x for x in names if x != "word/document.xml"]:
            if n not in z.namelist():
                continue
            s = z.read(n).decode("utf-8", errors="replace")
            s = s.replace("</w:p>", "\n").replace("</w:tr>", "\n")
            s = re.sub(r"<[^>]+>", "", s)
            parts.append(html.unescape(s))
        return "\n".join(parts), 0

def html_text(p):
    s = p.read_text(encoding="utf-8", errors="replace")
    s = re.sub(r"(?is)<(script|style).*?</\1>", " ", s)
    s = re.sub(r"(?i)<br\s*/?>|</p>|</div>|</tr>", "\n", s)
    s = re.sub(r"<[^>]+>", " ", s)
    return html.unescape(re.sub(r"[ \t]+", " ", s)), 0

files = []
for ext in ("*.pdf", "*.xml", "*.docx", "*.html"):
    files += sorted(ROOT.rglob(ext))
done = []
for p in files:
    rel = p.relative_to(ROOT)
    if "_text" in rel.parts:
        continue
    name = "__".join(rel.parts) + ".txt"
    dst = OUT / name
    try:
        e = p.suffix.lower()
        if e == ".pdf":
            txt, n = pdf_text(p)
        elif e == ".xml":
            txt, n = xml_text(p)
        elif e == ".docx":
            txt, n = docx_text(p)
        else:
            txt, n = html_text(p)
        dst.write_text(txt, encoding="utf-8")
        head = re.sub(r"\s+", " ", txt[:160]).strip()
        done.append((str(rel), n, len(txt), head))
        print(f"[ok] {rel}  pages={n} chars={len(txt)}")
    except Exception as ex:
        print(f"[fail] {rel}: {ex}")

print(f"\n共 {len(done)} 份，输出目录 {OUT}")
