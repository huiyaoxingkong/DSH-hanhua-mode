/**
 * winocr.ps1（Windows 内置 OCR 桥接）集成测试
 *
 * 运行：node tests/winocr.test.mjs
 *
 * 说明：
 *  - 夹具由系统 Python + Pillow 生成到 os.tmpdir() 下的临时目录，仓库内不留任何文件。
 *  - 所有 PowerShell 调用都走 Windows PowerShell 5.1（本机未安装 pwsh）。
 *  - 若本机 availableLangs 不含 zh-Hans-CN / en-US，相关断言会 skip 而不是 fail。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const SCRIPT = path.join(REPO_ROOT, 'engine', 'src', 'scripts', 'winocr.ps1');

const POWERSHELL = path.join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
);
const PYTHON = 'C:\\Users\\lihao\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe';

const SPAWN_TIMEOUT_MS = 180000;

// ---------------------------------------------------------------------------
// 临时目录与夹具
// ---------------------------------------------------------------------------
let tmpDir = '';
let fxDir = '';
const fixtures = {};

const PY_FIXTURES = String.raw`
import sys, os
from PIL import Image, ImageDraw, ImageFont

out = sys.argv[1]
os.makedirs(out, exist_ok=True)
YAHEI = r"C:\Windows\Fonts\msyh.ttc"
YAHEI_BD = r"C:\Windows\Fonts\msyhbd.ttc"
ARIAL = r"C:\Windows\Fonts\arial.ttf"

def font(p, size):
    try:
        return ImageFont.truetype(p, size)
    except Exception:
        return ImageFont.load_default()

# 1) 白底黑字：中文 + 英文
img = Image.new("RGB", (900, 420), (255, 255, 255))
d = ImageDraw.Draw(img)
d.text((40, 60), "\u4f60\u597d\uff0c\u4e16\u754c", font=font(YAHEI, 84), fill=(0, 0, 0))
d.text((40, 250), "HELLO WORLD", font=font(ARIAL, 72), fill=(0, 0, 0))
img.save(os.path.join(out, "plain.png"))

# 2) 红色描边艺术字（漫画标题风，stroke_width=3）
img2 = Image.new("RGB", (900, 420), (255, 255, 255))
d2 = ImageDraw.Draw(img2)
d2.text((50, 120), "\u6c49\u5316\u6a21\u5f0f", font=font(YAHEI, 120), fill=(220, 20, 20), stroke_width=3, stroke_fill=(0, 0, 0))
img2.save(os.path.join(out, "art.png"))

# 3) 纯空白图
Image.new("RGB", (400, 200), (255, 255, 255)).save(os.path.join(out, "blank.png"))

# 4) 大图：用于 maxDim 缩放与坐标回算（6000x1400）
img4 = Image.new("RGB", (6000, 1400), (255, 255, 255))
ImageDraw.Draw(img4).text((150, 350), "SCALE TEST", font=font(ARIAL, 700), fill=(0, 0, 0))
img4.save(os.path.join(out, "huge.png"))

# 5) 超长条：12000x600，用于验证超过 OcrEngine.MaxImageDimension(10000) 的硬上限兜底
img5 = Image.new("RGB", (12000, 600), (255, 255, 255))
ImageDraw.Draw(img5).text((200, 120), "WIDE", font=font(ARIAL, 360), fill=(0, 0, 0))
img5.save(os.path.join(out, "wide.png"))

# 6) 大号描边艺术字（200px + stroke 3，常规字重），用于给出"艺术字要多大才可能被识别"的实测证据
img6 = Image.new("RGB", (1400, 600), (255, 255, 255))
ImageDraw.Draw(img6).text((50, 150), "\u6c49\u5316\u6a21\u5f0f", font=font(YAHEI, 200), fill=(220, 20, 20), stroke_width=3, stroke_fill=(0, 0, 0))
img6.save(os.path.join(out, "art_big.png"))

# 7) 大号描边艺术字（200px + stroke 3，粗体）：实测粗体+描边更容易崩
img7 = Image.new("RGB", (1400, 600), (255, 255, 255))
ImageDraw.Draw(img7).text((50, 150), "\u6c49\u5316\u6a21\u5f0f", font=font(YAHEI_BD, 200), fill=(220, 20, 20), stroke_width=3, stroke_fill=(0, 0, 0))
img7.save(os.path.join(out, "art_big_bold.png"))

print("FIXTURES_OK")
`;

const setup = { error: null, availableLangs: [], maxImageDimension: 0, hasZh: false, hasEn: false };

// ---------------------------------------------------------------------------
// 调用辅助
// ---------------------------------------------------------------------------
/**
 * 调一次 winocr.ps1。
 * @returns {{exitCode:number, ms:number, raw:string, json:any, buf:Buffer}}
 */
