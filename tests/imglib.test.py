# -*- coding: utf-8 -*-
"""imglib.py 的自测（标准库 unittest，可直接 python tests/imglib.test.py 运行）。

夹具全部生成在 tempfile 临时目录内，不写入仓库其它位置。
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest
import zlib

import numpy as np
from PIL import Image, ImageDraw, ImageFont

# 必须用运行时自带 Python（PATH 上的 WindowsApps 假 python 不可用）
PY = sys.executable
HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
IMGLIB = os.path.join(REPO, 'engine', 'src', 'scripts', 'imglib.py')

MSYH = r'C:\Windows\Fonts\msyh.ttc'
MSYHBD = r'C:\Windows\Fonts\msyhbd.ttc'
ARIAL = r'C:\Windows\Fonts\arial.ttf'

# 夹具布局常量（合成漫画页 900x600）
BUBBLE_ZH = (40, 40, 340, 240)      # 左气泡
BUBBLE_EN = (520, 40, 860, 240)     # 右气泡
ART_BOX = (60, 330, 420, 430)       # 红色描边艺术字
SMALL_BOX = (60, 500, 400, 540)     # 12px 小字


def _font(path, size):
    try:
        return ImageFont.truetype(path, size)
    except Exception:
        return ImageFont.load_default()


def make_page(path):
    """合成漫画页：白底 + 两个气泡（中文/英文）+ 红色描边艺术字 + 一行小字。"""
    img = Image.new('RGB', (900, 600), (255, 255, 255))
    d = ImageDraw.Draw(img)
    # 气泡 1（中文）
    d.ellipse(list(BUBBLE_ZH), fill=(255, 255, 255), outline=(0, 0, 0), width=4)
    d.text((70, 125), '你好，世界', font=_font(MSYH, 40), fill=(0, 0, 0))
    # 气泡 2（英文）
    d.ellipse(list(BUBBLE_EN), fill=(255, 255, 255), outline=(0, 0, 0), width=4)
    d.text((548, 130), 'HELLO WORLD', font=_font(ARIAL, 34), fill=(0, 0, 0))
    # 红色描边艺术字（大字）
    d.text((70, 340), '勇者传说', font=_font(MSYHBD, 62), fill=(220, 30, 30),
           stroke_width=4, stroke_fill=(20, 20, 20))
    # 12px 小字
    d.text((70, 505), 'Small print 12px line', font=_font(ARIAL, 12), fill=(90, 90, 90))
    img.save(path)
    return img


def iou(a, b):
    ax0, ay0, ax1, ay1 = a
    bx0, by0, bx1, by1 = b
    ix = max(0, min(ax1, bx1) - max(ax0, bx0))
    iy = max(0, min(ay1, by1) - max(ay0, by0))
    inter = ix * iy
    if inter <= 0:
        return 0.0
    ua = (ax1 - ax0) * (ay1 - ay0) + (bx1 - bx0) * (by1 - by0) - inter
    return inter / float(ua)


def box_of(r):
    return (r['x'], r['y'], r['x'] + r['w'], r['y'] + r['h'])


def make_text_pdf(path):
    """手工构造一个带文本层 + FlateDecode 内嵌图片的最小 PDF（1 页）。

    ToUnicode CMap 的字符码是 2 字节 UTF-16BE（源字符码 0x0001..0x0006）。
    """
    text = '你好世界AB'
    codes = ''.join('%04X' % (i + 1) for i in range(len(text)))
    bfchars = '\n'.join('<%04X> <%s>' % (i + 1, '%04X' % ord(ch))
                        for i, ch in enumerate(text))
    cmap = ('/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n'
            '1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n'
            '%d beginbfchar\n%s\nendbfchar\nendcmap\nend\nend\n'
            % (len(text), bfchars)).encode('latin1')
    # 内嵌图片：120x90 纯 RGB，FlateDecode 压缩
    arr = np.zeros((90, 120, 3), dtype=np.uint8)
    arr[:, :, 0] = 200
    arr[20:70, 30:90] = (10, 40, 220)
    raw = zlib.compress(arr.tobytes())
    content = ('BT /F1 24 Tf 60 700 Td <%s> Tj ET\n72 72 120 90 re /Im1 Do\n'
               % codes).encode('latin1')

    objs = {
        1: b'<< /Type /Catalog /Pages 2 0 R >>',
        2: b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        3: (b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 800] '
            b'/Resources << /Font << /F1 4 0 R >> /XObject << /Im1 6 0 R >> >> '
            b'/Contents 7 0 R >>'),
        4: b'<< /Type /Font /Subtype /Type0 /BaseFont /Test /Encoding /Identity-H /ToUnicode 5 0 R >>',
        5: b'<< /Length %d >>\nstream\n' % len(cmap) + cmap + b'\nendstream',
        6: (b'<< /Type /XObject /Subtype /Image /Width 120 /Height 90 '
            b'/ColorSpace /DeviceRGB /BitsPerComponent 8 '
            b'/Filter /FlateDecode /Length %d >>\nstream\n' % len(raw)
            + raw + b'\nendstream'),
        7: b'<< /Length %d >>\nstream\n' % len(content) + content + b'\nendstream',
    }
    out = bytearray(b'%PDF-1.4\n')
    offsets = {}
    for num in sorted(objs):
        offsets[num] = len(out)
        out += b'%d 0 obj\n' % num + objs[num] + b'\nendobj\n'
    xref = len(out)
    out += b'xref\n0 %d\n' % (len(objs) + 1)
    out += b'0000000000 65535 f \n'
    for num in sorted(objs):
        out += b'%010d 00000 n \n' % offsets[num]
    out += (b'trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n'
            % (len(objs) + 1, xref))
    with open(path, 'wb') as fh:
        fh.write(bytes(out))
    return text


class ImglibTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix='imglib-test-')
        cls.page = os.path.join(cls.tmp, 'page.png')
        cls.blank = os.path.join(cls.tmp, 'blank.png')
        make_page(cls.page)
        Image.new('RGB', (300, 200), (255, 255, 255)).save(cls.blank)
        cls._call_n = 0

    # ---------------------------------------------------------- 调用助手
    @classmethod
    def call(cls, payload, expect_ok=None, timeout=180):
        """调用 CLI（python imglib.py in.json out.json），返回 out.json 内容。"""
        cls._call_n += 1
        tag = 'c%02d' % cls._call_n
        in_path = os.path.join(cls.tmp, tag + '.in.json')
        out_path = os.path.join(cls.tmp, tag + '.out.json')
        with open(in_path, 'w', encoding='utf-8') as fh:
            json.dump(payload, fh, ensure_ascii=False)
        env = dict(os.environ)
        env['PYTHONIOENCODING'] = 'utf-8'
        proc = subprocess.run([PY, IMGLIB, in_path, out_path],
                              capture_output=True, timeout=timeout, env=env)
        cls.last_stderr = proc.stderr.decode('utf-8', 'replace')
        if proc.returncode != 0 or not os.path.isfile(out_path):
            raise AssertionError('CLI 失败 rc=%s out 存在=%s\nstderr:\n%s'
                                 % (proc.returncode, os.path.isfile(out_path),
                                    cls.last_stderr))
        with open(out_path, 'r', encoding='utf-8') as fh:
            res = json.load(fh)
        if expect_ok is not None:
            assert res.get('ok') is expect_ok, '期望 ok=%s，实际 %s：%s\n%s' % (
                expect_ok, res.get('ok'), res.get('error'), cls.last_stderr)
        return res

    # ---------------------------------------------------------- 1. probe
    def test_01_probe_fonts(self):
        res = self.call({'op': 'probe'}, expect_ok=True)
        self.assertTrue(res['fonts'], '字体清单为空')
        cjk = [f for f in res['fonts'] if f.get('cjk')]
        self.assertTrue(cjk, '没有任何 cjk:true 字体：%s' % res['fonts'])
        for f in res['fonts']:
            self.assertTrue(os.path.isfile(f['path']), '字体文件不存在：%s' % f['path'])
        self.assertRegex(res['python'], r'^\d+\.\d+$')
        self.assertTrue(res['pillow'].startswith('12.'))
        self.assertTrue(res['numpy'].startswith('2.'))
        print('\n[probe] python=%s pillow=%s numpy=%s cjk字体=%d/%d'
              % (res['python'], res['pillow'], res['numpy'], len(cjk), len(res['fonts'])))

    # ---------------------------------------------------------- 2. regions
    def test_02_regions_detect(self):
        res = self.call({'op': 'regions', 'images': [{'path': self.page, 'hint': 'text'}]},
                        expect_ok=True)
        r0 = res['results'][0]
        self.assertEqual((r0['width'], r0['height']), (900, 600))
        regs = r0['regions']
        print('\n[regions] 检出 %d 个框：%s' % (
            len(regs), [(r['x'], r['y'], r['w'], r['h'], r['kind'], r['ink'])
                        for r in regs[:12]]))
        self.assertGreaterEqual(len(regs), 3, '至少应检出 3 个框，实际 %d' % len(regs))

        # 框必须在图像范围内
        for r in regs:
            self.assertGreater(r['w'], 0)
            self.assertGreater(r['h'], 0)
            self.assertGreaterEqual(r['x'], 0)
            self.assertGreaterEqual(r['y'], 0)
            self.assertLessEqual(r['x'] + r['w'], 900)
            self.assertLessEqual(r['y'] + r['h'], 600)
            self.assertGreaterEqual(r['ink'], 0.0)
            self.assertLessEqual(r['ink'], 1.0)

        # 艺术字区域必须有框覆盖（IoU ≥ 0.15 或中心落入）
        art_hit = None
        for r in regs:
            b = box_of(r)
            if iou(b, ART_BOX) >= 0.15:
                art_hit = r
                break
            cx, cy = (b[0] + b[2]) / 2.0, (b[1] + b[3]) / 2.0
            if ART_BOX[0] <= cx <= ART_BOX[2] and ART_BOX[1] <= cy <= ART_BOX[3]:
                art_hit = r
                break
        self.assertIsNotNone(art_hit, '艺术字区域没有被任何框覆盖：%s'
                             % [box_of(r) for r in regs])

        # 阅读顺序：整体上→下（允许同行的相邻框互换）
        tops = [r['y'] for r in regs]
        self.assertLessEqual(min(tops), 260, '最上面的框应落在页面上部')
        self.assertGreaterEqual(max(tops), 300, '最下面的框应落在页面下部')
        for a, b in zip(regs, regs[1:]):
            self.assertLessEqual(a['y'] - 40, b['y'],
                                 '阅读顺序应大体自上而下：%s -> %s' % (a, b))

        # 两个气泡里的文字都应被检出（宽松：与气泡内文字带重叠即可）
        zh = [r for r in regs if iou(box_of(r), (60, 110, 300, 180)) >= 0.05]
        en = [r for r in regs if iou(box_of(r), (540, 120, 830, 175)) >= 0.05]
        self.assertTrue(zh, '中文气泡文字未检出')
        self.assertTrue(en, '英文气泡文字未检出')

    def test_02b_regions_hints(self):
        for hint in ('bubble', 'art'):
            res = self.call({'op': 'regions',
                             'images': [{'path': self.page, 'hint': hint}],
                             'maxRegions': 20}, expect_ok=True)
            regs = res['results'][0]['regions']
            print('[regions hint=%s] %d 个框：%s' % (
                hint, len(regs), [(r['kind'], r['w'], r['h']) for r in regs[:8]]))
            self.assertGreaterEqual(len(regs), 1, 'hint=%s 什么都没检出' % hint)

    def test_02c_regions_downscale(self):
        """大图走 maxDim 降采样检测 → 框要按比例映射回原图坐标。"""
        big = os.path.join(self.tmp, 'big.png')
        img = Image.new('RGB', (2400, 1600), (255, 255, 255))
        d = ImageDraw.Draw(img)
        d.ellipse([100, 100, 700, 600], outline=(0, 0, 0), width=8)
        d.text((200, 300), '你好，世界', font=_font(MSYH, 90), fill=(0, 0, 0))
        d.text((1300, 1200), 'BIG PAGE', font=_font(ARIAL, 60), fill=(0, 0, 0))
        img.save(big)
        res = self.call({'op': 'regions', 'images': [{'path': big, 'hint': 'text'}],
                         'maxDim': 800}, expect_ok=True)
        r0 = res['results'][0]
        print('[regions 大图] det=%sx%s 框=%s'
              % (r0['detectWidth'], r0['detectHeight'],
                 [(r['x'], r['y'], r['w'], r['h']) for r in r0['regions']]))
        self.assertEqual((r0['width'], r0['height']), (2400, 1600))
        self.assertLessEqual(max(r0['detectWidth'], r0['detectHeight']), 800)
        self.assertGreaterEqual(len(r0['regions']), 1)
        for r in r0['regions']:
            self.assertLessEqual(r['x'] + r['w'], 2400)
            self.assertLessEqual(r['y'] + r['h'], 1600)
        # 中文气泡文字的框应落在放大后的坐标上
        hit = [r for r in r0['regions'] if iou(box_of(r), (180, 280, 640, 420)) >= 0.05]
        self.assertTrue(hit, '降采样路径下未检出气泡文字：%s'
                        % [box_of(r) for r in r0['regions']])

    # ---------------------------------------------------------- 3. crop
    def test_03_crop(self):
        out1 = os.path.join(self.tmp, 'crop1.png')
        out2 = os.path.join(self.tmp, 'crop2.png')
        out3 = os.path.join(self.tmp, 'crop3.png')
        res = self.call({'op': 'crop', 'items': [
            {'path': self.page, 'box': [60, 110, 200, 70], 'out': out1},
            {'path': self.page, 'box': [820, 540, 200, 200], 'out': out2},   # 越界
            {'path': self.page, 'box': [70, 340, 200, 60], 'out': out3, 'scale': 2},
        ]}, expect_ok=True)
        f1, f2, f3 = res['files']
        self.assertEqual((f1['w'], f1['h']), (200, 70))
        self.assertEqual((f2['w'], f2['h']), (80, 60), '越界框应被裁到图像边界')
        self.assertEqual((f3['w'], f3['h']), (400, 120), 'scale=2 应放大一倍')
        for f in res['files']:
            self.assertTrue(os.path.isfile(f['out']), '裁剪文件不存在：%s' % f['out'])
            im = Image.open(f['out'])
            im.load()
            self.assertEqual(im.size, (f['w'], f['h']))
            self.assertEqual(im.format, 'PNG')
            self.assertGreater(len(im.tobytes()), 0)
        # 内容非空：裁剪结果里有黑色墨迹
        pix = np.asarray(Image.open(out1).convert('L'))
        self.assertLess(int(pix.min()), 128, '裁剪内容应包含墨迹')

    def test_03b_crop_empty_box(self):
        res = self.call({'op': 'crop', 'items': [
            {'path': self.page, 'box': [10000, 10000, 10, 10],
             'out': os.path.join(self.tmp, 'never.png')}]}, expect_ok=False)
        self.assertIn('error', res)
        self.assertTrue(res['error'])
        print('[crop 空框] error=%s' % res['error'])

    # ---------------------------------------------------------- 4. typeset
    def test_04_typeset(self):
        # 造一张「原文待擦除」的图：气泡内画黑色文字块
        src = os.path.join(self.tmp, 'ts-src.png')
        img = Image.open(self.page).convert('RGB')
        d = ImageDraw.Draw(img)
        d.text((70, 125), '你好，世界', font=_font(MSYH, 40), fill=(0, 0, 0))
        img.save(src)
        out = os.path.join(self.tmp, 'ts-out.png')
        box = [56, 100, 280, 100]
        res = self.call({'op': 'typeset', 'items': [{'path': src, 'out': out, 'ops': [
            {'box': box, 'text': '欢迎来到这个世界，勇者',
             'style': {'align': 'center', 'valign': 'middle', 'color': [10, 10, 10],
                       'erase': 'auto', 'lineSpacing': 1.2}}]}]}, expect_ok=True)
        f = res['files'][0]
        op = f['ops'][0]
        print('\n[typeset] %s' % json.dumps(op, ensure_ascii=False))
        self.assertTrue(os.path.isfile(out))
        self.assertEqual((f['w'], f['h']), (900, 600))
        for k in ('box', 'fontSize', 'lines', 'fits'):
            self.assertIn(k, op, '缺少字段 %s' % k)
        self.assertGreater(op['fontSize'], 0)
        self.assertGreater(op['lines'], 0)
        self.assertGreater(op['fontSize'], 8, '自动字号不应降到下限以下')
        self.assertLess(op['fontSize'], box[3], '长文本应触发字号缩小（< 框高）')
        self.assertEqual(op['box'], [56.0, 100.0, 280.0, 100.0])

        # 擦除生效：擦除后框内墨迹（相对背景）显著少于擦除前
        self.assertGreater(op['inkBefore'], 100, '夹具本身应有原文墨迹')
        self.assertLess(op['inkAfterErase'], op['inkBefore'] * 0.35,
                        '擦除后残留墨迹过多：%d -> %d'
                        % (op['inkBefore'], op['inkAfterErase']))
        # 新墨迹出现
        self.assertGreater(op['inkFinal'], op['inkAfterErase'] + 50, '没有写入新译文墨迹')

        # 像素级校验：旧文本区域被覆盖、框内出现了非背景像素
        before = np.asarray(Image.open(src).convert('RGB').crop(
            (box[0], box[1], box[0] + box[2], box[1] + box[3])), dtype=np.int16)
        after = np.asarray(Image.open(out).convert('RGB').crop(
            (box[0], box[1], box[0] + box[2], box[1] + box[3])), dtype=np.int16)
        dark_before = int(np.count_nonzero(before.sum(axis=2) < 300))
        dark_after = int(np.count_nonzero(after.sum(axis=2) < 300))
        self.assertGreater(dark_before, 200)
        self.assertGreater(dark_after, 200, '框内没有新墨迹')
        # 分布确有差异（旧文本已被擦除/覆盖）
        diff = int(np.count_nonzero(np.abs(before - after).max(axis=2) > 40))
        self.assertGreater(diff, 100, '框内像素分布几乎没变化，擦除/排版可能没生效')

        # 框外像素不应被改动（擦除只发生在框内；手工校验远景区域）
        b_out = np.asarray(Image.open(src).convert('RGB').crop((700, 450, 900, 600)))
        a_out = np.asarray(Image.open(out).convert('RGB').crop((700, 450, 900, 600)))
        self.assertTrue(np.array_equal(b_out, a_out), '框外像素被改动了')

    def test_04b_typeset_erase_modes(self):
        # erase=rect 用指定底色；erase=none 不擦
        out_r = os.path.join(self.tmp, 'ts-rect.jpg')
        out_n = os.path.join(self.tmp, 'ts-none.webp')
        res = self.call({'op': 'typeset', 'items': [
            {'path': self.page, 'out': out_r, 'ops': [
                {'box': [56, 100, 280, 100], 'text': '译文',
                 'style': {'erase': 'rect', 'eraseColor': [255, 240, 200],
                           'align': 'center', 'valign': 'middle'}}]},
            {'path': self.page, 'out': out_n, 'ops': [
                {'box': [56, 100, 280, 100], 'text': '译文',
                 'style': {'erase': 'none', 'align': 'center', 'valign': 'middle'}}]},
        ]}, expect_ok=True)
        fr, fn = res['files']
        self.assertTrue(os.path.isfile(out_r) and os.path.isfile(out_n))
        with Image.open(out_r) as im:
            self.assertEqual(im.format, 'JPEG')
        with Image.open(out_n) as im:
            self.assertEqual(im.format, 'WEBP')
        self.assertEqual(fr['ops'][0]['eraseColor'], [255, 240, 200])
        self.assertEqual(fn['ops'][0]['erasedPixels'], 0, 'erase=none 不应擦除')
        # 全模式图像也应支持
        p_img = os.path.join(self.tmp, 'palette.png')
        with Image.open(self.page) as base:
            base.convert('P', palette=Image.ADAPTIVE, colors=64).save(p_img)
        out_p = os.path.join(self.tmp, 'ts-pal.png')
        res_p = self.call({'op': 'typeset', 'items': [
            {'path': p_img, 'out': out_p, 'ops': [
                {'box': [56, 100, 280, 100], 'text': '模式测试',
                 'style': {'erase': 'auto'}}]}]}, expect_ok=True)
        self.assertTrue(os.path.isfile(out_p))
        with Image.open(out_p) as im:
            im.load()
            self.assertEqual(im.size, (900, 600))
        self.assertTrue(res_p['files'][0]['ops'][0]['fits'])

    def test_04d_typeset_modes(self):
        """RGBA / L / CMYK / 负坐标框 都应能排版写回。"""
        cases = []
        with Image.open(self.page) as base:
            rgba = os.path.join(self.tmp, 'm-rgba.png')
            base.convert('RGBA').save(rgba)
            gray = os.path.join(self.tmp, 'm-gray.png')
            base.convert('L').save(gray)
            cmyk = os.path.join(self.tmp, 'm-cmyk.jpg')
            base.convert('CMYK').save(cmyk)
        cases = [
            (rgba, os.path.join(self.tmp, 'm-rgba-out.png')),
            (gray, os.path.join(self.tmp, 'm-gray-out.png')),
            (cmyk, os.path.join(self.tmp, 'm-cmyk-out.jpg')),
        ]
        items = [{'path': src, 'out': out, 'ops': [
            {'box': [-20, -10, 400, 160], 'text': '负坐标框译文',
             'style': {'erase': 'auto', 'align': 'center', 'valign': 'middle'}}]}
            for src, out in cases]
        res = self.call({'op': 'typeset', 'items': items}, expect_ok=True)
        for f, (src, out) in zip(res['files'], cases):
            self.assertTrue(os.path.isfile(out), '未写出：%s' % out)
            self.assertEqual(f['ops'][0]['fontSize'] > 0, True)
            with Image.open(out) as im:
                im.load()
                self.assertEqual(im.size, (900, 600))
            # 负坐标框被裁剪后，左上角应有新墨迹
            arr = np.asarray(Image.open(out).convert('L'))
            self.assertLess(int(arr[:120, :360].min()), 128,
                            '%s 左上角未见新墨迹' % out)

    def test_04c_typeset_overflow_and_explicit_font(self):
        """放不下时必须 fits:false 但仍写出图像；显式 fontSize/fontPath 要被尊重。"""
        out_bad = os.path.join(self.tmp, 'ts-tiny.png')
        out_fix = os.path.join(self.tmp, 'ts-fixed.png')
        long_text = '这是一段特别长的译文' * 12
        res = self.call({'op': 'typeset', 'items': [
            {'path': self.blank, 'out': out_bad, 'ops': [
                {'box': [10, 10, 40, 10], 'text': long_text,
                 'style': {'erase': 'none'}}]},
            {'path': self.blank, 'out': out_fix, 'ops': [
                {'box': [20, 20, 200, 120], 'text': 'Fixed size',
                 'style': {'fontPath': ARIAL, 'fontSize': 20, 'erase': 'none'}}]},
        ]}, expect_ok=True)
        op_bad = res['files'][0]['ops'][0]
        op_fix = res['files'][1]['ops'][0]
        print('\n[typeset 溢出] %s' % json.dumps(op_bad, ensure_ascii=False))
        print('[typeset 显式字号] %s' % json.dumps(op_fix, ensure_ascii=False))
        self.assertFalse(op_bad['fits'], '放不下时应为 fits:false')
        self.assertEqual(op_bad['fontSize'], 8, '应降到最小字号 8')
        self.assertTrue(os.path.isfile(out_bad), 'fits:false 也要写出图像')
        self.assertEqual(op_fix['fontSize'], 20, '显式 fontSize 应被尊重')
        self.assertEqual(op_fix['font'], ARIAL, '显式 fontPath 应被尊重')
        self.assertTrue(op_fix['fits'])
        self.assertEqual(op_fix['lines'], 1)

    # ---------------------------------------------------------- 5. pdf

    def test_05_pdf(self):
        p1 = os.path.join(self.tmp, 'pdf-p1.png')
        p2 = os.path.join(self.tmp, 'pdf-p2.png')
        i1 = Image.new('RGB', (420, 320), (250, 250, 250))
        d = ImageDraw.Draw(i1)
        d.rectangle([40, 40, 380, 280], outline=(0, 0, 0), width=5)
        d.ellipse([80, 90, 220, 230], fill=(200, 40, 40))
        d.text((240, 60), 'PDF PAGE 1', font=_font(ARIAL, 28), fill=(0, 0, 0))
        i1.save(p1)
        i2 = Image.new('RGB', (420, 320), (240, 245, 255))
        d2 = ImageDraw.Draw(i2)
        d2.rectangle([30, 30, 390, 290], fill=(30, 60, 160))
        d2.ellipse([120, 100, 300, 250], fill=(250, 220, 40))
        i2.save(p2)
        pdf = os.path.join(self.tmp, 'doc.pdf')
        i1.save(pdf, save_all=True, append_images=[i2])

        out_dir = os.path.join(self.tmp, 'pdfimg')
        res = self.call({'op': 'pdf', 'file': pdf, 'outDir': out_dir,
                         'wantText': True, 'wantImages': True}, expect_ok=True)
        print('\n[pdf] pages=%s hasText=%s images=%d skipped=%s'
              % (res['pages'], res['hasText'], len(res['images']),
                 json.dumps(res.get('skipped'), ensure_ascii=False)))
        self.assertGreaterEqual(res['pages'], 1)
        self.assertGreaterEqual(len(res['images']), 1, '没有抽出内嵌图片')
        for im_info in res['images']:
            self.assertTrue(os.path.isfile(im_info['path']),
                            '图片文件不存在：%s' % im_info['path'])
            self.assertTrue(im_info['path'].startswith(out_dir))
            self.assertGreater(im_info['w'], 0)
            self.assertGreater(im_info['h'], 0)
            with Image.open(im_info['path']) as im:
                im.load()
                self.assertEqual(im.size, (im_info['w'], im_info['h']))
                self.assertGreater(len(im.tobytes()), 0)
        self.assertIsInstance(res['text'], str)

    def test_05b_pdf_text_layer_and_flate_image(self):
        """手工最小 PDF：验证 ToUnicode CMap 文本抽取 + FlateDecode 图片重建。"""
        pdf = os.path.join(self.tmp, 'text.pdf')
        want = make_text_pdf(pdf)
        out_dir = os.path.join(self.tmp, 'pdftext')
        res = self.call({'op': 'pdf', 'file': pdf, 'outDir': out_dir,
                         'wantText': True, 'wantImages': True}, expect_ok=True)
        print('\n[pdf 文本层] pages=%s hasText=%s text=%r images=%s skipped=%s'
              % (res['pages'], res['hasText'], res['text'],
                 [(i['name'], i['filter'], i['w'], i['h']) for i in res['images']],
                 json.dumps(res.get('skipped'), ensure_ascii=False)))
        self.assertEqual(res['pages'], 1)
        self.assertTrue(res['hasText'], '带 ToUnicode 的文本层应能抽出')
        self.assertIn(want, res['text'], 'CMap 映射结果不正确：%r' % res['text'])

        self.assertEqual(len(res['images']), 1, 'FlateDecode 图片未抽出')
        info = res['images'][0]
        self.assertTrue(os.path.isfile(info['path']))
        self.assertEqual(info['name'][-4:], '.png')
        self.assertEqual((info['w'], info['h']), (120, 90))
        with Image.open(info['path']) as im:
            im.load()
            self.assertEqual(im.size, (120, 90))
            self.assertEqual(im.mode, 'RGB')
            px = np.asarray(im)
            self.assertTupleEqual(tuple(int(v) for v in px[45, 60]), (10, 40, 220),
                                  'FlateDecode 像素重建不正确')

    def test_05c_pdf_no_text_layer(self):
        """扫描件（无文本层）→ hasText:false，但图片仍可抽出。"""
        pdf = os.path.join(self.tmp, 'scan.pdf')
        i1 = Image.new('RGB', (200, 150), (255, 255, 255))
        ImageDraw.Draw(i1).ellipse([20, 20, 180, 130], fill=(0, 0, 0))
        i1.save(pdf, save_all=True)
        res = self.call({'op': 'pdf', 'file': pdf,
                         'outDir': os.path.join(self.tmp, 'scanimg'),
                         'wantText': True, 'wantImages': True}, expect_ok=True)
        self.assertFalse(res['hasText'], '扫描件不应报告 hasText')
        self.assertGreaterEqual(len(res['images']), 1)

    # ---------------------------------------------------------- 6. resize
    def test_06_resize(self):
        out = os.path.join(self.tmp, 'small.png')
        res = self.call({'op': 'resize', 'items': [
            {'path': self.page, 'out': out, 'maxDim': 300}]}, expect_ok=True)
        f = res['files'][0]
        self.assertEqual(max(f['w'], f['h']), 300)
        self.assertEqual(f['w'], 300)
        self.assertEqual(f['h'], 200)
        with Image.open(out) as im:
            self.assertEqual(im.size, (300, 200))
        # 已小于 maxDim 时保持原尺寸
        out2 = os.path.join(self.tmp, 'same.png')
        res2 = self.call({'op': 'resize', 'items': [
            {'path': self.blank, 'out': out2, 'maxDim': 1600}]}, expect_ok=True)
        self.assertEqual((res2['files'][0]['w'], res2['files'][0]['h']), (300, 200))

    # ---------------------------------------------------------- 7. 错误路径
    def test_07_missing_image(self):
        missing = os.path.join(self.tmp, 'no-such.png')
        for op_payload in (
            {'op': 'regions', 'images': [{'path': missing}]},
            {'op': 'crop', 'items': [{'path': missing, 'box': [0, 0, 10, 10],
                                      'out': os.path.join(self.tmp, 'x.png')}]},
            {'op': 'typeset', 'items': [{'path': missing,
                                         'out': os.path.join(self.tmp, 'y.png'),
                                         'ops': [{'box': [0, 0, 10, 10], 'text': 'a'}]}]},
        ):
            res = self.call(op_payload, expect_ok=False)
            self.assertFalse(res['ok'])
            self.assertTrue(res.get('error'), '失败时必须给出 error')
            print('[错误路径] %s -> %s' % (op_payload['op'], res['error']))

    def test_07b_bad_op_and_bad_json(self):
        res = self.call({'op': 'nope'}, expect_ok=False)
        self.assertIn('未知 op', res['error'])
        # 非法 JSON 也要写出 out.json
        in_path = os.path.join(self.tmp, 'bad.in.json')
        out_path = os.path.join(self.tmp, 'bad.out.json')
        with open(in_path, 'w', encoding='utf-8') as fh:
            fh.write('{ not json ')
        proc = subprocess.run([PY, IMGLIB, in_path, out_path],
                              capture_output=True, timeout=60)
        self.assertEqual(proc.returncode, 0)
        with open(out_path, 'r', encoding='utf-8') as fh:
            res = json.load(fh)
        self.assertFalse(res['ok'])
        self.assertTrue(res['error'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
