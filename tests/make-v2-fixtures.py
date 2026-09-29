#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 v2 端到端测试夹具（字幕 / 电子书 / 漫画 / 图片艺术字）。

用法：python make-v2-fixtures.py <目标项目目录>
只用标准库 + Pillow，临时产物全部落在目标目录内。
"""
import json
import os
import sys
import zipfile

from PIL import Image, ImageDraw, ImageFont

FONTS = {
    'cjk': r'C:\Windows\Fonts\msyh.ttc',
    'cjk_bold': r'C:\Windows\Fonts\msyhbd.ttc',
    'latin': r'C:\Windows\Fonts\arial.ttf',
}


def font(path, size):
    try:
        return ImageFont.truetype(path, size)
    except Exception:
        return ImageFont.load_default()


SRT = """1
00:00:01,000 --> 00:00:03,500
Good morning, hero.

2
00:00:04,000 --> 00:00:07,200
The ancient dragon has returned
to the northern valley.

3
00:00:08,000 --> 00:00:10,000
Good morning, hero.

"""

VTT = """WEBVTT

NOTE this cue is a comment and must survive

cue-1
00:00:01.000 --> 00:00:03.000 align:start position:10%
Welcome to this hamlet.

00:00:03.500 --> 00:00:06.000
Take this blade, <b>young hero</b>.

"""

ASS = """[Script Info]
Title: Fixture Episode 2
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 720

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\an8}The dragon sleeps here.
Dialogue: 0,0:00:03.50,0:00:06.00,Default,,0,0,0,,{\\pos(640,600)}Draw your blade,\\Nbrave one.
Comment: 0,0:00:07.00,0:00:09.00,Default,,0,0,0,,translator note: do not touch

[Fonts]
fontname: embedded.ttf
"""

CH1 = """<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Prologue</title></head>
<body><h1>Prologue</h1>
<p>Aldermoor was quiet that morning.</p>
<p>Only the blacksmith&rsquo;s hammer broke the silence.</p>
<p>3</p>
</body></html>
"""

CH2 = """<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Epilogue</title></head>
<body><h1>Epilogue</h1>
<p>A stranger arrived at dusk, carrying a broken blade.</p>
</body></html>
"""

OPF = """<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Fixture Book</dc:title><dc:language>en</dc:language>
    <dc:identifier id="bookid">urn:uuid:fixture-0001</dc:identifier>
  </metadata>
  <manifest>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="css" href="style.css" media-type="text/css"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
  </manifest>
  <spine toc="ncx"><itemref idref="ch1"/><itemref idref="ch2"/></spine>
</package>
"""

CONTAINER = """<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>
"""


def write(path, text, encoding='utf-8'):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding=encoding, newline='') as f:
        f.write(text)


def make_comic_page(path, idx):
    img = Image.new('RGB', (900, 600), (250, 250, 250))
    d = ImageDraw.Draw(img)
    # 两个气泡（白底黑边 + 英文台词）
    d.ellipse([40, 40, 420, 260], fill=(255, 255, 255), outline=(0, 0, 0), width=4)
    d.text((80, 130), 'Hello hero,' if idx == 0 else 'Farewell,', font=font(FONTS['latin'], 40), fill=(0, 0, 0))
    d.text((80, 180), 'welcome!' if idx == 0 else 'friend.', font=font(FONTS['latin'], 40), fill=(0, 0, 0))
    d.ellipse([480, 60, 860, 280], fill=(255, 255, 255), outline=(0, 0, 0), width=4)
    d.text((520, 150), 'The dragon' if idx == 0 else 'See you', font=font(FONTS['latin'], 34), fill=(0, 0, 0))
    d.text((520, 195), 'is coming.' if idx == 0 else 'tomorrow.', font=font(FONTS['latin'], 34), fill=(0, 0, 0))
    # 页码装饰（不该被当成正文翻译，但会被 OCR 看到 —— 断言时不强求）
    d.text((430, 560), str(idx + 1), font=font(FONTS['latin'], 28), fill=(80, 80, 80))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path)


def make_art_title(path):
    """常规字重的中文大标题：Windows OCR 能稳定识别（实测 200px 常规字重可用）。"""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img = Image.new('RGB', (900, 220), (12, 20, 40))
    d = ImageDraw.Draw(img)
    d.text((30, 60), '勇者传说', font=font(FONTS['cjk_bold'], 96), fill=(255, 255, 255))
    img.save(path)


def make_art_styled(path):
    """描边艺术字：本地 Windows OCR 会失败（空/乱码），必须走视觉兜底。"""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img = Image.new('RGB', (760, 260), (255, 255, 255))
    d = ImageDraw.Draw(img)
    d.text((40, 60), 'DRAGON', font=font(FONTS['cjk_bold'], 120), fill=(220, 30, 30), stroke_width=4, stroke_fill=(20, 20, 20))
    img.save(path)


def make_epub(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with zipfile.ZipFile(path, 'w') as z:
        # epub 规范：mimetype 必须是第一个条目且不压缩
        z.writestr(zipfile.ZipInfo('mimetype'), 'application/epub+zip', compress_type=zipfile.ZIP_STORED)
        z.writestr('META-INF/container.xml', CONTAINER, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr('OEBPS/content.opf', OPF, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr('OEBPS/ch1.xhtml', CH1, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr('OEBPS/ch2.xhtml', CH2, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr('OEBPS/style.css', 'body { font-family: serif; }', compress_type=zipfile.ZIP_DEFLATED)
        z.writestr('OEBPS/toc.ncx', '<?xml version="1.0"?><ncx/>', compress_type=zipfile.ZIP_DEFLATED)


def make_cbz(path, pages):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with zipfile.ZipFile(path, 'w') as z:
        for i, p in enumerate(pages):
            z.write(p, 'pages/page%02d.png' % (i + 1), compress_type=zipfile.ZIP_DEFLATED)


def main():
    root = sys.argv[1]
    os.makedirs(root, exist_ok=True)
    meta = {}

    write(os.path.join(root, 'subs', 'ep1.srt'), SRT)
    write(os.path.join(root, 'subs', 'ep2.ass'), ASS)
    write(os.path.join(root, 'subs', 'ep3.vtt'), VTT)

    make_epub(os.path.join(root, 'book', 'book.epub'))

    page_paths = []
    for i in range(2):
        p = os.path.join(root, 'comic', 'page%02d.png' % (i + 1))
        make_comic_page(p, i)
        page_paths.append(p)
    make_cbz(os.path.join(root, 'comic', 'ch1.cbz'), page_paths)

    make_art_title(os.path.join(root, 'art', 'title.png'))
    make_art_styled(os.path.join(root, 'art', 'styled.png'))

    meta['root'] = root
    with open(os.path.join(root, '..', 'fixture-meta.json'), 'w', encoding='utf-8') as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    print('WROTE', root)


if __name__ == '__main__':
    main()