function runOcr(images, { langs = [], maxDim = undefined, tag = 'run' } = {}) {
  const inPath = path.join(tmpDir, `${tag}-in.json`);
  const outPath = path.join(tmpDir, `${tag}-out.json`);
  const payload = { images, langs };
  if (maxDim !== undefined) payload.maxDim = maxDim;
  // 入参写 UTF-8 无 BOM
  fs.writeFileSync(inPath, JSON.stringify(payload), 'utf8');
  if (fs.existsSync(outPath)) fs.rmSync(outPath);

  const t0 = process.hrtime.bigint();
  const res = spawnSync(POWERSHELL, [
    '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', SCRIPT, '-In', inPath, '-Out', outPath,
  ], { timeout: SPAWN_TIMEOUT_MS, windowsHide: true, encoding: 'utf8' });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;

  if (res.error) throw new Error(`PowerShell 调用失败：${res.error.message}`);
  assert.ok(fs.existsSync(outPath), `out.json 未写出（exit=${res.status}）stderr=${res.stderr}`);
  const buf = fs.readFileSync(outPath);
  const raw = buf.toString('utf8');
  // PS5.1 Set-Content 会带 BOM，这里统一容忍
  const json = JSON.parse(raw.replace(/^\uFEFF/, ''));
  return { exitCode: res.status, ms, raw, json, buf, stderr: res.stderr };
}

const strip = (s) => (s || '').replace(/\s+/g, '');
const byName = (results, name) => results.find((r) => path.basename(r.path) === name);

function skipIfNotReady(t) {
  if (setup.error) { t.skip(`环境不可用：${setup.error}`); return false; }
  return true;
}

function skipIfNoZh(t) {
  if (!skipIfNotReady(t)) return false;
  if (!setup.hasZh) { t.skip(`本机 availableLangs 不含 zh-Hans-CN（实际：${setup.availableLangs.join(',')}）`); return false; }
  return true;
}

function skipIfNoEn(t) {
  if (!skipIfNotReady(t)) return false;
  if (!setup.hasEn) { t.skip(`本机 availableLangs 不含 en-US（实际：${setup.availableLangs.join(',')}）`); return false; }
  return true;
}

function assertCoordsInBounds(result) {
  assert.ok(Number.isInteger(result.width) && Number.isInteger(result.height), 'width/height 必须是整数');
  let wordCount = 0;
  for (const line of result.lines) {
    assert.equal(typeof line.text, 'string');
    for (const w of line.words) {
      wordCount++;
      assert.equal(typeof w.text, 'string');
      for (const k of ['x', 'y', 'w', 'h']) assert.ok(Number.isInteger(w[k]), `word.${k} 必须是整数，实际 ${w[k]}`);
      assert.ok(w.x >= 0 && w.y >= 0, `词坐标出现负值：${JSON.stringify(w)}`);
      assert.ok(w.x + w.w <= result.width, `词右边界越界：${JSON.stringify(w)} > width=${result.width}`);
      assert.ok(w.y + w.h <= result.height, `词下边界越界：${JSON.stringify(w)} > height=${result.height}`);
    }
  }
  return wordCount;
}

// ---------------------------------------------------------------------------
// 共享状态
// ---------------------------------------------------------------------------
let batch = null;     // R1：3 张图一次进程批量
let isolation = null; // R2：坏路径/坏文件隔离
let langsRun = null;  // R3：en-US 与语言回退链
let scaleRun = null;  // R4：maxDim 缩放
let hardCap = null;   // R5：超过 MaxImageDimension 的硬上限
let individual = [];  // R6：逐张调用耗时

