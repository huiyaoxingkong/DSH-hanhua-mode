#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""imglib.py —— 汉化引擎的图像 / PDF 处理底层能力。

用法：
    python imglib.py <in.json> <out.json>

契约：
    * 所有路径为绝对路径；无论成败都写出 out.json。
    * 成功：{"ok": true, ...}    失败：{"ok": false, "error": "..."}
    * 退出码 0 表示 out.json 已写出；日志一律写 stderr，不污染 out.json。

支持的 op：probe / regions / crop / typeset / stitch / pdf / resize
仅依赖：标准库 + Pillow + numpy。

图片字体相关：
    * stitch   把多张小图（图片字体的词碎片）拼成一条，供整体 OCR；
    * typeset  支持 text 为空 + erase=auto/rect 的「只擦除不绘制」模式。
"""

import json
import os
import re
import struct
import sys
import traceback
import zlib

import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageOps

Image.MAX_IMAGE_PIXELS = None  # 汉化素材常见超大图，放开 Pillow 解压炸弹阈值

# ---------------------------------------------------------------- 基础工具


def log(msg):
    """日志写 stderr，绝不污染 out.json。"""
    sys.stderr.write('[imglib] %s\n' % msg)
    sys.stderr.flush()


def _fail(msg):
    raise RuntimeError(msg)


def _require(cond, msg):
    if not cond:
        _fail(msg)


def _num(v, default=None, name='参数'):
    if v is None:
        return default
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        _fail('%s 必须是数字，收到 %r' % (name, v))
    return v


def _int(v, default=None, name='参数'):
    n = _num(v, default, name)
    return default if n is None else int(round(n))


def _box4(v, name='box'):
    """把 [x, y, w, h] 规整成 4 个 float；非法直接抛错。"""
    _require(isinstance(v, (list, tuple)) and len(v) == 4,
             '%s 必须是长度 4 的数组 [x,y,w,h]，收到 %r' % (name, v))
    out = []
    for i, e in enumerate(v):
        _require(isinstance(e, (int, float)) and not isinstance(e, bool),
                 '%s[%d] 必须是数字' % (name, i))
        out.append(float(e))
    return out


def _rgb(v, default, name='颜色'):
    if v is None:
        return default
    _require(isinstance(v, (list, tuple)) and len(v) >= 3,
             '%s 必须是 [r,g,b]' % name)
    return tuple(int(max(0, min(255, c))) for c in v[:3])


def _s(v, default=''):
    if v is None:
        return default
    return v if isinstance(v, str) else str(v)


def write_result(out_path, payload):
    """原子写出 out.json（UTF-8、ensure_ascii=False）。"""
    tmp = out_path + '.tmp'
    with open(tmp, 'w', encoding='utf-8', newline='\n') as fh:
        json.dump(payload, fh, ensure_ascii=False)
        fh.write('\n')
    os.replace(tmp, out_path)


# ---------------------------------------------------------------- 图像载入

_IMG_CACHE = {}


def load_image(path):
    """按绝对路径载入图像（带缓存）。"""
    _require(isinstance(path, str) and path, 'path 必须是非空字符串')
    if path in _IMG_CACHE:
        return _IMG_CACHE[path]
    _require(os.path.isfile(path), '图像不存在：%s' % path)
    try:
        im = Image.open(path)
        im.load()
    except Exception as exc:
        _fail('图像无法解码：%s（%s）' % (path, exc))
    try:
        im = ImageOps.exif_transpose(im)
    except Exception:
        pass
    _IMG_CACHE[path] = im
    return im


def to_rgba(im):
    if im.mode == 'RGBA':
        return im
    if im.mode == 'P':
        return im.convert('RGBA')
    if im.mode in ('LA', 'PA'):
        return im.convert('RGBA')
    return im.convert('RGBA')


def save_like(im_rgba, out_path):
    """按输出扩展名保存；尽量还原输入模式（JPEG 不支持 alpha）。"""
    outdir = os.path.dirname(os.path.abspath(out_path))
    if outdir:
        os.makedirs(outdir, exist_ok=True)
    ext = os.path.splitext(out_path)[1].lower()
    if ext in ('.jpg', '.jpeg'):
        bg = Image.new('RGB', im_rgba.size, (255, 255, 255))
        bg.paste(im_rgba, (0, 0), im_rgba)
        bg.save(out_path, quality=95, subsampling=0)
        return im_rgba.size
    if ext == '.webp':
        im_rgba.save(out_path, quality=95)
        return im_rgba.size
    if ext in ('.bmp',):
        im_rgba.convert('RGB').save(out_path)
        return im_rgba.size
    im_rgba.save(out_path)
    return im_rgba.size


# ---------------------------------------------------------------- 字体

FONT_DIR = r'C:\Windows\Fonts'

# rank 越小越优先
FONT_CANDIDATES = [
    ('msyh', 'msyh.ttc', 0),
    ('msyhbd', 'msyhbd.ttc', 1),
    ('simhei', 'simhei.ttf', 2),
    ('simsun', 'simsun.ttc', 3),
    ('NotoSansSC-VF', 'NotoSansSC-VF.ttf', 4),
    ('Deng', 'Deng.ttf', 5),
    ('simkai', 'simkai.ttf', 6),
    ('simfang', 'simfang.ttf', 7),
    ('msjh', 'msjh.ttc', 8),
    ('msyhl', 'msyhl.ttc', 9),
    ('arial', 'arial.ttf', 20),
]

_CMAP_CACHE = {}
_FONT_CACHE = {}
_PROBE_CACHE = None


def _cmap_ranges_from_bytes(path, face_index=0):
    """直接从字体文件读 cmap 表，返回 {start, end} 区间列表。

    只依赖标准库 struct：覆盖 format 4 / 12（Windows/Unicode 平台），
    足以判断 CJK 覆盖。失败返回 None。
    """
    try:
        with open(path, 'rb') as fh:
            data = fh.read()
        if len(data) < 12:
            return None
        tag = data[:4]
        off = 0
        if tag == b'ttcf':
            n = struct.unpack('>I', data[8:12])[0]
            if n < 1 or 12 + 4 * n > len(data):
                return None
            face_index = min(face_index, n - 1)
            off = struct.unpack('>I', data[12 + 4 * face_index:16 + 4 * face_index])[0]
        if off + 12 > len(data):
            return None
        num_tables = struct.unpack('>H', data[off + 4:off + 6])[0]
        cmap_off = None
        for i in range(num_tables):
            rec = off + 12 + 16 * i          # sfnt 表目录项：tag/checksum/offset/length
            if rec + 16 > len(data):
                return None
            if data[rec:rec + 4] == b'cmap':
                cmap_off = struct.unpack('>I', data[rec + 8:rec + 12])[0]
                break
        if cmap_off is None or cmap_off + 4 > len(data):
            return None
        n_sub = struct.unpack('>H', data[cmap_off + 2:cmap_off + 4])[0]
        best = None
        for i in range(n_sub):
            rec = cmap_off + 4 + 8 * i
            if rec + 8 > len(data):
                break
            plat, enc = struct.unpack('>HH', data[rec:rec + 4])
            so = struct.unpack('>I', data[rec + 4:rec + 8])[0]
            if plat == 3 and enc == 10:
                score = 3
            elif plat == 0 and enc >= 4:
                score = 2
            elif plat == 3 and enc == 1:
                score = 1
            elif plat == 0:
                score = 1
            elif plat == 1 and enc == 0:
                score = 0  # Mac Roman，基本无 CJK
            else:
                continue
            if best is None or score >= best[0]:
                best = (score, so)
        if best is None:
            return None
        so = cmap_off + best[1]      # 子表偏移相对 cmap 表起始
        if so + 2 > len(data):
            return None
        fmt = struct.unpack('>H', data[so:so + 2])[0]
        ranges = []
        if fmt == 4:
            segx2 = struct.unpack('>H', data[so + 6:so + 8])[0]
            seg = segx2 // 2
            ends_off = so + 14
            starts_off = ends_off + 2 * seg + 2
            if seg == 0 or starts_off + 2 * seg > len(data):
                return None
            ends = struct.unpack('>%dH' % seg, data[ends_off:ends_off + 2 * seg])
            starts = struct.unpack('>%dH' % seg, data[starts_off:starts_off + 2 * seg])
            for k in range(seg):
                if starts[k] <= ends[k] and starts[k] != 0xFFFF:
                    ranges.append((starts[k], ends[k]))
        elif fmt == 12:
            ngroups = struct.unpack('>I', data[so + 12:so + 16])[0]
            base = so + 16
            if base + 12 * ngroups > len(data):
                return None
            for k in range(ngroups):
                s, e, _g = struct.unpack('>III', data[base + 12 * k:base + 12 * k + 12])
                ranges.append((s, e))
        elif fmt == 6:
            first = struct.unpack('>H', data[so + 6:so + 8])[0]
            cnt = struct.unpack('>H', data[so + 8:so + 10])[0]
            ranges.append((first, first + cnt - 1))
        else:
            return None
        return ranges
    except Exception:
        return None


def font_cmap(path):
    """取字体的 unicode 码点覆盖区间（TTC 取第一个 face）。失败返回 None。"""
    if path in _CMAP_CACHE:
        return _CMAP_CACHE[path]
    ranges = _cmap_ranges_from_bytes(path, 0)
    if ranges is None:
        # 兜底：FreeType 解析失败时，用字形索引判断（index == 0 表示缺字）
        ranges = []
        try:
            f = ImageFont.truetype(path, 20, index=0)
            for cp in (0x4F60, 0x597D, 0x3042, 0x41, 0x30, 0x20):
                idx = f.getmask(chr(cp)).getbbox()
                if idx:
                    ranges.append((cp, cp))
        except Exception:
            return None
    _CMAP_CACHE[path] = ranges
    return ranges


def _cmap_covers(ranges, cp):
    for s, e in ranges:
        if s <= cp <= e:
            return True
    return False


def font_has_cjk(path):
    cmap = font_cmap(path)
    if not cmap:
        return False
    return all(_cmap_covers(cmap, ord(ch)) for ch in '你好あ')


def pick_font(need_cjk=None, explicit=None, size=20):
    """挑选可用字体文件。need_cjk=None 表示按文本内容自动判定。"""
    if explicit:
        _require(os.path.isfile(explicit), '字体文件不存在：%s' % explicit)
        return explicit
    want_cjk = True if need_cjk is None else bool(need_cjk)

    def usable(p):
        return bool(p) and os.path.isfile(p) and bool(font_cmap(p))

    ordered = sorted(FONT_CANDIDATES, key=lambda r: r[2])
    if not want_cjk:
        for name, fn, rank in sorted(FONT_CANDIDATES, key=lambda r: r[2]):
            if name in ('msyh', 'arial'):
                p = os.path.join(FONT_DIR, fn)
                if usable(p):
                    return p
    for name, fn, rank in ordered:
        p = os.path.join(FONT_DIR, fn)
        if not usable(p):
            continue
        if not want_cjk:
            return p
        if font_has_cjk(p):
            return p
    if want_cjk:  # 兜底：扫描目录里任意 CJK 字体
        for f in scan_font_files():
            if f['cjk']:
                return f['path']
    for name, fn, rank in ordered:
        p = os.path.join(FONT_DIR, fn)
        if usable(p):
            return p
    _fail('找不到任何可用字体（%s）' % FONT_DIR)


def load_font(path, size):
    key = (path, int(size))
    if key not in _FONT_CACHE:
        try:
            _FONT_CACHE[key] = ImageFont.truetype(path, int(size), index=0)
        except Exception:
            _FONT_CACHE[key] = ImageFont.truetype(path, int(size))
    return _FONT_CACHE[key]


def scan_font_files(limit=400):
    """扫描 C:\\Windows\\Fonts，返回 [{name,path,cjk}]。"""
    if not os.path.isdir(FONT_DIR):
        return []
    names = []
    try:
        names = sorted(os.listdir(FONT_DIR))
    except Exception:
        return []
    out = []
    seen = set()
    count = 0
    for fn in names:
        low = fn.lower()
        if not low.endswith(('.ttf', '.ttc', '.otf')):
            continue
        if low.startswith('~'):
            continue
        path = os.path.join(FONT_DIR, fn)
        if not os.path.isfile(path) or path in seen:
            continue
        seen.add(path)
        cjk = font_has_cjk(path)
        if count >= limit and not cjk:
            continue
        count += 1
        out.append({'name': os.path.splitext(fn)[0], 'path': path, 'cjk': cjk})
    # 常用字体排前面，其余按名称
    rank = {os.path.splitext(f)[0].lower(): r for _, f, r in FONT_CANDIDATES}
    out.sort(key=lambda e: (rank.get(e['name'].lower(), 100), e['name'].lower()))
    return out


def report_fonts():
    """probe 用字体清单：优先常用字体，保证至少一个 cjk:true。"""
    global _PROBE_CACHE
    if _PROBE_CACHE is not None:
        return _PROBE_CACHE
    listed = []
    seen = set()
    for name, fn, rank in sorted(FONT_CANDIDATES, key=lambda r: r[2]):
        path = os.path.join(FONT_DIR, fn)
        if os.path.isfile(path) and font_cmap(path) is not None and path not in seen:
            seen.add(path)
            listed.append({'name': name, 'path': path, 'cjk': font_has_cjk(path)})
    extra = [f for f in scan_font_files(limit=12) if f['path'] not in seen and f['cjk']]
    listed.extend(extra[:12])
    if not any(f['cjk'] for f in listed):
        for f in scan_font_files(limit=400):
            if f['cjk']:
                listed.append(f)
                break
    _PROBE_CACHE = listed
    return listed


# ---------------------------------------------------------------- 形态学（纯 numpy 3x3）

def _dilate3(mask):
    # padded 视图坐标偏移：m[i,j] 对应原图 (i+1-r, j+1-c)
    p = np.pad(mask, 1, mode='constant', constant_values=False)
    acc = np.zeros(mask.shape, dtype=bool)
    for r in range(3):
        for c in range(3):
            if r == 1 and c == 1:
                continue
            np.logical_or(acc, p[r:r + mask.shape[0], c:c + mask.shape[1]], out=acc)
    np.logical_or(acc, mask, out=acc)
    return acc


def _erode3(mask):
    p = np.pad(mask, 1, mode='constant', constant_values=False)
    acc = np.ones(mask.shape, dtype=bool)
    for r in range(3):
        for c in range(3):
            np.logical_and(acc, p[r:r + mask.shape[0], c:c + mask.shape[1]], out=acc)
    return acc


def dilate(mask, times=1):
    for _ in range(max(0, int(times))):
        mask = _dilate3(mask)
    return mask


def erode(mask, times=1):
    for _ in range(max(0, int(times))):
        mask = _erode3(mask)
    return mask


# ---------------------------------------------------------------- 连通域（行程 + union-find）

def connected_components(mask):
    """对二值化图做 8 连通标记（行程编码 + 并查集），只遍历有墨迹的行。

    返回 (labels, count)；labels 为 int32，背景为 0。
    """
    h, w = mask.shape
    parent = []

    def find(a):
        root = a
        while parent[root] != root:
            root = parent[root]
        while parent[a] != root:
            parent[a], a = root, parent[a]
        return root

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    runs = []          # 每行 (starts, ends, ids)；无墨迹的行为 None
    for y in range(h):
        row = mask[y]
        cols = np.flatnonzero(row)
        if cols.size == 0:
            runs.append(None)
            continue
        cuts = np.flatnonzero(np.diff(cols) > 1)
        starts = cols[np.concatenate(([0], cuts + 1))]
        ends = cols[np.concatenate((cuts, [cols.size - 1]))]
        n = starts.size
        ids = np.arange(len(parent), len(parent) + n, dtype=np.int64)
        parent.extend(range(len(parent), len(parent) + n))
        runs.append((starts, ends, ids))
        if y == 0:
            continue
        prev = runs[y - 1]
        if prev is None:
            continue
        ps, pe, pids = prev
        i = j = 0
        n_prev = ps.size
        while i < n_prev and j < n:
            if pe[i] < starts[j] - 1:
                i += 1
            elif ends[j] < ps[i] - 1:
                j += 1
            else:
                union(int(pids[i]), int(ids[j]))
                if pe[i] < ends[j]:
                    i += 1
                else:
                    j += 1

    roots = {}
    labels = np.zeros((h, w), dtype=np.int32)
    for y in range(h):
        item = runs[y]
        if item is None:
            continue
        starts, ends, ids = item
        names = np.empty(ids.size, dtype=np.int32)
        for k in range(ids.size):
            r = find(int(ids[k]))
            lab = roots.get(r)
            if lab is None:
                lab = len(roots) + 1
                roots[r] = lab
            names[k] = lab
        row = labels[y]
        for k in range(starts.size):
            row[starts[k]:ends[k] + 1] = names[k]
    return labels, len(roots)


def _component_stats(labels, nlab):
    """用 bincount 统计每个连通域的像素数与包围盒（避免逐标签扫描）。"""
    h, w = labels.shape
    flat = labels.reshape(-1)
    counts = np.bincount(flat, minlength=nlab + 1)
    ys, xs = np.divmod(np.arange(flat.size, dtype=np.int64), w)
    nz = flat > 0
    idx = flat[nz]
    minx = np.full(nlab + 1, w, dtype=np.int64)
    miny = np.full(nlab + 1, h, dtype=np.int64)
    maxx = np.full(nlab + 1, -1, dtype=np.int64)
    maxy = np.full(nlab + 1, -1, dtype=np.int64)
    np.minimum.at(minx, idx, xs[nz])
    np.minimum.at(miny, idx, ys[nz])
    np.maximum.at(maxx, idx, xs[nz])
    np.maximum.at(maxy, idx, ys[nz])
    return counts, minx, miny, maxx, maxy


# ---------------------------------------------------------------- 区域检测

def _adaptive_mask(gray, win):
    """局部自适应二值化：局部均值 - 偏置。返回 (mask, local_mean)。"""
    g = gray.astype(np.float32)
    ii = np.zeros((gray.shape[0] + 1, gray.shape[1] + 1), dtype=np.float64)
    ii[1:, 1:] = np.cumsum(np.cumsum(g, axis=0), axis=1)
    ys = np.arange(gray.shape[0])
    xs = np.arange(gray.shape[1])
    y0 = np.clip(ys - win, 0, gray.shape[0])[:, None]
    y2 = np.clip(ys + win + 1, 0, gray.shape[0])[:, None]
    x0 = np.clip(xs - win, 0, gray.shape[1])[None, :]
    x2 = np.clip(xs + win + 1, 0, gray.shape[1])[None, :]
    s = ii[y2, x2] - ii[y0, x2] - ii[y2, x0] + ii[y0, x0]
    area = np.maximum(1, (y2 - y0) * (x2 - x0))
    mean = (s / area).astype(np.float32)
    return (g < mean - 6.0), mean


def _ink_ratio(gray, x0, y0, x1, y1, lmean):
    """盒内「比局部均值明显更暗」像素占比，作为墨迹密度。"""
    h, w = gray.shape
    x0 = max(0, min(w, int(x0)))
    x1 = max(0, min(w, int(x1)))
    y0 = max(0, min(h, int(y0)))
    y1 = max(0, min(h, int(y1)))
    if x1 <= x0 or y1 <= y0:
        return 0.0
    sub = gray[y0:y1, x0:x1]
    lm = lmean[y0:y1, x0:x1]
    return float(np.count_nonzero(sub < lm - 6.0)) / float(sub.size)


def _infer_kind(gray, x0, y0, x1, y1, shape):
    """启发式判定 kind（区域检测不依赖 OCR，只能给出粗分类）：
    bubble = 大块且极亮（白底气泡/对话框，字少留白多）；
    art    = 大号文字块（含描边艺术字）；
    其余为 text。
    """
    h, w = gray.shape
    x0 = max(0, min(w - 1, int(x0))); x1 = max(x0 + 1, min(w, int(x1)))
    y0 = max(0, min(h - 1, int(y0))); y1 = max(y0 + 1, min(h, int(y1)))
    sub = gray[y0:y1, x0:x1]
    if sub.size == 0:
        return 'text'
    bright = float(np.count_nonzero(sub > 200)) / float(sub.size)
    bh = y1 - y0
    if bh >= 34 and bright >= 0.75:
        return 'bubble'
    if bh >= 34 and bright < 0.92:
        return 'art'
    return 'text'


def detect_regions(im, hint='text', min_area=30, max_regions=60, max_dim=1600,
                   read_order='rtl'):
    """检测文本区域。返回 (regions, scale, det_shape)。"""
    ow, oh = im.size
    scale = 1.0
    if max_dim and max(ow, oh) > max_dim:
        scale = float(max_dim) / float(max(ow, oh))
    dw = max(1, int(round(ow * scale)))
    dh = max(1, int(round(oh * scale)))
    det = im.convert('L')
    if (dw, dh) != (ow, oh):
        det = det.resize((dw, dh), Image.LANCZOS)
    gray = np.asarray(det, dtype=np.uint8)

    win = 10
    mask, lmean = _adaptive_mask(gray, win)

    if hint == 'bubble':
        mask = dilate(mask, 1)
        mask = _erode3(mask)
        mask = dilate(mask, 5)
        mask = erode(mask, 4)
        mask = dilate(mask, 4)
    elif hint == 'art':
        mask = dilate(mask, 1)
        mask = erode(mask, 1)
        mask = dilate(mask, 7)
        mask = erode(mask, 3)
        mask = dilate(mask, 6)
    else:
        mask = dilate(mask, 1)
        mask = _erode3(mask)
        mask = dilate(mask, 5)
        mask = erode(mask, 2)
        mask = dilate(mask, 5)

    if not mask.any():
        return [], scale, (dw, dh)

    labels, nlab = connected_components(mask)
    counts, minx, miny, maxx, maxy = _component_stats(labels, nlab)

    min_h = 6 if hint == 'art' else 5
    min_w = 4
    max_w = 0.94 * dw
    max_h = (0.62 if hint == 'art' else 0.42) * dh
    max_aspect = 40.0

    cands = []
    for idx in range(1, nlab + 1):
        count = int(counts[idx])
        if count < min_area or maxx[idx] < 0:
            continue
        x0 = int(minx[idx]); x1 = int(maxx[idx]) + 1
        y0 = int(miny[idx]); y1 = int(maxy[idx]) + 1
        bw = x1 - x0
        bh = y1 - y0
        if bw < min_w or bh < min_h:
            continue
        if bw > max_w or bh > max_h:
            continue
        aspect = bw / float(bh)
        if aspect > max_aspect or aspect < 1.0 / max_aspect:
            continue
        ink = _ink_ratio(gray, x0, y0, x1, y1, lmean)
        if ink < 0.02:
            continue
        cands.append((x0, y0, x1, y1, ink))

    # 合并同行的邻近连通域 → 文本行 / 文本块
    cands.sort(key=lambda b: (b[1], b[0]))
    merged = []
    for b in cands:
        x0, y0, x1, y1, ink = b
        placed = False
        for i, m in enumerate(merged):
            my0, my1 = m[1], m[3]
            ov = min(y1, my1) - max(y0, my0)
            if ov <= 0:
                continue
            hmin = min(y1 - y0, my1 - my0)
            if ov < 0.5 * hmin:
                continue
            gap = max(x0 - m[2], m[0] - x1)
            if gap > 1.2 * max(hmin, 8):
                continue
            bw_o = m[2] - m[0]
            bw_n = x1 - x0
            # 断开量级差异过大的块（例如整幅标题 vs 单个气泡）
            if max(bw_o, bw_n) > 4.0 * max(1, min(bw_o, bw_n)) and gap > 12:
                continue
            area_old = (m[2] - m[0]) * (m[3] - m[1])
            area_new = (x1 - x0) * (y1 - y0)
            if max(area_old, area_new) / float(max(1, min(area_old, area_new))) > 24:
                continue
            merged[i] = (min(m[0], x0), min(m[1], y0), max(m[2], x1), max(m[3], y1),
                         (m[4] * area_old + ink * area_new) / float(area_old + area_new))
            placed = True
            break
        if not placed:
            merged.append((x0, y0, x1, y1, ink))

    # 投影切分：块内出现足够宽的空白带时拆成多个区域（气泡之间、多列之间）
    def split_axis(box, axis, depth):
        bx0, by0, bx1, by1, _bk = box
        if depth <= 0:
            return [box]
        sub = mask[by0:by1, bx0:bx1]
        if sub.size == 0:
            return [box]
        if axis == 'x':
            proj = sub.any(axis=0)
            thresh = max(6, int(0.6 * (by1 - by0)))
        else:
            proj = sub.any(axis=1)
            thresh = max(6, int(0.6 * (bx1 - bx0)))
        n = proj.size
        i = 0
        pieces = []
        while i < n:
            if proj[i]:
                s = i
                while i < n and proj[i]:
                    i += 1
                e = i
                if pieces and (s - pieces[-1][1]) >= thresh:
                    pieces.append([s, e])
                elif pieces:
                    pieces[-1][1] = e
                else:
                    pieces.append([s, e])
            else:
                i += 1
        if len(pieces) < 2:
            return [box]
        out_boxes = []
        for s, e in pieces:
            if axis == 'x':
                nb = (bx0 + s, by0, bx0 + e, by1, 0.0)
            else:
                nb = (bx0, by0 + s, bx1, by0 + e, 0.0)
            if (nb[2] - nb[0]) < 3 or (nb[3] - nb[1]) < 3:
                continue
            out_boxes.append(split_axis(nb, 'y' if axis == 'x' else 'x', depth - 1))
        flat = [b for grp in out_boxes for b in grp]
        return flat if flat else [box]

    split_boxes = []
    for m in merged:
        split_boxes.extend(split_axis(m, 'x', 2))

    # 切分后再补一轮重叠合并（只合并明显重叠的）
    changed = True
    while changed and len(split_boxes) > 1:
        changed = False
        out = []
        for b in split_boxes:
            hit = -1
            for i, m in enumerate(out):
                ov_y = min(b[3], m[3]) - max(b[1], m[1])
                ov_x = min(b[2], m[2]) - max(b[0], m[0])
                if ov_y > 0 and ov_x > 0.3 * min(b[2] - b[0], m[2] - m[0]):
                    hit = i
                    break
            if hit < 0:
                out.append(b)
            else:
                m = out[hit]
                out[hit] = (min(m[0], b[0]), min(m[1], b[1]), max(m[2], b[2]),
                            max(m[3], b[3]), max(m[4], b[4]))
                changed = True
        split_boxes = out
    merged = []
    for b in split_boxes:
        ink = _ink_ratio(gray, b[0], b[1], b[2], b[3], lmean)
        if ink < 0.02:
            continue
        bw = b[2] - b[0]
        bh = b[3] - b[1]
        if bw > max_w or bh > max_h:
            continue
        merged.append((b[0], b[1], b[2], b[3], ink))

    inv = 1.0 / scale if scale else 1.0
    regions = []
    for x0, y0, x1, y1, ink in merged:
        ox0 = int(round(x0 * inv)); oy0 = int(round(y0 * inv))
        ox1 = int(round(x1 * inv)); oy1 = int(round(y1 * inv))
        ox0 = max(0, min(ow - 1, ox0)); oy0 = max(0, min(oh - 1, oy0))
        ox1 = max(ox0 + 1, min(ow, ox1)); oy1 = max(oy0 + 1, min(oh, oy1))
        kind = _infer_kind(gray, x0, y0, x1, y1, (dw, dh))
        if hint in ('bubble', 'art', 'text') and hint != 'text':
            # hint 只是倾向，不强行覆盖启发式判定结果
            pass
        regions.append({'x': ox0, 'y': oy0, 'w': ox1 - ox0, 'h': oy1 - oy0,
                        'kind': kind, 'ink': round(float(ink), 4)})

    # 阅读顺序：上→下分行，行内漫画风右→左（rtl）或左→右（ltr）
    regions.sort(key=lambda r: (r['y'], -r['x'] if read_order != 'ltr' else r['x']))
    lines = []
    for r in regions:
        cy = r['y'] + r['h'] / 2.0
        placed = False
        for ln in lines:
            ref = ln[0]
            if abs(cy - (ref['y'] + ref['h'] / 2.0)) <= 0.6 * max(ref['h'], r['h']):
                ln.append(r)
                placed = True
                break
        if not placed:
            lines.append([r])
    lines.sort(key=lambda ln: min(r['y'] for r in ln))
    final = []
    for ln in lines:
        ln.sort(key=lambda r: -r['x'] if read_order != 'ltr' else r['x'])
        final.extend(ln)

    if max_regions and len(final) > max_regions:
        # 按面积优先保留，再恢复阅读顺序
        keep = sorted(final, key=lambda r: -(r['w'] * r['h']))[:max_regions]
        ids = {id(r) for r in keep}
        final = [r for r in final if id(r) in ids]
    return final, scale, (dw, dh)


# ---------------------------------------------------------------- 擦除

def _region_array(im_rgba, x0, y0, x1, y1):
    arr = np.asarray(im_rgba, dtype=np.uint8)
    x0 = max(0, min(arr.shape[1], int(np.floor(x0))))
    x1 = max(0, min(arr.shape[1], int(np.ceil(x1))))
    y0 = max(0, min(arr.shape[0], int(np.floor(y0))))
    y1 = max(0, min(arr.shape[0], int(np.ceil(y1))))
    if x1 < x0:
        x0, x1 = x1, x0
    if y1 < y0:
        y0, y1 = y1, y0
    return arr[y0:y1, x0:x1], (x0, y0, x1, y1)


def rect_bounds(im, box):
    """把 [x,y,w,h] 裁剪到图像范围内，返回整数 (x0,y0,x1,y1)。"""
    W, H = im.size
    x0 = max(0, min(W, int(np.floor(box[0]))))
    y0 = max(0, min(H, int(np.floor(box[1]))))
    x1 = max(0, min(W, int(np.ceil(box[0] + box[2]))))
    y1 = max(0, min(H, int(np.ceil(box[1] + box[3]))))
    if x1 < x0:
        x0, x1 = x1, x0
    if y1 < y0:
        y0, y1 = y1, y0
    return x0, y0, x1, y1


def ring_color(im_rgba, box, pad=0.0, ring=4):
    """采样框外一圈像素，返回主色（中位数）。"""
    arr, (x0, y0, x1, y1) = _region_array(im_rgba,
                                          box[0] - pad - ring, box[1] - pad - ring,
                                          box[0] + box[2] + pad + ring,
                                          box[1] + box[3] + pad + ring)
    h, w = arr.shape[:2]
    if h < 1 or w < 1:
        return None
    rin = max(1, int(ring))
    top = arr[:min(rin, h), :, :3].reshape(-1, 3)
    bot = arr[max(0, h - rin):h, :, :3].reshape(-1, 3)
    lef = arr[:, :min(rin, w), :3].reshape(-1, 3)
    rig = arr[:, max(0, w - rin):w, :3].reshape(-1, 3)
    px = np.concatenate([top, bot, lef, rig], axis=0)
    if px.size == 0:
        return None
    px = px.astype(np.float32)
    med = np.median(px, axis=0)
    # 圈内可能混入被截断的墨迹，取与中位数接近的像素再求一次中位数
    keep = np.abs(px - med.reshape(1, 3)).max(axis=1) < 60
    if np.count_nonzero(keep) >= max(8, px.shape[0] // 20):
        med = np.median(px[keep], axis=0)
    return med


def _bg_fill_array(arr, tol=34, cell=16):
    """估计框内的背景色图：把框按 cell 降采样，只保留背景像素，再平滑放大回来。

    这样擦除大字/渐变底时能保留底色与渐变，而不是糊成一块纯色。
    """
    h, w = arr.shape[:2]
    rgb = arr[:, :, :3].astype(np.float32)
    med = np.median(rgb.reshape(-1, 3), axis=0)
    ink = np.abs(rgb - med.reshape(1, 1, 3)).max(axis=2) > tol
    cw = max(1, int(np.ceil(w / float(cell))))
    ch = max(1, int(np.ceil(h / float(cell))))
    coarse = np.zeros((ch, cw, 3), dtype=np.uint8)
    has = np.zeros((ch, cw), dtype=bool)
    for cy in range(ch):
        for cx in range(cw):
            blk = rgb[cy * cell:(cy + 1) * cell, cx * cell:(cx + 1) * cell]
            m = ~ink[cy * cell:(cy + 1) * cell, cx * cell:(cx + 1) * cell]
            if blk.size == 0:
                continue
            if m.any():
                coarse[cy, cx] = np.median(blk[m], axis=0).astype(np.uint8)
                has[cy, cx] = True
            else:
                coarse[cy, cx] = med.astype(np.uint8)
                has[cy, cx] = False
    if not has.any():
        return None
    # 背景格的最近邻距离（以格为单位），没有背景的格子沿用最近背景色
    ys, xs = np.nonzero(has)
    gy, gx = np.mgrid[0:ch, 0:cw]
    d2 = None
    for k in range(ys.size):
        dd = (gy - ys[k]) ** 2 + (gx - xs[k]) ** 2
        d2 = dd if d2 is None else np.minimum(d2, dd)
    order = np.argsort(d2, axis=None)
    fy, fx = np.unravel_index(order, d2.shape)
    filled = coarse[fy, fx]           # 每个格取最近的背景格颜色
    filled = filled.reshape(ch, cw, 3)
    im = Image.fromarray(filled, 'RGB')
    if (cw, ch) != (w, h):
        im = im.resize((w, h), Image.BILINEAR)
    return np.asarray(im, dtype=np.float32), np.sqrt(d2)


def erase_fill(im_rgba, box, color, tol=34, grow=1):
    """把框内与背景差异大的像素（原文墨迹）替换成背景色，返回改动量。"""
    arr, (x0, y0, x1, y1) = _region_array(im_rgba, box[0], box[1],
                                          box[0] + box[2], box[1] + box[3])
    if arr.size == 0:
        return 0
    c = np.asarray(color, dtype=np.int16).reshape(1, 1, 3)
    diff = np.abs(arr[:, :, :3].astype(np.int16) - c).max(axis=2)
    m = diff > tol
    if arr.shape[2] == 4:
        m |= arr[:, :, 3] > 8
    if grow > 0:
        m = dilate(m, grow)
    if not m.any():
        return 0
    new = arr.copy()
    bg = _bg_fill_array(arr, tol)
    if bg is not None:
        fill, dist = bg
        # 距离背景格过远（大块实心墨迹）的地方用圈外主色兜底
        fallback = np.asarray(color, dtype=np.float32).reshape(1, 1, 3)
        far = dist > 2.5
        if far.any():
            up = np.asarray(Image.fromarray(
                (far * 255).astype(np.uint8), 'L').resize(
                (arr.shape[1], arr.shape[0]), Image.NEAREST)) > 127
            fill = np.where(up[:, :, None], fallback, fill)
        # 整块背景过于均匀时，说明框附近本来就没有可用底色，退回圈外主色
        if float(fill.reshape(-1, 3).std(axis=0).max()) < 0.5:
            fill = np.broadcast_to(fallback, fill.shape)
        px = np.clip(fill, 0, 255).astype(np.uint8)
    else:
        px = np.broadcast_to(np.asarray(color, dtype=np.uint8).reshape(1, 1, 3),
                             (arr.shape[0], arr.shape[1], 3))
    new[:, :, 0][m] = px[:, :, 0][m]
    new[:, :, 1][m] = px[:, :, 1][m]
    new[:, :, 2][m] = px[:, :, 2][m]
    if new.shape[2] == 4:
        new[:, :, 3][m] = 255
    im_rgba.paste(Image.fromarray(new, 'RGBA'), (x0, y0))
    return int(np.count_nonzero(m))


def rect_fill(im_rgba, box, color):
    x0, y0, x1, y1 = rect_bounds(im_rgba, box)
    if x1 <= x0 or y1 <= y0:
        return
    patch = Image.new('RGBA', (x1 - x0, y1 - y0), tuple(int(c) for c in color) + (255,))
    im_rgba.paste(patch, (x0, y0))


def ink_snapshot(im_rgba, box, bg, tol=34):
    """统计框内与背景色差异大的像素数（用于判新旧墨迹）。"""
    arr, _ = _region_array(im_rgba, box[0], box[1], box[0] + box[2], box[1] + box[3])
    if arr.size == 0:
        return 0, 0
    c = np.asarray(bg, dtype=np.int16).reshape(1, 1, 3)
    diff = np.abs(arr[:, :, :3].astype(np.int16) - c).max(axis=2)
    return int(np.count_nonzero(diff > tol)), int(arr.shape[0] * arr.shape[1])


# ---------------------------------------------------------------- 排版：断行 / 自动字号

_CJK_RE = re.compile(
    '[\u1100-\u11ff\u2e80-\u303f\u3040-\u30ff\u3130-\u318f\u31c0-\u31ef'
    '\u3400-\u4dbf\u4e00-\u9fff\ua960-\ua97f\uac00-\ud7ff\uf900-\ufaff'
    '\ufe30-\ufe4f\uff00-\uffef]')
_WS_RE = re.compile(r'\s+')


def _is_cjk(ch):
    return bool(_CJK_RE.match(ch))


def tokens_of(text):
    """最小排版单元：CJK 单字成 token，拉丁按词，空白单独成 token。"""
    toks = []
    buf = []
    for ch in text:
        if ch in '\r\n':
            continue
        if _is_cjk(ch):
            if buf:
                toks.append(('w', ''.join(buf))); buf = []
            toks.append(('c', ch))
        elif ch.isspace():
            if buf:
                toks.append(('w', ''.join(buf))); buf = []
            toks.append(('s', ' '))
        elif ord(ch) < 32:
            continue
        else:
            buf.append(ch)
    if buf:
        toks.append(('w', ''.join(buf)))
    return toks


def _tw(font, s):
    try:
        return float(font.getlength(s))
    except Exception:
        return float(font.getsize(s)[0])


def layout_lines(text, font, max_w):
    """按框宽断行。返回 (行文本列表, 每行宽, 每行高)。"""
    toks = tokens_of(text)
    lines = []
    cur = []
    cur_w = 0.0
    for kind, s in toks:
        if kind == 's' and not cur:
            continue  # 行首空白丢弃
        tw = _tw(font, s)
        if kind == 's':
            if cur_w + tw > max_w:
                lines.append(''.join(cur)); cur = []; cur_w = 0.0
                continue
            cur.append(s); cur_w += tw
            continue
        if cur_w + tw > max_w and cur:
            # 拉丁词放不下时，若当前行末尾是空白则先去掉再换行
            while cur and cur[-1] == ' ':
                cur.pop()
            lines.append(''.join(cur)); cur = []; cur_w = 0.0
        cur.append(s)
        cur_w += tw
    if cur:
        while cur and cur[-1] == ' ':
            cur.pop()
        if cur:
            lines.append(''.join(cur))
    if not lines:
        lines = ['']
    widths = [_tw(font, ln) for ln in lines]
    _, descent = font.getmetrics()
    bbox_h = [_glyph_h(font, ln, descent) for ln in lines]
    return lines, widths, bbox_h


def _glyph_h(font, line, descent):
    if not line:
        return float(font.getmetrics()[0] + descent)
    try:
        l, t, r, b = font.getbbox(line)
        return float(max(1, b - t))
    except Exception:
        a, d = font.getmetrics()
        return float(a + d)


def measure_layout(text, font, max_w, max_h, line_spacing=1.15, stroke_w=0):
    """测量某个字号能否放进框。返回 dict。"""
    sw = max(0.0, float(stroke_w or 0))
    avail_w = max(1.0, max_w - sw)
    avail_h = max(1.0, max_h - sw)
    lines, widths, heights = layout_lines(text, font, avail_w)
    asc, desc = font.getmetrics()
    lead = max(1.0, float(line_spacing) * (asc + desc))
    total = lead * (len(lines) - 1) + (heights[-1] if lines else lead) + sw
    widest = max(widths) if widths else 0.0
    return {
        'lines': lines,
        'n': len(lines),
        'widest': widest,
        'widths': widths,
        'heights': heights,
        'asc': asc,
        'desc': desc,
        'lead': lead,
        'total': total,
        'fits': bool(widest <= avail_w + 0.5 and total <= avail_h + 0.5),
    }


def fit_font(text, font_path, box_w, box_h, max_size, min_size=8,
             line_spacing=1.15, stroke_w=0):
    """从 max_size 递减到 min_size 找第一个放得下的字号。

    都不放下时返回最小字号（min_size）的布局，调用方据此报 fits:false。
    """
    top = max(int(min_size), int(max_size))
    fallback = None
    for size in range(top, int(min_size) - 1, -1):
        font = load_font(font_path, size)
        lay = measure_layout(text, font, box_w, box_h, line_spacing, stroke_w)
        lay['size'] = size
        lay['font'] = font
        if lay['fits']:
            return lay
        if size == int(min_size):
            fallback = lay
    if fallback is not None:
        return fallback
    font = load_font(font_path, int(min_size))
    lay = measure_layout(text, font, box_w, box_h, line_spacing, stroke_w)
    lay['size'] = int(min_size)
    lay['font'] = font
    return lay


def draw_text_block(im_rgba, box, lay, color, stroke_color, stroke_w, align, valign):
    """按布局把文本画进框；返回是否全部落在框内。"""
    x = float(box[0]); y = float(box[1]); w = float(box[2]); h = float(box[3])
    lines = lay['lines']
    lead = lay['lead']
    sw = max(0.0, float(stroke_w or 0))
    asc = lay['asc']
    total = lay['total']
    if valign == 'bottom':
        first = y + h - total + sw / 2.0
    elif valign == 'middle':
        first = y + (h - total) / 2.0 + sw / 2.0
    else:
        first = y + sw / 2.0
    layer = Image.new('RGBA', im_rgba.size, (0, 0, 0, 0))
    dr = ImageDraw.Draw(layer)
    fit = True
    for i, ln in enumerate(lines):
        if not ln:
            continue
        lw = lay['widths'][i]
        if align == 'center':
            lx = x + (w - lw) / 2.0
        elif align == 'right':
            lx = x + (w - lw - sw / 2.0)
        else:
            lx = x + sw / 2.0
        base_y = first + i * lead
        # 单行超宽（例如整段无断点的长词）→ fits:false
        if lw > w + 0.5 or base_y + lay['heights'][i] > y + h + 1.0:
            fit = False
        dr.text((lx + sw, base_y + sw), ln, font=lay['font'], fill=tuple(color) + (255,),
                stroke_width=int(round(sw)), stroke_fill=tuple(stroke_color) + (255,))
    im_rgba.alpha_composite(layer)
    return fit


# ---------------------------------------------------------------- 各 op 实现

def op_probe(payload):
    import PIL
    fonts = report_fonts()
    return {
        'ok': True,
        'python': '%d.%d' % (sys.version_info[0], sys.version_info[1]),
        'pythonFull': sys.version.split()[0],
        'pillow': getattr(PIL, '__version__', '?'),
        'numpy': np.__version__,
        'fonts': fonts,
        'fontDir': FONT_DIR,
        'stitch': True,          # 声明支持 stitch op（多图拼接整体 OCR）
    }


def op_regions(payload):
    images = payload.get('images')
    _require(isinstance(images, list) and images, 'images 必须是非空数组')
    min_area = _int(payload.get('minArea'), 30, 'minArea')
    max_regions = _int(payload.get('maxRegions'), 60, 'maxRegions') or 60
    max_dim = _int(payload.get('maxDim'), 1600, 'maxDim') or 1600
    read_order = _s(payload.get('readOrder'), 'rtl')
    results = []
    for item in images:
        _require(isinstance(item, dict), 'images 元素必须是对象')
        path = item.get('path')
        im = load_image(path)
        hint = _s(item.get('hint'), 'text')
        _require(hint in ('text', 'bubble', 'art'), '不支持的 hint：%s' % hint)
        regs, scale, det = detect_regions(im, hint, min_area, max_regions, max_dim,
                                          read_order)
        log('regions %s hint=%s det=%dx%d scale=%.3f -> %d'
            % (path, hint, det[0], det[1], scale, len(regs)))
        results.append({
            'path': path,
            'width': im.size[0],
            'height': im.size[1],
            'hint': hint,
            'detectWidth': det[0],
            'detectHeight': det[1],
            'regions': regs,
        })
    return {'ok': True, 'results': results}


def op_crop(payload):
    items = payload.get('items')
    _require(isinstance(items, list) and items, 'items 必须是非空数组')
    files = []
    for it in items:
        _require(isinstance(it, dict), 'items 元素必须是对象')
        path = it.get('path')
        box = _box4(it.get('box'))
        _require(box[2] > 0 and box[3] > 0, '空框（w/h 必须 > 0）：%r' % (box,))
        out = it.get('out')
        _require(isinstance(out, str) and out, 'out 必须是非空字符串')
        im = load_image(path)
        W, H = im.size
        x0 = max(0, int(np.floor(box[0])))
        y0 = max(0, int(np.floor(box[1])))
        x1 = min(W, int(np.ceil(box[0] + box[2])))
        y1 = min(H, int(np.ceil(box[1] + box[3])))
        _require(x1 > x0 and y1 > y0, '框与图像无交集：%r 图像 %dx%d' % (box, W, H))
        crop = im.crop((x0, y0, x1, y1))
        scale = it.get('scale')
        if scale is not None:
            s = _num(scale, 1.0, 'scale')
            _require(s > 0, 'scale 必须 > 0')
            nw = max(1, int(round(crop.size[0] * s)))
            nh = max(1, int(round(crop.size[1] * s)))
            crop = crop.resize((nw, nh), Image.LANCZOS)
        odir = os.path.dirname(os.path.abspath(out))
        if odir:
            os.makedirs(odir, exist_ok=True)
        crop.save(out)
        files.append({'out': out, 'w': crop.size[0], 'h': crop.size[1],
                      'source': {'x': x0, 'y': y0, 'w': x1 - x0, 'h': y1 - y0}})
    return {'ok': True, 'files': files}


def _is_latin_only(text):
    for ch in text:
        if ord(ch) > 0x250 or _is_cjk(ch):
            return False
    return True


def _erase_box(im, box2, erase, erase_color, pad):
    """按 erase 模式处理一个框（绘制路径与「只擦除」路径共用）。

    返回 (fill_color, 原墨迹数, 擦除像素数, 擦除后墨迹数)；行为与旧实现完全一致。
    """
    ring = max(2, min(6, int(round(min(box2[2], box2[3]) * 0.06))))
    bg = ring_color(im, box2, pad, ring)
    if bg is None:
        bg = np.array(erase_color, dtype=np.float64)
    fill_color = erase_color if erase == 'rect' else tuple(int(c) for c in bg)
    old_ink, box_px = ink_snapshot(im, box2, fill_color)
    erased = 0
    if erase == 'rect':
        rect_fill(im, box2, fill_color)
        erased = box_px
    elif erase == 'auto':
        erased = erase_fill(im, box2, fill_color, 34, 1)
    new_ink0, _ = ink_snapshot(im, box2, fill_color)
    return fill_color, old_ink, erased, new_ink0


def op_typeset(payload):
    items = payload.get('items')
    _require(isinstance(items, list) and items, 'items 必须是非空数组')
    files = []
    for it in items:
        _require(isinstance(it, dict), 'items 元素必须是对象')
        path = it.get('path')
        out = it.get('out')
        _require(isinstance(out, str) and out, 'out 必须是非空字符串')
        _require(os.path.isfile(path or ''), '图像不存在：%s' % path)
        ops = it.get('ops')
        _require(isinstance(ops, list) and ops, 'ops 必须是非空数组')

        src = load_image(path)
        src_mode = src.mode
        im = to_rgba(src).copy()
        W, H = im.size
        report = []
        for k, o in enumerate(ops):
            _require(isinstance(o, dict), 'ops[%d] 必须是对象' % k)
            box = _box4(o.get('box'), 'ops[%d].box' % k)
            text = _s(o.get('text'), '')
            style = o.get('style') or {}
            _require(isinstance(style, dict), 'ops[%d].style 必须是对象' % k)
            if not text:
                # text 为空字符串/缺失：erase=auto/rect 时「只擦除不绘制」（图片字体
                # 导出用：整句译文画在联合框里，其余碎片框只擦不画）；
                # erase=none 时保持旧的空操作语义与返回字段。
                erase_only = _s(style.get('erase'), 'auto')
                _require(erase_only in ('auto', 'rect', 'none'),
                         '不支持的 erase：%s' % erase_only)
                if erase_only == 'none':
                    report.append({'box': box, 'fontSize': 0, 'lines': 0, 'fits': True,
                                   'skipped': 'empty text'})
                    continue
                ocx0, ocy0, ocx1, ocy1 = rect_bounds(im, box)
                _require(ocx1 > ocx0 and ocy1 > ocy0, 'ops[%d] 的框与图像无交集' % k)
                ox, oy = float(ocx0), float(ocy0)
                ow, oh = float(ocx1 - ocx0), float(ocy1 - ocy0)
                opad = max(0.0, _num(style.get('padding'), 2, 'padding'))
                ocolor = _rgb(style.get('eraseColor'), (255, 255, 255), 'eraseColor')
                obox2 = [ox, oy, ow, oh]
                ofill, oold, oerased, onew0 = _erase_box(im, obox2, erase_only,
                                                         ocolor, opad)
                report.append({
                    'box': obox2,
                    'mode': 'erase-only',
                    'fontSize': 0,
                    'lines': 0,
                    'fits': True,
                    'eraseColor': [int(c) for c in ofill],
                    'erasedPixels': int(oerased),
                    'inkBefore': int(oold),
                    'inkAfterErase': int(onew0),
                    'inkFinal': int(onew0),
                    'lineWidths': [],
                })
                log('typeset %s box=%s erase-only erased=%d'
                    % (os.path.basename(out), [round(v) for v in obox2],
                       report[-1]['erasedPixels']))
                continue
            cx0, cy0, cx1, cy1 = rect_bounds(im, box)
            _require(cx1 > cx0 and cy1 > cy0, 'ops[%d] 的框与图像无交集' % k)
            x, y = float(cx0), float(cy0)
            w, h = float(cx1 - cx0), float(cy1 - cy0)

            align = _s(style.get('align'), 'left')
            valign = _s(style.get('valign'), 'top')
            _require(align in ('left', 'center', 'right'), '不支持的 align：%s' % align)
            _require(valign in ('top', 'middle', 'bottom'), '不支持的 valign：%s' % valign)
            color = _rgb(style.get('color'), (0, 0, 0), 'color')
            stroke_color = _rgb(style.get('stroke'), (255, 255, 255), 'stroke')
            stroke_w = max(0.0, _num(style.get('strokeWidth'), 0, 'strokeWidth'))
            line_spacing = _num(style.get('lineSpacing'), 1.15, 'lineSpacing')
            _require(line_spacing > 0, 'lineSpacing 必须 > 0')
            pad = max(0.0, _num(style.get('padding'), 2, 'padding'))
            erase = _s(style.get('erase'), 'auto')
            _require(erase in ('auto', 'rect', 'none'), '不支持的 erase：%s' % erase)
            erase_color = _rgb(style.get('eraseColor'), (255, 255, 255), 'eraseColor')
            font_size_req = style.get('fontSize')
            max_font = _int(style.get('maxFontSize'), None, 'maxFontSize')

            box2 = [x, y, w, h]
            fill_color, old_ink, erased, new_ink0 = _erase_box(im, box2, erase,
                                                               erase_color, pad)

            need_cjk = not _is_latin_only(text)
            font_path = pick_font(need_cjk=need_cjk, explicit=style.get('fontPath'))
            avail_w = max(1.0, w - pad * 2 - stroke_w)
            avail_h = max(1.0, h - pad * 2 - stroke_w)
            if font_size_req is not None:
                size_req = max(1, _int(font_size_req, 0, 'fontSize'))
                font = load_font(font_path, size_req)
                lay = measure_layout(text, font, avail_w, avail_h, line_spacing, stroke_w)
                lay['size'] = size_req
                lay['font'] = font
                top = size_req
            else:
                top = int(max(1, min(max_font or int(h - pad * 2), int(h - pad * 2))))
                lay = fit_font(text, font_path, avail_w, avail_h, top, 8,
                               line_spacing, stroke_w)

            fits = bool(lay.get('fits'))
            if fits is None:
                fits = False
            inner = [x + pad, y + pad, max(1.0, w - pad * 2), max(1.0, h - pad * 2)]
            drawn = draw_text_block(im, inner, lay, color, stroke_color, stroke_w,
                                    align, valign)
            new_ink, _ = ink_snapshot(im, box2, fill_color)
            report.append({
                'box': [x, y, w, h],
                'mode': 'draw',
                'fontSize': int(lay.get('size', 0)),
                'lines': int(lay.get('n', 0)),
                'fits': bool(fits and drawn),
                'font': font_path,
                'eraseColor': [int(c) for c in fill_color],
                'erasedPixels': int(erased),
                'inkBefore': int(old_ink),
                'inkAfterErase': int(new_ink0),
                'inkFinal': int(new_ink),
                'lineWidths': [round(float(v), 1) for v in lay.get('widths', [])],
            })
            log('typeset %s box=%s size=%d lines=%d fits=%s'
                % (os.path.basename(out), [round(v) for v in box2],
                   report[-1]['fontSize'], report[-1]['lines'], report[-1]['fits']))

        odir = os.path.dirname(os.path.abspath(out))
        if odir:
            os.makedirs(odir, exist_ok=True)
        ext = os.path.splitext(out)[1].lower()
        save_im = im
        if ext in ('.jpg', '.jpeg'):
            pass                      # save_like 会自动合成白底并去 alpha
        elif ext in ('.png', '.webp', '.bmp'):
            if src_mode in ('L', 'LA'):
                save_im = im.convert('LA' if src_mode == 'LA' else 'L')
            elif src_mode == 'RGB':
                save_im = im.convert('RGB')
            # P 模式保持 RGBA：PNG 原生支持 alpha，量化回 P 反而丢透明度
        save_like(save_im, out)
        files.append({'out': out, 'w': im.size[0], 'h': im.size[1], 'ops': report})
    return {'ok': True, 'files': files}


def op_resize(payload):
    items = payload.get('items')
    _require(isinstance(items, list) and items, 'items 必须是非空数组')
    files = []
    for it in items:
        _require(isinstance(it, dict), 'items 元素必须是对象')
        path = it.get('path')
        out = it.get('out')
        _require(isinstance(out, str) and out, 'out 必须是非空字符串')
        max_dim = _int(it.get('maxDim'), 1600, 'maxDim')
        _require(max_dim and max_dim > 0, 'maxDim 必须 > 0')
        im = load_image(path)
        W, H = im.size
        longest = max(W, H)
        if longest <= max_dim:
            new = im.copy()
        else:
            s = float(max_dim) / float(longest)
            new = im.resize((max(1, int(round(W * s))), max(1, int(round(H * s)))),
                            Image.LANCZOS)
        odir = os.path.dirname(os.path.abspath(out))
        if odir:
            os.makedirs(odir, exist_ok=True)
        new.save(out)
        files.append({'out': out, 'w': new.size[0], 'h': new.size[1],
                      'srcWidth': W, 'srcHeight': H, 'maxDim': max_dim})
    return {'ok': True, 'files': files}


# ---------------------------------------------------------------- 拼图（图片字体 → 整体 OCR）

_STITCH_TOL = 34


def _edge_median_color(arr):
    """四边像素的中位色（RGBA 只统计不透明像素）。

    四边全透明 → 返回 None，表示这张图的背景本身就是透明的。
    """
    h, w = arr.shape[:2]
    if h < 1 or w < 1:
        return None
    if arr.shape[2] == 4:
        a = arr[:, :, 3]
        edge = np.zeros((h, w), dtype=bool)
        edge[0, :] = True
        edge[h - 1, :] = True
        edge[:, 0] = True
        edge[:, w - 1] = True
        sel = edge & (a > 8)
        if not sel.any():
            return None
        px = arr[:, :, :3][sel]
    else:
        px = np.concatenate([arr[0, :, :3], arr[h - 1, :, :3],
                             arr[:, 0, :3], arr[:, w - 1, :3]], axis=0)
    if px.size == 0:
        return None
    return np.median(px.astype(np.float32), axis=0)


def _ink_mask(arr, bg, tol=_STITCH_TOL):
    """墨迹掩膜：与背景色差异大（RGBA 且背景透明时，即「不透明」）的像素。"""
    if arr.shape[2] == 4:
        opaque = arr[:, :, 3] > 8
        if bg is None:
            return opaque
        d = np.abs(arr[:, :, :3].astype(np.int16)
                   - np.asarray(bg, dtype=np.int16).reshape(1, 1, 3)).max(axis=2)
        return opaque & (d > tol)
    d = np.abs(arr[:, :, :3].astype(np.int16)
               - np.asarray(bg, dtype=np.int16).reshape(1, 1, 3)).max(axis=2)
    return d > tol


def _mask_bbox(mask):
    """二值掩膜包围盒 (x0, y0, x1, y1)；全空返回 None。"""
    ys = np.flatnonzero(mask.any(axis=1))
    xs = np.flatnonzero(mask.any(axis=0))
    if ys.size == 0 or xs.size == 0:
        return None
    return int(xs[0]), int(ys[0]), int(xs[-1]) + 1, int(ys[-1]) + 1


def _stitch_bg_color(arr, mask, given):
    """画布背景色：给了 bg 就用 bg；否则取第一张图墨迹包围盒「外圈」的中位色。

    与 typeset 的 auto 擦除同口径（ring_color）。背景透明的图无法采样，
    降级为按墨迹亮度选黑/白底（浅色字配黑底、深色字配白底）。
    """
    if given is not None:
        return tuple(int(c) for c in given)
    edge = _edge_median_color(arr)
    sampled = None
    bb = _mask_bbox(mask)
    if bb is not None:
        bw, bh = bb[2] - bb[0], bb[3] - bb[1]
        if bw > 0 and bh > 0:
            ring = max(2, min(6, int(round(min(bw, bh) * 0.06))))
            rgba = Image.fromarray(np.ascontiguousarray(arr), 'RGBA')
            sampled = ring_color(rgba, [bb[0], bb[1], bw, bh], 0.0, ring)
    if edge is None:                      # 透明背景：圈外采样不可靠
        if mask.any():
            ink = arr[:, :, :3][mask].astype(np.float32)
            lum = float(np.mean(ink[:, 0] * 0.299 + ink[:, 1] * 0.587
                                + ink[:, 2] * 0.114))
            return (0, 0, 0) if lum > 140 else (255, 255, 255)
        return (255, 255, 255)
    if sampled is None:
        sampled = edge
    vals = np.asarray(sampled, dtype=np.float64).reshape(-1)[:3]
    return tuple(int(max(0, min(255, round(float(v))))) for v in vals)


def _stitch_one(it, idx):
    """处理一条 stitch item；失败抛错，由 op_stitch 收集（不影响其它 item）。"""
    _require(isinstance(it, dict), 'items[%d] 必须是对象' % idx)
    paths = it.get('paths')
    _require(isinstance(paths, list) and paths, 'items[%d].paths 必须是非空数组' % idx)
    out = it.get('out')
    _require(isinstance(out, str) and out, 'items[%d].out 必须是非空字符串' % idx)
    direction = _s(it.get('direction'), 'h')
    _require(direction in ('h', 'v'),
             'items[%d].direction 只能是 "h" 或 "v"，收到 %r' % (idx, direction))
    align = _s(it.get('align'), 'baseline')
    _require(align in ('baseline', 'top', 'center'),
             'items[%d].align 只能是 baseline/top/center，收到 %r' % (idx, align))
    gap = max(0, _int(it.get('gap'), 6, 'gap'))
    padding = max(0, _int(it.get('padding'), 4, 'padding'))
    bg_given = _rgb(it.get('bg'), None, 'bg')

    parts = []
    first_arr = first_mask = None
    for j, p in enumerate(paths):
        _require(isinstance(p, str) and p,
                 'items[%d].paths[%d] 必须是路径字符串' % (idx, j))
        im = load_image(p)
        arr = np.asarray(to_rgba(im), dtype=np.uint8)      # 统一 RGBA 语义
        h, w = arr.shape[:2]
        _require(h > 0 and w > 0, 'items[%d].paths[%d] 尺寸非法' % (idx, j))
        mask = _ink_mask(arr, _edge_median_color(arr))
        if j == 0:
            first_arr, first_mask = arr, mask
        bb = _mask_bbox(mask)
        if bb is None:            # 全背景图（无墨迹）：退化为整图
            bb = (0, 0, w, h)
        # 先按墨迹包围盒裁剪，每边留 padding（超出图像边界则贴边）
        x0 = max(0, bb[0] - padding)
        y0 = max(0, bb[1] - padding)
        x1 = min(w, bb[2] + padding)
        y1 = min(h, bb[3] + padding)
        if x1 <= x0 or y1 <= y0:
            x0, y0, x1, y1 = 0, 0, w, h
        sub = mask[y0:y1, x0:x1]
        iys = np.flatnonzero(sub.any(axis=1))
        ixs = np.flatnonzero(sub.any(axis=0))
        if iys.size:
            ink_top, ink_bottom = int(iys[0]), int(iys[-1]) + 1
        else:                     # 裁剪内没有墨迹：按整块裁剪对齐
            ink_top, ink_bottom = 0, y1 - y0
        if ixs.size:
            ink_left, ink_right = int(ixs[0]), int(ixs[-1]) + 1
        else:
            ink_left, ink_right = 0, x1 - x0
        parts.append({
            'path': p,
            'crop': [x0, y0, x1, y1],
            'w': x1 - x0,
            'h': y1 - y0,
            'inkTop': ink_top,
            'inkBottom': ink_bottom,
            'inkLeft': ink_left,
            'inkRight': ink_right,
            'rgba': np.ascontiguousarray(arr[y0:y1, x0:x1]),
        })

    bg = _stitch_bg_color(first_arr, first_mask, bg_given)
    n = len(parts)

    # 画布尺寸：横向按需累加宽度；baseline 时按墨迹底（竖排时墨迹左）对齐
    if direction == 'h':
        if align == 'baseline':
            y_base = max(d['inkBottom'] for d in parts)
            canvas_h = y_base + max(d['h'] - d['inkBottom'] for d in parts)
        else:
            canvas_h = max(d['h'] for d in parts)
        canvas_w = sum(d['w'] for d in parts) + gap * (n - 1)
    else:
        if align == 'baseline':
            x_base = max(d['inkLeft'] for d in parts)
            canvas_w = x_base + max(d['w'] - d['inkLeft'] for d in parts)
        else:
            canvas_w = max(d['w'] for d in parts)
        canvas_h = sum(d['h'] for d in parts) + gap * (n - 1)
    canvas_w = int(max(1, canvas_w))
    canvas_h = int(max(1, canvas_h))

    placed = []
    if direction == 'h':
        x = 0
        for d in parts:
            if align == 'baseline':
                y = y_base - d['inkBottom']
            elif align == 'center':
                y = (canvas_h - d['h']) // 2
            else:
                y = 0
            placed.append((x, y))
            x += d['w'] + gap
    else:
        y = 0
        for d in parts:
            if align == 'baseline':
                x = x_base - d['inkLeft']
            elif align == 'center':
                x = (canvas_w - d['w']) // 2
            else:
                x = 0
            placed.append((x, y))
            y += d['h'] + gap

    canvas = Image.new('RGB', (canvas_w, canvas_h), bg)
    files = []
    for d, (x, y) in zip(parts, placed):
        # 带 alpha 的输入按 alpha 合成到画布底色上（透明背景的图片字体不会糊成白块）
        tile = Image.fromarray(d['rgba'], 'RGBA')
        if int(d['rgba'][:, :, 3].min()) < 255:
            canvas.paste(tile, (int(x), int(y)), tile.getchannel('A'))
        else:
            canvas.paste(tile.convert('RGB'), (int(x), int(y)))
        # crop 是这块小图在「原图」里的裁剪框，配合 x/y 即可把整体 OCR 的
        # 文字坐标映射回原图：src_x = crop[0] + (canvas_x - x)
        files.append({'path': d['path'], 'x': int(x), 'y': int(y),
                      'w': d['w'], 'h': d['h'],
                      'crop': [int(v) for v in d['crop']],
                      'inkTop': d['inkTop'], 'inkBottom': d['inkBottom'],
                      'inkLeft': d['inkLeft'], 'inkRight': d['inkRight']})

    odir = os.path.dirname(os.path.abspath(out))
    if odir:
        os.makedirs(odir, exist_ok=True)
    if os.path.splitext(out)[1].lower() in ('', '.png'):
        canvas.save(out, 'PNG')
    else:
        canvas.save(out)
    log('stitch %s %s/%s %d 图 -> %dx%d'
        % (os.path.basename(out), direction, align, n, canvas_w, canvas_h))
    return {'out': out, 'w': canvas_w, 'h': canvas_h,
            'direction': direction, 'align': align, 'gap': gap, 'padding': padding,
            'bg': [int(c) for c in bg], 'sources': list(paths), 'parts': files}


def op_stitch(payload):
    """把多张小图拼成一条供整体 OCR；单条 item 失败不影响其它 item。

    任何一条 item 失败 → 整体 ok:false（error 汇总），但成功的 item 仍写在 files 里。
    """
    items = payload.get('items')
    _require(isinstance(items, list) and items, 'items 必须是非空数组')
    files = []
    errors = []
    for i, it in enumerate(items):
        try:
            files.append(_stitch_one(it, i))
        except Exception as exc:
            log('stitch items[%d] 失败：%s' % (i, exc))
            errors.append({'index': i, 'error': '%s' % exc})
    res = {'ok': not errors, 'files': files, 'errors': errors}
    if errors:
        res['error'] = '；'.join('items[%d]：%s' % (e['index'], e['error'])
                                for e in errors)
    return res


# ---------------------------------------------------------------- PDF

_OBJ_RE = re.compile(rb'(?m)(?<![0-9])(\d{1,10})\s+(\d{1,5})\s+obj\b')
_REF_RE = re.compile(rb'^\s*(\d+)\s+(\d+)\s+R\b')
_NAME_RE = re.compile(rb'/([^\s/\[\]<>(){}%]+)')


def scan_pdf_objects(data):
    """扫描所有间接对象：{num: {'raw': bytes}}。"""
    objs = {}
    for m in _OBJ_RE.finditer(data):
        num = int(m.group(1))
        end = data.find(b'endobj', m.end())
        raw = data[m.end():end if end >= 0 else len(data)]
        objs[num] = raw
    return objs


def obj_stream_bytes(raw):
    """取对象里的流字节；无流返回 None。"""
    i = raw.find(b'stream')
    if i < 0:
        return None
    dic = raw[:i]
    j = i + len(b'stream')
    if raw[j:j + 2] == b'\r\n':
        j += 2
    elif raw[j:j + 1] in (b'\n', b'\r'):
        j += 1
    m = re.search(rb'/Length\s+(\d+)(?!\s+\d+\s+R)', dic)
    n = int(m.group(1)) if m else None
    k = raw.find(b'endstream', j)
    if n is not None and 0 <= n <= (k - j if k >= 0 else len(raw) - j):
        return raw[j:j + n]
    if k >= 0:
        out = raw[j:k]
        if out.endswith(b'\r\n'):
            out = out[:-2]
        elif out.endswith(b'\n') or out.endswith(b'\r'):
            out = out[:-1]
        return out
    return raw[j:]


def parse_filters(dic):
    m = re.search(rb'/Filter\s*(\[[^\]]*\]|/\w+)', dic)
    if not m:
        return []
    return [x.decode('latin1') for x in _NAME_RE.findall(m.group(1))]


def _a85_ascii85(data):
    s = bytes(c for c in data if not chr(c).isspace())
    if s.startswith(b'<~'):
        s = s[2:]
    if s.endswith(b'~>'):
        s = s[:-2]
    out = bytearray()
    acc = 0
    n = 0
    for c in s:
        if c == 0x7a and n == 0:  # 'z'
            out.extend(b'\x00\x00\x00\x00')
            continue
        if not (0x21 <= c <= 0x75):
            continue
        acc = acc * 85 + (c - 33)
        n += 1
        if n == 5:
            out.extend(acc.to_bytes(4, 'big'))
            acc = 0
            n = 0
    if n:
        for _ in range(5 - n):
            acc = acc * 85 + 84
        out.extend(acc.to_bytes(4, 'big')[:n - 1])
    return bytes(out)


def decode_stream(data, filters):
    """按 Filter 链解码；失败返回 (None, 错误说明)。"""
    out = data
    for f in filters:
        f = f.lstrip('/')
        try:
            if f in ('FlateDecode', 'Fl'):
                try:
                    out = zlib.decompress(out)
                except zlib.error:
                    out = zlib.decompressobj().decompress(out)
            elif f in ('ASCIIHexDecode', 'AHx'):
                s = re.sub(rb'\s+', b'', out).rstrip(b'>')
                if len(s) % 2:
                    s += b'0'
                out = bytes.fromhex(s.decode('latin1'))
            elif f in ('ASCII85Decode', 'A85'):
                out = _a85_ascii85(out)
            elif f in ('LZWDecode', 'CCITTFaxDecode', 'JPXDecode', 'DCTDecode',
                       'JBIG2Decode', 'RunLengthDecode', 'Crypt'):
                return None, '不支持的 Filter：%s' % f
            else:
                return None, '未知 Filter：%s' % f
        except Exception as exc:
            return None, 'Filter %s 解码失败：%s' % (f, exc)
    return out, None


def _parse_pdf_value(buf, i):
    """从 i 开始解析一个 PDF 对象/值，返回 (value, next_i)。"""
    n = len(buf)
    while i < n and buf[i:i + 1] in b' \t\r\n\x00':
        i += 1
    if i >= n:
        return None, i
    c = buf[i:i + 1]
    if c == b'<':
        if buf[i:i + 2] == b'<<':
            dic = {}
            i += 2
            while i < n:
                while i < n and buf[i:i + 1] in b' \t\r\n\x00':
                    i += 1
                if buf[i:i + 2] == b'>>':
                    return dic, i + 2
                if buf[i:i + 1] == b'/':
                    m = _NAME_RE.match(buf, i)
                    if not m:
                        i += 1
                        continue
                    key = m.group(1).decode('latin1')
                    i = m.end()
                    val, i = _parse_pdf_value(buf, i)
                    dic.setdefault(key, val)
                    continue
                # 非法键：跳过一词
                j = i
                while j < n and buf[j:j + 1] not in b' \t\r\n':
                    j += 1
                i = j if j > i else i + 1
            return dic, i
        j = buf.find(b'>', i)
        if j < 0:
            return b'', n
        return bytes.fromhex(_hex_clean(buf[i + 1:j])), j + 1
    if c == b'(':
        depth = 0
        j = i
        while j < n:
            ch = buf[j:j + 1]
            if ch == b'\\':
                j += 2
                continue
            if ch == b'(':
                depth += 1
            elif ch == b')':
                depth -= 1
                if depth == 0:
                    j += 1
                    break
            j += 1
        return _decode_pdf_literal(buf[i + 1:j - 1]), j
    if c == b'[':
        arr = []
        i += 1
        while i < n:
            while i < n and buf[i:i + 1] in b' \t\r\n':
                i += 1
            if buf[i:i + 1] == b']':
                return arr, i + 1
            if i >= n:
                break
            v, i = _parse_pdf_value(buf, i)
            arr.append(v)
        return arr, i
    if c == b'/':
        m = _NAME_RE.match(buf, i)
        if m:
            return '/' + m.group(1).decode('latin1'), m.end()
        return None, i + 1
    if c.isdigit() or c in b'+-.':
        m = re.match(rb'[+-]?\d*\.?\d+', buf[i:i + 40])
        if m:
            text = m.group(0)
            i2 = i + m.end()
            rm = _REF_RE.match(buf, i2)
            if rm:
                return (int(rm.group(1)), int(rm.group(2))), rm.end()
            try:
                return (float(text) if b'.' in text else int(text)), i2
            except ValueError:
                return None, i2
        return None, i + 1
    if buf[i:i + 4] == b'true':
        return True, i + 4
    if buf[i:i + 5] == b'false':
        return False, i + 5
    if buf[i:i + 4] == b'null':
        return None, i + 4
    j = i
    while j < n and buf[j:j + 1] not in b' \t\r\n/[]<>()':
        j += 1
    return buf[i:j].decode('latin1'), (j if j > i else i + 1)


def _hex_clean(b):
    s = re.sub(rb'[^0-9a-fA-F]', b'', b)
    if len(s) % 2:
        s += b'0'
    return s.decode('latin1')


def _decode_pdf_literal(b):
    out = bytearray()
    i = 0
    n = len(b)
    while i < n:
        c = b[i]
        if c != 0x5C:
            out.append(c)
            i += 1
            continue
        i += 1
        if i >= n:
            break
        e = b[i:i + 1]
        if e == b'n':
            out.append(10); i += 1
        elif e == b'r':
            out.append(13); i += 1
        elif e == b't':
            out.append(9); i += 1
        elif e == b'b':
            out.append(8); i += 1
        elif e == b'f':
            out.append(12); i += 1
        elif e in (b'(', b')', b'\\'):
            out.append(e[0]); i += 1
        elif e == b'\n':
            i += 1
        elif e == b'\r':
            i += 1
            if b[i:i + 1] == b'\n':
                i += 1
        elif e.isdigit():
            j = i
            while j < n and j < i + 3 and b[j:j + 1].isdigit():
                j += 1
            out.append(int(b[i:j], 8) & 0xFF)
            i = j
        else:
            out.append(e[0]); i += 1
    return bytes(out)


def parse_to_unicode_cmap(stream_bytes):
    """解析简单 CMap 的 beginbfchar / beginbfrange（含 codespace 宽度）。"""
    if not stream_bytes:
        return None
    txt = stream_bytes.decode('latin1', 'replace')
    if 'beginbfchar' not in txt and 'beginbfrange' not in txt:
        return None
    lengths = set()
    for m in re.finditer(r'begincodespacerange(.*?)endcodespacerange', txt, re.S):
        for h in re.findall(r'<([0-9A-Fa-f]+)>', m.group(1)):
            lengths.add(len(h) // 2)
    cmap = {}
    for m in re.finditer(r'beginbfchar(.*?)endbfchar', txt, re.S):
        for src, dst in re.findall(r'<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>', m.group(1)):
            code = int(src, 16)
            cmap[code] = _utf16be_hex(dst)
    for m in re.finditer(r'beginbfrange(.*?)endbfrange', txt, re.S):
        body = m.group(1)
        for lo, hi, dst in re.findall(
                r'<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>', body):
            a, b = int(lo, 16), int(hi, 16)
            base = _utf16be_hex(dst)
            if len(base) != 1:
                for k in range(a, min(b, a + 4096) + 1):
                    cmap[k] = base
                continue
            for off, k in enumerate(range(a, min(b, a + 4096) + 1)):
                cmap[k] = chr(ord(base) + off)
        for lo, hi, arr in re.findall(
                r'<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[(.*?)\]', body, re.S):
            a = int(lo, 16)
            items = re.findall(r'<([0-9A-Fa-f]*)>', arr)
            for off, h in enumerate(items):
                cmap[a + off] = _utf16be_hex(h)
    widths = sorted(lengths) or [1, 2]
    return {'map': cmap, 'widths': widths}


def _utf16be_hex(h):
    if not h:
        return ''
    if len(h) % 2:
        h += '0'
    raw = bytes.fromhex(h)
    try:
        return raw.decode('utf-16-be')
    except Exception:
        return raw.decode('latin1')


def decode_pdf_string(raw, cmap):
    """把字符串字节按 CMap 解码；失败降级 latin1。"""
    if not raw:
        return ''
    if cmap and cmap['map']:
        m = cmap['map']
        widths = cmap['widths']
        out = []
        i = 0
        n = len(raw)
        while i < n:
            hit = False
            for wd in widths:
                if wd > 1 and i + wd <= n:
                    code = int.from_bytes(raw[i:i + wd], 'big')
                    if code in m:
                        out.append(m[code])
                        i += wd
                        hit = True
                        break
            if hit:
                continue
            code = raw[i]
            if code in m:
                out.append(m[code])
            else:
                out.append(bytes([code]).decode('latin1'))
            i += 1
        return ''.join(out)
    return raw.decode('latin1')


_CONTENT_TOKEN_RE = re.compile(
    rb'(\[(?:[^\[\]\\]|\\.)*\]|\((?:[^()\\]|\\.)*\)|<[0-9A-Fa-f\s]*>|[-+]?\d*\.?\d+|/[^\s/\[\]<>(){}]+|[A-Za-z\'"*]+)',
    re.S)
_SHOW_OPS = (b'Tj', b'TJ', b"'", b'"')
_NL_OPS = (b'Td', b'TD', b'T*', b'BT', b'ET')


def extract_text_from_content(content, cmap):
    """从内容流抽取 Tj/TJ/'/" 字符串（含换行提示）。"""
    parts = []
    pending = []
    last_adjust = 0.0
    for m in _CONTENT_TOKEN_RE.finditer(content):
        tok = m.group(1)
        if tok.startswith(b'('):
            pending.append(_decode_pdf_literal(tok[1:-1]))
        elif tok.startswith(b'<') and not tok.startswith(b'<<'):
            h = _hex_clean(tok[1:-1])
            pending.append(bytes.fromhex(h) if h else b'')
        elif tok.startswith(b'['):
            inner = _CONTENT_TOKEN_RE.findall(tok[1:-1])
            for it in inner:
                if it.startswith(b'('):
                    pending.append(_decode_pdf_literal(it[1:-1]))
                elif it.startswith(b'<') and len(it) > 2:
                    h = _hex_clean(it[1:-1])
                    if h:
                        pending.append(bytes.fromhex(h))
                else:
                    try:
                        last_adjust = float(it)
                    except ValueError:
                        pass
                    if last_adjust < -180 and pending:
                        pending.append(b' ')
            last_adjust = 0.0
        elif tok in _SHOW_OPS:
            if pending:
                parts.append(decode_pdf_string(b''.join(pending), cmap))
                pending = []
        elif tok in _NL_OPS:
            if pending:
                parts.append(decode_pdf_string(b''.join(pending), cmap))
                pending = []
            if parts and not parts[-1].endswith('\n'):
                parts.append('\n')
    if pending:
        parts.append(decode_pdf_string(b''.join(pending), cmap))
    text = ''.join(parts)
    text = re.sub(r'[ \t]+\n', '\n', text)
    text = re.sub(r'\n{3,}', '\n\n', text)
    return text.strip('\n')


