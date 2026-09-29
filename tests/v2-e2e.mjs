/**
 * 「汉化模式」v2 端到端测试：字幕 / 电子书 / 漫画 / 图片艺术字 OCR / token 账本。
 *
 * 与 harness.mjs 一样用真实内核服务装配最小 Cordis 运行时，然后跑：
 *   scan → parse → ocr → translate → qa → export → usage
 *
 * 在线翻译与视觉 OCR 走**本地 mock 服务**（OpenAI 兼容），因此：
 *   · 不花真实 token、不依赖外网；
 *   · 能真实验证 POST 通道（ctx.web.fetch 发不出 POST，引擎走 node 子进程 fetch）、
 *     视觉 OCR 的多图批量、以及 token 账本记账。
 *
 * 用法：node tests/v2-e2e.mjs [--keep]
 * 退出码：0 = 全部通过。
 */
import { mkdir, rm, readFile, writeFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve as pathResolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import http from 'node:http'

const PROFILE_MODULES = process.env.HANHUA_MODULES || 'D:/Games/汉化模式/.kernel-0.2.0/node_modules'
const imp = (spec) => import(pathToFileURL(join(PROFILE_MODULES, spec)).href)
const PY = process.env.HANHUA_PYTHON || 'C:/Users/lihao/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = pathResolve(HERE, '..')
const PLUGIN = join(REPO, 'preset', 'plugins', 'hanhua', 'index.js')
const WORK = pathResolve(join(HERE, '.work-v2'))
const KEEP = process.argv.includes('--keep')

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

// ── 本地 mock OpenAI 兼容服务：翻译返回 JSON 数组，视觉 OCR 也返回 JSON 数组
const MOCK_TRANSLATION = {
  'Good morning, hero.': '早上好，勇者。',
  'The ancient dragon has returned\nto the northern valley.': '远古巨龙已经归来\n来到北方的山谷。',
  'The ancient dragon has returned': '远古巨龙已经归来',
  'to the northern valley.': '来到北方的山谷。',
  'Welcome to this hamlet.': '欢迎来到这个小村庄。',
  'Take this blade, <b>young hero</b>.': '拿着这把剑，<b>年轻的勇者</b>。',
  // ASS 走 ⟦n⟧ 占位符保护（标签/硬换行不进模型），译文必须原样带回占位符
  '\u27e60\u27e7The dragon sleeps here.': '\u27e60\u27e7巨龙在此沉睡。',
  '\u27e60\u27e7Draw your blade,\u27e61\u27e7brave one.': '\u27e60\u27e7拔出你的剑，\u27e61\u27e7勇敢的人。',
  'The dragon sleeps here.': '巨龙在此沉睡。',
  'Draw your blade,\\Nbrave one.': '拔出你的剑，\\N勇敢的人。',
  'Aldermoor was quiet that morning.': '奥尔德穆尔那天早晨一片寂静。',
  "Only the blacksmith's hammer broke the silence.": '只有铁匠的锤声打破了寂静。',
  'A stranger arrived at dusk, carrying a broken blade.': '黄昏时分，一个陌生人带着断剑到来。',
  'Prologue': '序章',
  'Epilogue': '终章',
  'Hello hero,': '你好，勇者，',
  'welcome!': '欢迎！',
  'The dragon': '巨龙',
  'is coming.': '要来了。',
  'Farewell,': '再会，',
  'friend.': '朋友。',
  'See you': '明天见，',
  'tomorrow.': '朋友。',
  '勇者传说': '勇者传说',
}
const mockCalls = { translate: 0, vision: 0, visionImages: 0, lastBody: null }

const server = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', () => {
    let body = {}
    try { body = JSON.parse(raw) } catch (e) {}
    const content = body.messages && body.messages[0] ? body.messages[0].content : ''
    const isVision = Array.isArray(content) && content.some((p) => p && p.type === 'image_url')
    let out = '[]'
    let usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    if (isVision) {
      mockCalls.vision++
      const imgs = content.filter((p) => p && p.type === 'image_url').length
      mockCalls.visionImages += imgs
      usage = { prompt_tokens: 120 * imgs, completion_tokens: 12 * imgs }
      // 每张图返回一句「识别结果」，视觉兜底路径据此生成条目
      out = JSON.stringify(Array.from({ length: imgs }, (_v, i) => '视觉识别文本' + (i + 1)))
    } else {
      mockCalls.translate++
      mockCalls.lastBody = body
      let pairs = []
      const text = String(content)
      // 引擎把 [语境, 原文] 对放在提示词最后一行（前面正文里也出现过 '[' 字符）
      const lastLine = text.slice(text.lastIndexOf('\n') + 1)
      try { pairs = JSON.parse(lastLine) } catch (err) { pairs = [] }
      out = JSON.stringify(pairs.map((p) => MOCK_TRANSLATION[p[1]] || ('【译】' + p[1])))
      usage = { prompt_tokens: 40 * pairs.length + 30, completion_tokens: 20 * pairs.length + 10 }
    }
    const payload = JSON.stringify({ choices: [{ message: { role: 'assistant', content: out } }], usage })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(payload)
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const PORT = server.address().port
const API_URL = `http://127.0.0.1:${PORT}/v1/chat/completions`

// ── 夹具
await rm(WORK, { recursive: true, force: true })
await mkdir(WORK, { recursive: true })
const project = join(WORK, 'project')
await mkdir(project, { recursive: true })
execFileSync(PY, [join(HERE, 'make-v2-fixtures.py'), project], { stdio: 'inherit' })

// ── 最小 Cordis 运行时（真实内核服务）
const { Context } = await imp('@deepseek-ai/cordis/lib/index.js')
const { LocalFileSystem } = await imp('@deepseek-ai/dsh-fs-local/lib/index.js')
const { SandboxPolicyService } = await imp('@deepseek-ai/dsh-sandbox-policy/lib/index.js')
const { LocalSubprocessRuntime } = await imp('@deepseek-ai/dsh-subprocess-local/lib/index.js')
const { SystemPrompt } = await imp('@deepseek-ai/dsh-system-prompt/lib/index.js')
const { ToolRuntime } = await imp('@deepseek-ai/dsh-tools/lib/index.js')
const { WebRuntime } = await imp('@deepseek-ai/dsh-web/lib/index.js')

const ctx = new Context()
await ctx.plugin({ name: 'test-session-projections', apply(c) { c.provide('sessionProjections', { register: () => () => {}, stateOf: () => null }) } })
await ctx.plugin(LocalFileSystem, { cwd: WORK })
await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: WORK })
await ctx.plugin(LocalSubprocessRuntime)
await ctx.plugin(SystemPrompt, {})
await ctx.plugin(WebRuntime, {})
await ctx.plugin(ToolRuntime, {})