before(() => {
  if (!fs.existsSync(POWERSHELL)) { setup.error = `找不到 Windows PowerShell 5.1：${POWERSHELL}`; return; }
  if (!fs.existsSync(SCRIPT)) { setup.error = `找不到被测脚本：${SCRIPT}`; return; }
  if (!fs.existsSync(PYTHON)) { setup.error = `找不到系统 Python：${PYTHON}`; return; }

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-winocr-'));
  fxDir = path.join(tmpDir, 'fx');
  fs.mkdirSync(fxDir, { recursive: true });

  // 用 Python + Pillow 生成夹具
  const pyFile = path.join(tmpDir, 'make_fixtures.py');
  fs.writeFileSync(pyFile, PY_FIXTURES, 'utf8');
  const py = spawnSync(PYTHON, [pyFile, fxDir], { timeout: SPAWN_TIMEOUT_MS, encoding: 'utf8' });
  if (py.status !== 0 || !(py.stdout || '').includes('FIXTURES_OK')) {
    setup.error = `夹具生成失败：status=${py.status} stdout=${py.stdout} stderr=${py.stderr}`;
    return;
  }

  for (const name of ['plain.png', 'art.png', 'blank.png', 'huge.png', 'wide.png', 'art_big.png', 'art_big_bold.png']) {
    fixtures[name] = path.join(fxDir, name);
    if (!fs.existsSync(fixtures[name])) { setup.error = `夹具缺失：${name}`; return; }
  }
  // 损坏图像（非图片字节）
  fixtures['corrupt.png'] = path.join(fxDir, 'corrupt.png');
  fs.writeFileSync(fixtures['corrupt.png'], Buffer.from('this is definitely not a png', 'utf8'));
  fixtures['missing.png'] = path.join(fxDir, 'does-not-exist.png');

  // 中文路径夹具（仓库本身就在中文路径下，必须验证）
  const cnDir = path.join(tmpDir, '中文 目录');
  fs.mkdirSync(cnDir, { recursive: true });
  fixtures['cn'] = path.join(cnDir, '漫画 第1页.png');
  fs.copyFileSync(fixtures['plain.png'], fixtures['cn']);

  try {
    // R1：批量（性能关键：一次进程处理 3 张图）
    batch = runOcr([
      { path: fixtures['plain.png'], lang: 'zh-Hans-CN' },
      { path: fixtures['art.png'], lang: 'zh-Hans-CN' },
      { path: fixtures['blank.png'], lang: 'zh-Hans-CN' },
    ], { langs: ['zh-Hans-CN', 'en-US'], maxDim: 4000, tag: 'batch' });

    setup.availableLangs = batch.json.availableLangs || [];
    setup.maxImageDimension = batch.json.maxImageDimension || 0;
    setup.hasZh = setup.availableLangs.includes('zh-Hans-CN');
    setup.hasEn = setup.availableLangs.includes('en-US');

    // R2：隔离性（中文路径 / 损坏图 / 不存在 / 大号艺术字）
    isolation = runOcr([
      { path: fixtures['cn'], lang: 'zh-Hans-CN' },
      { path: fixtures['corrupt.png'], lang: 'zh-Hans-CN' },
      { path: fixtures['missing.png'], lang: 'zh-Hans-CN' },
      { path: fixtures['art_big.png'], lang: 'zh-Hans-CN' },
      { path: fixtures['art_big_bold.png'], lang: 'zh-Hans-CN' },
    ], { langs: ['zh-Hans-CN', 'en-US'], maxDim: 4000, tag: 'isolation' });

    // R3：en-US 引擎 + 语言回退链（ja 无引擎 → 回退到 langs 链）
    langsRun = runOcr([
      { path: fixtures['plain.png'], lang: 'en-US' },
      { path: fixtures['plain.png'], lang: 'ja' },
    ], { langs: ['zh-Hans-CN', 'en-US'], maxDim: 4000, tag: 'langs' });

    // R4：maxDim 缩放 + 坐标回算
    scaleRun = runOcr([
      { path: fixtures['huge.png'], lang: 'zh-Hans-CN' },
      { path: fixtures['wide.png'], lang: 'zh-Hans-CN' },
    ], { langs: ['zh-Hans-CN', 'en-US'], maxDim: 2000, tag: 'scale' });

    // R5：maxDim 超过 OcrEngine.MaxImageDimension 时用硬上限兜底
    hardCap = runOcr([
      { path: fixtures['wide.png'], lang: 'zh-Hans-CN' },
    ], { langs: ['zh-Hans-CN', 'en-US'], maxDim: 20000, tag: 'hardcap' });

    // R6：逐张调用耗时（与批量对比）
    individual = [fixtures['plain.png'], fixtures['art.png'], fixtures['blank.png']].map((p, i) =>
      runOcr([{ path: p, lang: 'zh-Hans-CN' }], { langs: ['zh-Hans-CN', 'en-US'], maxDim: 4000, tag: `single${i}` }));
  } catch (err) {
    setup.error = `预跑失败：${err.message}`;
  }
});