def _looks_like_text(s):
    if not s:
        return False
    good = 0
    for ch in s:
        o = ord(ch)
        if ch.isprintable() and (o >= 0x20):
            good += 1
        if 0x4e00 <= o <= 0x9fff or 0x3040 <= o <= 0x30ff or 0xac00 <= o <= 0xd7af:
            good += 4
    return good >= max(3, len(s) * 0.4)


def op_pdf(payload):
    f = payload.get('file')
    _require(isinstance(f, str) and f, 'file 必须是非空字符串')
    _require(os.path.isfile(f), 'PDF 不存在：%s' % f)
    with open(f, 'rb') as fh:
        data = fh.read()
    _require(data[:5] == b'%PDF-',
             '不是 PDF 文件（缺少 %%PDF- 头）：%s' % f)
    out_dir = payload.get('outDir') or (os.path.splitext(f)[0] + '.pdfimg')
    os.makedirs(out_dir, exist_ok=True)
    want_text = payload.get('wantText', True)
    want_images = payload.get('wantImages', True)

    objs = scan_pdf_objects(data)
    log('pdf %s: %d 间接对象' % (os.path.basename(f), len(objs)))

    # 页数：/Type /Page（非 /Pages）
    pages = 0
    for num, raw in objs.items():
        head = raw[:raw.find(b'stream')] if b'stream' in raw else raw
        if re.search(rb'/Type\s*/Page(?![s])', head):
            pages += 1
    if pages == 0:
        m = re.search(rb'/Count\s+(\d+)', data)
        pages = int(m.group(1)) if m else 1

    # 字体 ToUnicode → 合并的字符映射
    cmaps = []
    for num, raw in objs.items():
        head = raw[:raw.find(b'stream')] if b'stream' in raw else raw
        if not re.search(rb'/Type\s*/Font', head):
            continue
        m = re.search(rb'/ToUnicode\s+(\d+)\s+\d+\s+R', head)
        if not m:
            continue
        tref = int(m.group(1))
        if tref not in objs:
            continue
        sb = obj_stream_bytes(objs[tref])
        if sb is None:
            continue
        dec, _err = decode_stream(sb, parse_filters(objs[tref]))
        if dec is None:
            continue
        cm = parse_to_unicode_cmap(dec)
        if cm:
            cmaps.append(cm)
    merged = {}
    widths = set()
    for cm in cmaps:
        for k, v in cm['map'].items():
            merged.setdefault(k, v)
        widths.update(cm['widths'])
    cmap = {'map': merged, 'widths': sorted(widths) or [1, 2]} if merged else None

    # 文本抽取
    text_parts = []
    streams_with_text = 0
    if want_text:
        for num, raw in objs.items():
            if b'stream' not in raw:
                continue
            head = raw[:raw.find(b'stream')]
            if re.search(rb'/Subtype\s*/Image|/Type\s*/(XObject|Font|Metadata|ObjStm|XRef|EmbeddedFile|Filespec)', head):
                continue
            if b'/Image' in head and b'/Subtype' in head:
                continue
            sb = obj_stream_bytes(raw)
            if sb is None:
                continue
            dec, err = decode_stream(sb, parse_filters(head))
            if dec is None:
                continue
            if b'\x00' in dec[:2000]:
                continue
            if not re.search(rb'\b(Tj|TJ)\b|\'|"', dec):
                continue
            piece = extract_text_from_content(dec, cmap)
            if piece.strip():
                streams_with_text += 1
                text_parts.append(piece)
    text = '\f'.join(p for p in text_parts)
    has_text = bool(text.strip()) and _looks_like_text(text)
    if text_parts and not has_text:
        log('pdf: 文本层解码结果疑似乱码，标记 hasText=false')
    if not has_text:
        text = text if text.strip() else ''

    # 图片抽取
    images = []
    skipped = []
    if want_images:
        idx = 0
        cs_map = {
            'DeviceRGB': ('RGB', 3), 'DeviceGray': ('L', 1), 'CalRGB': ('RGB', 3),
            'CalGray': ('L', 1), 'DeviceCMYK': ('CMYK', 4), '/DeviceRGB': ('RGB', 3),
            '/DeviceGray': ('L', 1), '/DeviceCMYK': ('CMYK', 4),
        }
        for num in sorted(objs):
            raw = objs[num]
            if b'stream' not in raw:
                continue
            head = raw[:raw.find(b'stream')]
            if not re.search(rb'/Subtype\s*/Image', head):
                continue
            try:
                val, _ = _parse_pdf_value(head, 0)
            except Exception:
                val = {}
            if not isinstance(val, dict):
                val = {}
            dic = val
            sb = obj_stream_bytes(raw)
            if sb is None:
                skipped.append({'page': 1, 'reason': '流读取失败', 'obj': num})
                continue
            w = int(dic.get('Width') or 0) if isinstance(dic.get('Width'), (int, float)) else 0
            h = int(dic.get('Height') or 0) if isinstance(dic.get('Height'), (int, float)) else 0
            bpc = int(dic.get('BitsPerComponent') or 8) if isinstance(dic.get('BitsPerComponent'), (int, float)) else 8
            cs = dic.get('ColorSpace')
            csname = cs if isinstance(cs, str) else (cs[0] if isinstance(cs, list) and cs and isinstance(cs[0], str) else None)
            filters = parse_filters(head)
            name = 'p1-img%d' % idx
            page = pages if pages else 1
            if filters == ['DCTDecode'] or filters == ['/DCTDecode']:
                path = os.path.join(out_dir, name + '.jpg')
                with open(path, 'wb') as fh:
                    fh.write(sb)
                try:
                    with Image.open(path) as t:
                        t.load()
                        tw, th = t.size
                except Exception as exc:
                    skipped.append({'page': page, 'obj': num,
                                    'reason': 'DCTDecode 数据无效：%s' % exc})
                    try:
                        os.remove(path)
                    except OSError:
                        pass
                    continue
                images.append({'page': page, 'name': name + '.jpg', 'path': path,
                               'w': tw, 'h': th, 'filter': 'DCTDecode'})
                idx += 1
                continue
            if any(f.lstrip('/') in ('JPXDecode', 'CCITTFaxDecode', 'JBIG2Decode')
                   for f in filters):
                skipped.append({'page': page, 'obj': num,
                                'reason': '不支持的 Filter：%s' % ','.join(filters)})
                continue
            dec, err = decode_stream(sb, filters)
            if dec is None:
                skipped.append({'page': page, 'obj': num, 'reason': err or '解码失败'})
                continue
            if not w or not h:
                skipped.append({'page': page, 'obj': num, 'reason': '缺少 Width/Height'})
                continue
            mode, ncomp = cs_map.get(csname or '', (None, 0))
            if mode is None or bpc != 8:
                skipped.append({'page': page, 'obj': num,
                                'reason': '不支持的 ColorSpace/BPC：%s/%s' % (csname, bpc)})
                continue
            need = w * h * ncomp
            if len(dec) < need:
                skipped.append({'page': page, 'obj': num,
                                'reason': '像素数据不足（%d < %d）' % (len(dec), need)})
                continue
            arr = np.frombuffer(dec[:need], dtype=np.uint8).reshape(h, w, ncomp)
            if ncomp == 1:
                img = Image.fromarray(arr[:, :, 0], 'L')
            elif ncomp == 3:
                img = Image.fromarray(arr, 'RGB')
            else:
                img = Image.fromarray(arr, 'CMYK').convert('RGB')
            path = os.path.join(out_dir, name + '.png')
            img.save(path)
            images.append({'page': page, 'name': name + '.png', 'path': path,
                           'w': w, 'h': h, 'filter': ','.join(filters) or 'none'})
            idx += 1

    if skipped:
        log('pdf: %d 个图像对象被跳过' % len(skipped))
    return {
        'ok': True,
        'pages': int(pages),
        'hasText': bool(has_text),
        'text': text if has_text else '',
        'rawText': text if not has_text else '',
        'images': images,
        'skipped': skipped,
        'objects': len(objs),
        'fontsMapped': len(cmaps),
        'cmapEntries': len(merged),
    }