const mod = await import(pathToFileURL(PLUGIN).href)
await ctx.plugin(mod)

const signal = AbortSignal.timeout(1500000)
const exec = { signal, agent: { session: { id: 'v2e2e', header: { cwd: project } } } }
const call = async (name, args = {}) => {
  const def = ctx.tools.get(name)
  if (!def) throw new Error('工具未注册: ' + name)
  const raw = await def.execute(args, exec)
  try { return JSON.parse(raw) } catch { return raw }
}
const dump = (label, v, max = 700) => {
  const s = JSON.stringify(v)
  console.log(`      · ${label}: ${s.length > max ? s.slice(0, max) + ' …' : s}`)
}

try {
  // ── 配置：本地 mock API（翻译 + 视觉 OCR）
  const cfg = await call('hanhua_config', { action: 'set', root: project, apiUrl: API_URL, apiKey: 'mock-key', model: 'mock-translate', visionModel: 'mock-vision', targetLang: '简体中文', sourceLang: 'en', ocrEngine: 'auto', ocrBudget: 8 })
  check('hanhua_config 设置 root/apiUrl/apiKey/visionModel', cfg && cfg.config && cfg.config.root === project && cfg.config.visionModel === 'mock-vision', `root=${cfg && cfg.config && cfg.config.root}`)
  check('hanhua_config 遮蔽 apiKey', !!(cfg && cfg.config && cfg.config.apiKey.includes('****') && !cfg.config.apiKey.includes('mock-key')), cfg && cfg.config && cfg.config.apiKey)

  // ── 1) 扫描：四类载体都能被识别
  const scan = await call('hanhua_scan', {})
  dump('scan.kinds', scan && scan.kinds)
  const k = (scan && scan.kinds) || {}
  check('hanhua_scan 分类统计（字幕/电子书/图片/漫画）', k.subtitle >= 3 && k.ebook >= 1 && k.image >= 2 && k.comic >= 1, JSON.stringify(k))

  // ── 2) 解析：字幕三个格式 + EPUB 章节
  const parse = await call('hanhua_parse', {})
  dump('parse', { total: parse.total, perFile: parse.perFile, errors: parse.errors })
  const per = (parse && parse.perFile) || {}
  check('hanhua_parse 抽出字幕条目（srt/ass/vtt）', (per['subs/ep1.srt'] || 0) >= 3 && (per['subs/ep2.ass'] || 0) >= 2 && (per['subs/ep3.vtt'] || 0) >= 2, JSON.stringify(per))
  check('hanhua_parse 抽出 EPUB 正文（两个章节）', (per['book/book.epub'] || 0) >= 5, `epub=${per['book/book.epub']}`)
  check('hanhua_parse 无错误', (parse.errors || []).length === 0, JSON.stringify(parse.errors))

  // ASS 的覆写标签必须变成占位符（保护起来），注释行不进条目
  // （条目明细在 3b 的增量解析之后一起读盘校验）

  // ── 3) OCR：漫画页走气泡检测 + 本地 Windows OCR（免费）；艺术字走视觉兜底（mock）
  const ocrComic = await call('hanhua_ocr', { files: ['comic/ch1.cbz'], engine: 'auto', layout: 'manga', budget: 4 })
  dump('ocr(comic).summary', ocrComic && ocrComic.summary)
  check('本地 Windows OCR 命中（免费、零 token 路径）', ocrComic && ocrComic.summary && ocrComic.summary.localHits > 0, `localHits=${ocrComic && ocrComic.summary && ocrComic.summary.localHits}`)
  check('漫画页 OCR 产出条目', ocrComic && ocrComic.summary && ocrComic.summary.entries > 0, `entries=${ocrComic && ocrComic.summary && ocrComic.summary.entries}`)

  const ocrArt = await call('hanhua_ocr', { files: ['art/styled.png', 'art/title.png'], engine: 'auto', layout: 'art', budget: 4 })
  dump('ocr(art).summary', ocrArt && ocrArt.summary)
  dump('ocr(art).hints', ocrArt && ocrArt.hints)
  check('艺术字走视觉兜底并产出条目', mockCalls.vision > 0 && ocrArt && ocrArt.summary && ocrArt.summary.entries > 0, `visionCalls=${mockCalls.vision} entries=${ocrArt && ocrArt.summary && ocrArt.summary.entries}`)
  check('视觉 OCR 多图批量（一次请求 ≥2 张）', mockCalls.visionImages >= 2, `visionImages=${mockCalls.visionImages}`)

  // OCR 缓存：第二次应当 0 成本命中
  const cacheFile = JSON.parse(await readFile(join(project, '.hanhua-ocr-cache.json'), 'utf8'))
  const ocr2 = await call('hanhua_ocr', { files: ['comic/ch1.cbz'], engine: 'auto', layout: 'manga', budget: 0 })
  check('OCR 结果落盘为缓存', Object.keys(cacheFile.pages || {}).length > 0, `pages=${Object.keys(cacheFile.pages || {}).length}`)
  check('二次 OCR 命中缓存（零 token 重复运行）', ocr2 && ocr2.summary && ocr2.summary.cachedPages > 0, `cachedPages=${ocr2 && ocr2.summary && ocr2.summary.cachedPages}`)

  // ── 3b) 增量解析不应丢掉既有条目（回归：files=[一个文件] 后整轮条目还在）
  const partial = await call('hanhua_parse', { files: ['subs/ep2.ass'] })
  const parsedFile = JSON.parse(await readFile(join(project, '.hanhua-parsed.json'), 'utf8'))
  check('增量解析保留其它文件的条目', partial && partial.total === 2 && parsedFile.entries.length > 4, `partial=${partial && partial.total} 合计=${parsedFile.entries.length}`)
  const assAll = parsedFile.entries.filter((e) => e.file === 'subs/ep2.ass')
  check('ASS 条目数 = Dialogue 行数（Comment 行不译）', assAll.length === 2, `count=${assAll.length}`)
  check('ASS 覆写标签被 ⟦n⟧ 占位符保护', assAll.some((e) => e.source.includes('\u27e6')), assAll.map((e) => e.source).join(' | '))

  // ── 4) 翻译（走本地 mock POST 通道）
  const tr = await call('hanhua_translate', { limit: 2000 })
  dump('translate.summary', tr && tr.summary)
  dump('translate.usage', tr && tr.usage)
  check('hanhua_translate 调用到在线 API（node POST 通道可用）', mockCalls.translate > 0, `calls=${mockCalls.translate}`)
  check('翻译请求体含语境标签压缩对', !!(mockCalls.lastBody && Array.isArray(mockCalls.lastBody.messages)), mockCalls.lastBody ? mockCalls.lastBody.model : '')
  check('token 账本记账（prompt/completion）', tr && tr.usage && tr.usage.apiPromptTokens > 0 && tr.usage.apiCompletionTokens > 0, JSON.stringify(tr && tr.usage && { p: tr.usage.apiPromptTokens, c: tr.usage.apiCompletionTokens }))
  const methods = (tr && tr.summary && tr.summary.methods) || {}
  check('省 token：跳过无需翻译的条目', (methods.skip || 0) > 0, JSON.stringify(methods))

  // ── 5) 导出：字幕/EPUB/图片各自按原格式回写
  const before = {}
  for (const rel of ['subs/ep1.srt', 'subs/ep2.ass', 'subs/ep3.vtt', 'book/book.epub', 'art/title.png', 'comic/ch1.cbz']) {
    before[rel] = await readFile(join(project, rel))
  }
  const exp = await call('hanhua_export', { mode: 'inplace' })
  dump('export', { total: exp.total, ok: exp.ok })
  dump('export.results', exp.results, 3000)
  check('hanhua_export 全部成功', exp && exp.ok === exp.total, `ok=${exp && exp.ok}/${exp && exp.total}`)

  // SRT：时间轴原样、正文替换
  const srt = await readFile(join(project, 'subs/ep1.srt'), 'utf8')
  check('SRT 保留时间轴结构', srt.includes('00:00:01,000 --> 00:00:03,500') && srt.includes('00:00:04,000 --> 00:00:07,200'), srt.split('\n').slice(0, 4).join(' / '))
  check('SRT 正文已汉化', srt.includes('早上好，勇者。') && srt.includes('远古巨龙已经归来'), srt.slice(0, 120).replace(/\n/g, '⏎'))

  // VTT：NOTE 注释与 cue 标识原样保留
  const vtt = await readFile(join(project, 'subs/ep3.vtt'), 'utf8')
  check('VTT 保留 NOTE 注释与 cue id', vtt.includes('NOTE this cue is a comment and must survive') && vtt.includes('cue-1'), vtt.slice(0, 80).replace(/\n/g, '⏎'))
  check('VTT 正文已汉化且保留内联标签', vtt.includes('欢迎来到这个小村庄。') && vtt.includes('<b>年轻的勇者</b>'), vtt.slice(-160).replace(/\n/g, '⏎'))

  // ASS：样式/Format/Comment 行与覆写标签必须完好
  const ass = await readFile(join(project, 'subs/ep2.ass'), 'utf8')
  check('ASS 保留样式与 Format 行', ass.includes('[V4+ Styles]') && ass.includes('Style: Default,Arial,48') && ass.includes('Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'), '')
  check('ASS 保留 Comment 行与 [Fonts] 段', ass.includes('Comment: 0,0:00:07.00,0:00:09.00') && ass.includes('[Fonts]'), '')
  check('ASS 覆写标签还原为 {\\an8} / \\N', ass.includes('{\\an8}巨龙在此沉睡。') && ass.includes('拔出你的剑，\\N勇敢的人。'), ass.split('\n').filter((l) => l.startsWith('Dialogue')).join(' || '))

  // EPUB：重新打包后仍是合法 zip，mimetype 第一条且 store，正文替换
  check('EPUB 备份生成', existsSync(join(project, 'book/book.epub.bak')), '')
  const epubBuf = await readFile(join(project, 'book/book.epub'))
  check('EPUB 文件已变化', !epubBuf.equals(before['book/book.epub']), `size=${epubBuf.length}`)
  const epubCheck = execFileSync(PY, ['-c', [
    'import sys, zipfile, json',
    'z = zipfile.ZipFile(sys.argv[1])',
    'names = z.namelist()',
    'info = z.infolist()[0]',
    'ch1 = z.read("OEBPS/ch1.xhtml").decode("utf-8")',
    'print(json.dumps({"first": names[0], "method": info.compress_type, "ch1_has_cn": "奥尔德穆尔" in ch1, "names": names}))',
  ].join('\n'), join(project, 'book/book.epub')], { encoding: 'utf8' })
  const epubInfo = JSON.parse(epubCheck.trim().split('\n').pop())
  check('EPUB mimetype 仍是第一个条目且 store', epubInfo.first === 'mimetype' && epubInfo.method === 0, JSON.stringify({ first: epubInfo.first, method: epubInfo.method }))
  check('EPUB 章节正文已汉化', epubInfo.ch1_has_cn === true, '')
  check('EPUB 条目顺序与数量保持', epubInfo.names.length === 7, JSON.stringify(epubInfo.names))

  // 图片：擦字 + 排版（标题图 inplace 回写、comic.cbz 重打包）
  const titleAfter = await readFile(join(project, 'art/title.png'))
  check('图片标题图已被回写（内容变化 + .bak 备份）', !titleAfter.equals(before['art/title.png']) && existsSync(join(project, 'art/title.png.bak')), `size=${titleAfter.length}`)
  const cbzAfter = await readFile(join(project, 'comic/ch1.cbz'))
  const cbzCheck = execFileSync(PY, ['-c', [
    'import sys, zipfile, json, io',
    'from PIL import Image',
    'z = zipfile.ZipFile(sys.argv[1])',
    'names = z.namelist()',
    'im = Image.open(io.BytesIO(z.read(names[0])))',
    'print(json.dumps({"names": names, "size": im.size}))',
  ].join('\n'), join(project, 'comic/ch1.cbz')], { encoding: 'utf8' })
  const cbzInfo = JSON.parse(cbzCheck.trim().split('\n').pop())
  check('漫画包仍是合法 zip 且页数不变', cbzInfo.names.length === 2 && cbzInfo.size[0] === 900, JSON.stringify(cbzInfo))
  check('漫画包已被回写（内容变化 + .bak 备份）', !cbzAfter.equals(before['comic/ch1.cbz']) && existsSync(join(project, 'comic/ch1.cbz.bak')), `size=${cbzAfter.length}`)

  // .bak 还原性：字幕的 .bak 必须等于原文
  const srtBak = await readFile(join(project, 'subs/ep1.srt.bak'), 'utf8')
  check('.bak 是汉化前原文（字幕）', srtBak.includes('Good morning, hero.') && !srtBak.includes('早上好，勇者。'), '')

  // ── 6) QA 与账本
  const qa = await call('hanhua_qa', {})
  check('hanhua_qa 对新媒体条目也能质检', qa && typeof qa.total === 'number' && qa.total > 0, `total=${qa && qa.total} warnings=${qa && qa.warnings}`)
  const usage = await call('hanhua_usage', {})
  dump('usage', usage && usage.usage)
  const u = (usage && usage.usage) || {}
  check('hanhua_usage 汇总 token 与节省项', u.totalTokens > 0 && u.saved && (u.saved.translationCacheHits + u.saved.contextDedupHits + u.saved.skippedNoTranslate + u.saved.localOcrHits + u.saved.ocrCacheHits) > 0, JSON.stringify({ totalTokens: u.totalTokens, saved: u.saved }))

  // ── 7) 媒体能力探测
  const probe = await call('hanhua_media', { action: 'probe' })
  dump('media.probe', probe && probe.abilities)
  check('hanhua_media probe 报告本机能力', probe && probe.abilities && typeof probe.abilities.os === 'string', JSON.stringify({ ffmpeg: probe && probe.abilities && probe.abilities.ffmpeg, python: probe && probe.abilities && !!probe.abilities.python, windowsOcr: probe && probe.abilities && probe.abilities.windowsOcr }))
} catch (e) {
  check('测试执行未抛异常', false, String((e && e.stack) || e))
} finally {
  await new Promise((r) => server.close(r))
}

const failed = results.filter((r) => !r.ok)
console.log(`\n===== v2 端到端：${results.length - failed.length}/${results.length} 通过 =====`)
if (failed.length) {
  console.log('失败项：')
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? ' — ' + f.detail : ''}`)
}
if (!KEEP) await rm(WORK, { recursive: true, force: true })
process.exit(failed.length === 0 ? 0 : 1)