after(() => {
  if (tmpDir && fs.existsSync(tmpDir)) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 忽略清理失败 */ }
  }
});

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------
test('环境：winocr.ps1 存在且本机有 Windows OCR 引擎', (t) => {
  assert.ok(fs.existsSync(SCRIPT), `脚本不存在：${SCRIPT}`);
  if (!skipIfNotReady(t)) return;
  assert.equal(batch.json.ok, true, `顶层 ok 应为 true：${batch.raw}`);
  assert.ok(Array.isArray(batch.json.availableLangs) && batch.json.availableLangs.length > 0, 'availableLangs 不应为空');
  assert.ok(batch.json.maxImageDimension > 0, 'maxImageDimension 应大于 0');
  console.log(`    availableLangs = ${batch.json.availableLangs.join(', ')} | MaxImageDimension = ${batch.json.maxImageDimension}`);
});

test('批量：一次进程处理 3 张图，results.length === 3 且 UTF-8 无 BOM', (t) => {
  if (!skipIfNotReady(t)) return;
  assert.equal(batch.exitCode, 0, '退出码应为 0（out.json 已写出）');
  assert.equal(batch.json.results.length, 3);
  assert.notEqual(batch.buf[0], 0xef, 'out.json 不应带 UTF-8 BOM');
  // 没有进度/警告字段混进 JSON
  assert.deepEqual(Object.keys(batch.json).sort(), ['availableLangs', 'maxImageDimension', 'ok', 'results']);
});

test('可用语言：availableLangs 含 zh-Hans-CN', (t) => {
  if (!skipIfNotReady(t)) return;
  if (!setup.hasZh) { t.skip(`本机 availableLangs 不含 zh-Hans-CN（实际：${setup.availableLangs.join(',')}）`); return; }
  assert.ok(setup.availableLangs.includes('zh-Hans-CN'));
});

test('图1（白底黑字）：识别出中文，且坐标在原图范围内', (t) => {
  if (!skipIfNoZh(t)) return;
  const r = byName(batch.json.results, 'plain.png');
  assert.ok(r && r.ok === true, `plain.png 应识别成功：${JSON.stringify(r)}`);
  assert.equal(r.width, 900);
  assert.equal(r.height, 420);

  const flat = strip(r.text);
  console.log(`    plain.png text = ${JSON.stringify(r.text)}`);
  assert.ok(flat.includes('你好') || flat.includes('世界'), `中文识别结果异常：${JSON.stringify(r.text)}`);
  // 同一张图里还有英文
  assert.ok(/HELLO|WORLD/i.test(r.text), `英文识别结果异常：${JSON.stringify(r.text)}`);

  const wordCount = assertCoordsInBounds(r);
  assert.ok(wordCount > 0, 'lines[].words[] 不应为空');
});

test('图2（红色描边艺术字）：不崩溃，如实返回（本机实测可能识别不出）', (t) => {
  if (!skipIfNoZh(t)) return;
  const r = byName(batch.json.results, 'art.png');
  assert.ok(r && r.ok === true, `art.png 应正常返回 ok:true：${JSON.stringify(r)}`);
  assert.equal(typeof r.text, 'string', 'text 必须是字符串');
  assertCoordsInBounds(r);
  console.log(`    art.png(120px, stroke_width=3) text = ${JSON.stringify(r.text)}  <- 艺术字实测表现`);
});

test('图2b（大号描边艺术字 200px）：验证尺寸/字重是艺术字能否识别的关键', (t) => {
  if (!skipIfNoZh(t)) return;
  const big = byName(isolation.json.results, 'art_big.png');
  const bigBold = byName(isolation.json.results, 'art_big_bold.png');
  assert.ok(big && big.ok === true, `art_big.png 应正常返回：${JSON.stringify(big)}`);
  assert.ok(bigBold && bigBold.ok === true, `art_big_bold.png 应正常返回：${JSON.stringify(bigBold)}`);

  const flat = strip(big.text);
  const hit = ['汉', '化', '模', '式'].filter((c) => flat.includes(c)).length;
  console.log(`    art_big.png(200px 常规, stroke=3) text = ${JSON.stringify(big.text)}  命中 ${hit}/4`);
  console.log(`    art_big_bold.png(200px 粗体, stroke=3) text = ${JSON.stringify(bigBold.text)}`);
  assert.ok(hit >= 2, `200px 常规字重描边艺术字应至少识别出 4 字中的 2 字（中文引擎可用时），实际 text=${JSON.stringify(big.text)}`);
});

