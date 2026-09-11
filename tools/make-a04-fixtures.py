#!/usr/bin/env python3
# 生成 A04 专用合成 PDF：重复句 / 跨页长段 / 特殊空白（全角空格、不换行空格）/ 旋转页
# 全部为合成资料，不含任何真人信息。
#
# 用法: python3 tools/make-a04-fixtures.py <输出路径>
import sys
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas as pdfcanvas
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak

OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/coeditor-p0/vault/A04-定位验收样本.pdf"
VARIANT = (sys.argv[2] if len(sys.argv) > 2 else "a").lower()

# A03 用：variance B 把首页/次页里被批注的那句整段换掉，用来验证「原文已变化」不会被错位画线
TAIL_A = "Tail paragraph on the second page, used as a landing target for cross-page selections."
TAIL_B = "Completely rewritten closing note with different wording, so the old quote no longer exists."
TAIL = TAIL_A if VARIANT == "a" else TAIL_B

BASE = ParagraphStyle("base", fontName="Helvetica", fontSize=11, leading=17, spaceAfter=8)
H = ParagraphStyle("h", parent=BASE, fontName="Helvetica-Bold", fontSize=14, spaceAfter=10)

DUP = "Quarterly observations are sampled by city tier, with office districts oversampled by a factor of 1.4."


def on_page(canv, doc):
    # 第三页旋转 90°，用来验证旋转页上的批注定位
    if doc.page == 3:
        canv.setPageRotation(90)


def build():
    doc = SimpleDocTemplate(OUT, pagesize=A4, topMargin=22 * mm, bottomMargin=20 * mm,
                            leftMargin=22 * mm, rightMargin=22 * mm,
                            title="CoEditor A04 locating sample", author="CoEditor synthetic sample")
    story = []

    story.append(Paragraph("CoEditor A04 · Locating sample (synthetic)", H))
    story.append(Paragraph("All content on this page is synthetic and created only for locating tests.", BASE))
    story.append(Spacer(1, 6))

    story.append(Paragraph("First occurrence of the repeated sentence:", BASE))
    story.append(Paragraph(DUP, BASE))
    story.append(Spacer(1, 6))
    story.append(Paragraph("Interleaved paragraph so the two occurrences are far apart in the text index.", BASE))
    story.append(Paragraph("Sample size reaches 3,842 store-quarter observations across 1,208 outlets.", BASE))
    story.append(Spacer(1, 6))
    story.append(Paragraph("Second occurrence of the repeated sentence:", BASE))
    story.append(Paragraph(DUP, BASE))
    story.append(Spacer(1, 10))

    # 特殊空白：全角空格 U+3000、不换行空格 U+00A0、制表符
    story.append(Paragraph("Whitespace check: full-width\u3000space and non-breaking\u00a0space sit in this line.", BASE))
    story.append(Paragraph("Paragraph that flows across the page boundary starts here and keeps going so that a "
                           "selection can legitimately start on one page and end on the next one." * 1, BASE))

    story.append(PageBreak())

    # 让一段很长的文字自然跨页：这一段会从第一页续到第二页
    long_para = ("Cross-page continuation sentence. " * 60)
    story.append(Paragraph("Part two · cross-page paragraph", H))
    story.append(Paragraph(long_para, BASE))
    story.append(Spacer(1, 10))
    story.append(Paragraph(TAIL, BASE))

    story.append(PageBreak())
    story.append(Paragraph("Part three · rotated page (90 degrees)", H))
    story.append(Paragraph("Annotation on a rotated page must stay under its own glyphs.", BASE))

    doc.build(story, onFirstPage=on_page, onLaterPages=on_page)


if __name__ == "__main__":
    build()
    print("written:", OUT)
