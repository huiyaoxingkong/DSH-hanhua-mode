# 生成带中/英/日文字幕风格的测试图片（用于 OCR 验证）
import sys, os
from PIL import Image, ImageDraw, ImageFont

outdir = sys.argv[1]
os.makedirs(outdir, exist_ok=True)

def font(size, path):
    try: return ImageFont.truetype(path, size)
    except Exception: return ImageFont.load_default()

img = Image.new('RGB', (760, 420), (255, 255, 255))
d = ImageDraw.Draw(img)
# 漫画气泡风格：白底黑边 + 中文文本
d.ellipse([40, 30, 340, 210], fill=(255, 255, 255), outline=(0, 0, 0), width=3)
d.text((70, 90), "你好，世界", font=font(36, r'C:\Windows\Fonts\msyh.ttc'), fill=(0, 0, 0))
d.ellipse([380, 30, 700, 210], fill=(255, 255, 255), outline=(0, 0, 0), width=3)
d.text((400, 90), "HELLO WORLD", font=font(32, r'C:\Windows\Fonts\arial.ttf'), fill=(0, 0, 0))
# 艺术字（描边大字）——模拟图片构成的标题艺术字
title_font = font(56, r'C:\Windows\Fonts\msyhbd.ttc')
d.text((60, 260), "勇者传说", font=title_font, fill=(220, 30, 30), stroke_width=3, stroke_fill=(20, 20, 20))
# 日文（用于验证 zh 引擎对假名的表现 & vision 兜底）
d.text((380, 275), "こんにちは", font=font(34, r'C:\Windows\Fonts\msjh.ttc'), fill=(0, 0, 0))
d.text((60, 370), "Small print 12px", font=font(14, r'C:\Windows\Fonts\arial.ttf'), fill=(90, 90, 90))

p = os.path.join(outdir, 'ocr-sample.png')
img.save(p)
print('WROTE', p, img.size)