test('图3（纯空白图）：ok:true 且 text 为空白', (t) => {
  if (!skipIfNotReady(t)) return;
  const r = byName(batch.json.results, 'blank.png');
  assert.ok(r && r.ok === true, `blank.png 应正常返回：${JSON.stringify(r)}`);
  assert.equal(r.text.trim(), '', `空白图 text 应为空，实际 ${JSON.stringify(r.text)}`);
  assert.deepEqual(r.lines, []);
});

test('每张成功的图都报告实际使用的 lang，且该 lang 在 availableLangs 内', (t) => {
  if (!skipIfNotReady(t)) return;
  for (const r of batch.json.results) {
    if (!r.ok) continue;
    assert.ok(typeof r.lang === 'string' && r.lang.length > 0, `缺少 lang：${JSON.stringify(r)}`);
    assert.ok(setup.availableLangs.includes(r.lang), `lang=${r.lang} 不在 availableLangs 内`);
  }
  // 中文内容不得被转义成 \uXXXX
  const r = byName(batch.json.results, 'plain.png');
  assert.ok(batch.raw.includes(r.text.split('\n')[0]), 'out.json 中应能直接读到中文（未被 \\uXXXX 转义）');
  assert.ok(batch.raw.includes('你') && !batch.raw.includes('\\u4f60'), 'out.json 不应把中文转义');
});

test('隔离性：中文路径可用；坏文件/不存在路径只影响自身，其它条照常成功', (t) => {
  if (!skipIfNotReady(t)) return;
  const rs = isolation.json.results;
  assert.equal(isolation.json.ok, true, '单张失败不应让顶层 ok 变 false');
  assert.equal(rs.length, 5);

  const cn = rs[0];
  assert.equal(cn.ok, true, `中文路径图片应成功：${JSON.stringify(cn)}`);
  assert.ok(strip(cn.text).length > 0, '中文路径图片应有识别文本');

  const corrupt = rs[1];
  assert.equal(corrupt.ok, false, '损坏图像应 ok:false');
  assert.equal(typeof corrupt.error, 'string');
  assert.ok(corrupt.error.length > 0, '损坏图像应带 error 信息');

  const missing = rs[2];
  assert.equal(missing.ok, false, '不存在的路径应 ok:false');
  assert.match(missing.error, /不存在|not|find/i);

  // 失败条目之后的图片不受影响
  const after_ = rs[3];
  assert.equal(after_.ok, true, `失败条目之后的图片应照常成功：${JSON.stringify(after_)}`);
  console.log(`    corrupt error  = ${corrupt.error}`);
  console.log(`    missing error  = ${missing.error}`);
});

test('语言引擎：images[i].lang = en-US 时实际使用 en-US（不回落用户配置语言）', (t) => {
  if (!skipIfNoEn(t)) return;
  const [en, ja] = langsRun.json.results;
  assert.equal(en.ok, true, `en-US 识别应成功：${JSON.stringify(en)}`);
  assert.equal(en.lang, 'en-US', `实际识别语言应为 en-US，实际 ${en.lang}（旧原型会错误地回落成用户配置语言）`);
  assert.ok(/HELLO|WORLD/i.test(en.text), `英文识别结果异常：${JSON.stringify(en.text)}`);
  console.log(`    en-US -> lang=${en.lang} text=${JSON.stringify(en.text)}`);

  // ja 本机无识别引擎 -> 按 langs 链回退
  assert.equal(ja.ok, true, `ja 应回退到 langs 链并成功：${JSON.stringify(ja)}`);
  assert.ok(setup.availableLangs.includes(ja.lang), `回退后的 lang 应在 availableLangs 内，实际 ${ja.lang}`);
  console.log(`    ja(无引擎) -> 回退 lang=${ja.lang}`);
});