# ---------------------------------------------------------------- 入口

OPS = {
    'probe': op_probe,
    'regions': op_regions,
    'crop': op_crop,
    'typeset': op_typeset,
    'stitch': op_stitch,
    'pdf': op_pdf,
    'resize': op_resize,
}


def run(in_path, out_path):
    if not os.path.isfile(in_path):
        return {'ok': False, 'error': '输入文件不存在：%s' % in_path}
    try:
        with open(in_path, 'r', encoding='utf-8') as fh:
            payload = json.load(fh)
    except Exception as exc:
        return {'ok': False, 'error': '输入 JSON 解析失败：%s' % exc}
    if not isinstance(payload, dict):
        return {'ok': False, 'error': '输入 JSON 必须是对象'}
    op = payload.get('op')
    if op not in OPS:
        return {'ok': False, 'error': '未知 op：%r（支持 %s）'
                % (op, '/'.join(sorted(OPS)))}
    try:
        res = OPS[op](payload)
        res.setdefault('ok', True)
        res.setdefault('op', op)
        return res
    except Exception as exc:
        log('op=%s 失败：%s\n%s' % (op, exc, traceback.format_exc()))
        return {'ok': False, 'error': '%s' % exc, 'op': op}


def main(argv):
    if len(argv) < 3:
        sys.stderr.write('用法：python imglib.py <in.json> <out.json>\n')
        return 2
    in_path, out_path = argv[1], argv[2]
    try:
        result = run(in_path, out_path)
    except Exception as exc:  # 兜底：连 run 都炸了也必须写出 out.json
        result = {'ok': False, 'error': '内部错误：%s' % exc}
        log(traceback.format_exc())
    try:
        d = os.path.dirname(os.path.abspath(out_path))
        if d:
            os.makedirs(d, exist_ok=True)
        write_result(out_path, result)
    except Exception as exc:
        sys.stderr.write('[imglib] 无法写出 out.json：%s\n' % exc)
        return 1
    log('%s -> ok=%s' % (result.get('op', '?'), result.get('ok')))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