test('缩放：maxDim 生效，宽高报告原图尺寸，坐标已换算回原图', (t) => {
  if (!skipIfNoZh(t)) return;
  const huge = byName(scaleRun.json.results, 'huge.png');
  assert.equal(huge.ok, true, `huge.png 应成功：${JSON.stringify(huge)}`);
  assert.equal(huge.width, 6000, 'width 必须是原图宽');
  assert.equal(huge.height, 1400, 'height 必须是原图高');
  assert.ok(huge.scale < 1, `huge.png 应被缩放，实际 scale=${huge.scale}`);
  assert.ok(Math.abs(huge.scale - 2000 / 6000) < 1e-6, `scale 应为 2000/6000，实际 ${huge.scale}`);
  assert.ok(strip(huge.text).toUpperCase().includes('SCALE'), `缩放后仍应识别出 SCALE TEST，实际 ${JSON.stringify(huge.text)}`);
  const words = assertCoordsInBounds(huge);
  assert.ok(words > 0, '缩放图也应有词坐标');
  console.log(`    huge.png scale=${huge.scale} text=${JSON.stringify(huge.text)} 首个词=${JSON.stringify(huge.lines[0].words[0])}`);

  const wide = byName(scaleRun.json.results, 'wide.png');
  assert.equal(wide.ok, true);
  assert.equal(wide.width, 12000);
  assert.equal(wide.height, 600);
  assertCoordsInBounds(wide);
  console.log(`    wide.png(maxDim=2000) scale=${wide.scale} text=${JSON.stringify(wide.text)}`);
});

test('硬上限：maxDim 大于 OcrEngine.MaxImageDimension 时按硬上限兜底', (t) => {
  if (!skipIfNoZh(t)) return;
  const r = hardCap.json.results[0];
  assert.equal(r.ok, true, `12000px 宽图在 maxDim=20000 下应成功（否则会撞 MaxImageDimension）：${JSON.stringify(r)}`);
  assert.equal(r.width, 12000);
  const expected = Math.min(20000, setup.maxImageDimension) / 12000;
  assert.ok(Math.abs(r.scale - expected) < 1e-6, `scale 应为 ${expected}，实际 ${r.scale}`);
  assert.ok(strip(r.text).toUpperCase().includes('WIDE'), `应识别出 WIDE，实际 ${JSON.stringify(r.text)}`);
  assertCoordsInBounds(r);
  console.log(`    wide.png(maxDim=20000) 被硬上限 ${setup.maxImageDimension} 兜底 -> scale=${r.scale} text=${JSON.stringify(r.text)}`);
});

test('性能：一次进程处理 3 张图明显快于 3 次单独调用', (t) => {
  if (!skipIfNotReady(t)) return;
  assert.equal(batch.json.results.length, 3, '批量必须一次进程处理 3 张图');
  const sumIndividual = individual.reduce((a, r) => a + r.ms, 0);
  console.log(`    批量 3 张 = ${batch.ms.toFixed(0)}ms | 逐张 3 次 = ${sumIndividual.toFixed(0)}ms（${individual.map((r) => r.ms.toFixed(0)).join('+')}）`);
  assert.ok(batch.ms < sumIndividual, `批量 ${batch.ms.toFixed(0)}ms 应快于逐张合计 ${sumIndividual.toFixed(0)}ms`);
  for (const r of individual) assert.equal(r.exitCode, 0);
});

test('顶层失败：空 images / 非法 JSON 均写出 ok:false 的 out.json', (t) => {
  if (!skipIfNotReady(t)) return;
  // 空 images
  const inPath = path.join(tmpDir, 'top-in.json');
  const outPath = path.join(tmpDir, 'top-out.json');
  fs.writeFileSync(inPath, '{"images":[],"langs":["zh-Hans-CN"]}', 'utf8');
  fs.rmSync(outPath, { force: true });
  let res = spawnSync(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-In', inPath, '-Out', outPath],
    { timeout: SPAWN_TIMEOUT_MS, windowsHide: true, encoding: 'utf8' });
  assert.equal(res.status, 0, '顶层失败时 out.json 仍应写出，退出码 0');
  let json = JSON.parse(fs.readFileSync(outPath, 'utf8').replace(/^\uFEFF/, ''));
  assert.equal(json.ok, false);
  assert.ok(typeof json.error === 'string' && json.error.length > 0);

  // 非法 JSON
  fs.writeFileSync(inPath, '{ not json', 'utf8');
  fs.rmSync(outPath, { force: true });
  res = spawnSync(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-In', inPath, '-Out', outPath],
    { timeout: SPAWN_TIMEOUT_MS, windowsHide: true, encoding: 'utf8' });
  assert.equal(res.status, 0);
  json = JSON.parse(fs.readFileSync(outPath, 'utf8').replace(/^\uFEFF/, ''));
  assert.equal(json.ok, false);
  assert.match(json.error, /解析入参/);
});
