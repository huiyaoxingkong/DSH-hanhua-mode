// ═══════════════════════════════════════════════════════════════════════════
// 汉化引擎 · 媒体基础设施（子进程脚本、ZIP、HTTP、字幕/EPUB/图片回写、媒体操作）
//
// 与 core.js 同处一个函数作用域（生成器拼在一起），可以直接用 core 里的
// joinPath / readText / writeText / fs / subprocessOf / state / config 等。
//
// 子进程通信一律「写输入 JSON → 跑脚本 → 读输出 JSON」：
// DSH 沙箱下用管道捕获子进程输出会 EPERM，仓库既有 iconv 链路也是这个模式。
// ═══════════════════════════════════════════════════════════════════════════

const TMP_DIR = '.hanhua-tmp'
const META_OCR_CACHE = '.hanhua-ocr-cache.json'
const META_USAGE = '.hanhua-usage.json'
const HELPER_TIMEOUT_MS = 600000
// 1×1 白色 PNG：用作 Windows OCR 的能力探测图（不能拿空 images 探，见 probeAbilities）
const PROBE_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

let helperSeq = 0
const scriptState = {}      // name -> 已落盘内容长度（内容没变就不重写）
const abilityCache = { at: 0, value: null }

const tmpDirPath = () => joinPath(state.root, TMP_DIR)

async function warn(subject, err) {
  state.lastError = subject + ': ' + msg(err)
  try { console.log('hanhua: ' + state.lastError) } catch (e) {}
}

// ---------- 临时目录与内置脚本 ----------
async function ensureTmpDir() {
  const dir = tmpDirPath()
  if (scriptState['__tmpdir'] === dir) return dir
  const subprocess = subprocessOf()
  const node = await resolveNodeExe()
  const target = await fs.resolve(dir)
  const script = 'const fs=require("fs");try{fs.mkdirSync(process.argv[1],{recursive:true});}catch(e){process.exitCode=2;}'
  const handle = subprocess.spawn({ argv: [node, '-e', script, fs.processPath(target)], cwd: spawnCwd(), stdio: { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' }, graceMs: 60000 })
  const done = await handle.done
  if ((done.exitCode ?? 0) !== 0) throw new Error('无法创建临时目录 ' + dir)
  scriptState['__tmpdir'] = dir
  return dir
}

// 把内联脚本写到 <root>/.hanhua-tmp/<name> 并返回其绝对路径。
// PowerShell 5.1 读无 BOM 的 .ps1 会按 ANSI 解码（中文注释会破坏语法），必须补 BOM。
async function materializeScript(name) {
  const raw = SCRIPT_SOURCES[name]
  if (typeof raw !== 'string') throw new Error('缺少内置脚本: ' + name)
  const content = (name.endsWith('.ps1') && raw.charCodeAt(0) !== 0xFEFF) ? ('\uFEFF' + raw) : raw
  await ensureTmpDir()
  const p = joinPath(tmpDirPath(), name)
  const stamp = content.length + ':' + content.slice(0, 48) + ':' + content.slice(-24)
  if (scriptState[name] === stamp) return p
  await writeText(p, content)
  scriptState[name] = stamp
  return p
}

// ---------- 可执行文件探测 ----------
async function resolveNodeExe() {
  try {
    const node = await subprocessOf().resolveExecutable('node')
    if (node) return node
  } catch (e) {}
  return 'node'
}
const PY_CANDIDATES = () => {
  const out = []
  if (config.pythonPath) out.push(config.pythonPath)
  const home = (typeof process !== 'undefined' && process.env && process.env.DSH_HOME) ? String(process.env.DSH_HOME).replace(/[\\/]+$/, '') : ''
  if (home) {
    out.push(home + '/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe')
    out.push(home + '/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3')
  }
  out.push('python', 'python3', 'py')
  return out
}
const PS_CANDIDATES = () => {
  const out = []
  if (config.powershellPath) out.push(config.powershellPath)
  out.push('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', 'powershell', 'pwsh')
  return out
}
const FFMPEG_CANDIDATES = () => {
  const out = []
  if (config.ffmpegPath) out.push(config.ffmpegPath)
  out.push('ffmpeg')
  return out
}
const FFPROBE_CANDIDATES = () => {
  const out = []
  if (config.ffprobePath) out.push(config.ffprobePath)
  if (config.ffmpegPath) out.push(String(config.ffmpegPath).replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1'))
  out.push('ffprobe')
  return out
}

let pythonExeCache = null
async function resolvePythonExe() {
  if (pythonExeCache) return pythonExeCache
  const probe = 'import sys;print(sys.version.split()[0])'
  for (const cand of PY_CANDIDATES()) {
    if (!cand) continue
    try {
      if (isAbs(cand)) {
        const t = await fs.resolve(cand)
        if ((await fs.stat(t)) === undefined) continue
      }
      const r = await execCapture(cand, ['-c', probe], 20000)
      if (r.code === 0 && /\d+\.\d+/.test(r.out)) { pythonExeCache = cand; return cand }
    } catch (e) {}
  }
  return null
}

// 能力探测：跑一个外部命令并把 stdout 落到普通文件再读回来。
// 不直接用管道的理由见 scripts/runprobe.js（沙箱下 named pipe 会 EPERM）。
async function execCapture(exe, args, timeoutMs) {
  await ensureTmpDir()
  helperSeq += 1
  const seq = helperSeq
  const inPath = joinPath(tmpDirPath(), 'capture-' + seq + '.in.json')
  const outPath = joinPath(tmpDirPath(), 'capture-' + seq + '.txt')
  const metaPath = joinPath(tmpDirPath(), 'capture-' + seq + '.json')
  if (isAbs(exe)) {
    const t = await fs.resolve(exe)
    if ((await fs.stat(t)) === undefined) return { code: -1, out: '' }
  } else {
    try {
      const resolved = await subprocessOf().resolveExecutable(exe)
      if (resolved) exe = resolved
    } catch (e) {}
  }
  await writeText(inPath, JSON.stringify({ exe, args: args || [], timeoutMs: timeoutMs || 60000 }))
  const scriptPath = await materializeScript('runprobe.js')
  const p = async (x) => fs.processPath(await fs.resolve(x))
  const spec = {
    argv: [await resolveNodeExe(), await p(scriptPath), await p(inPath), await p(outPath), await p(metaPath)],
    cwd: spawnCwd(),
    stdio: { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' },
    graceMs: (timeoutMs || 60000) + 60000,
  }
  try {
    const handle = subprocessOf().spawn(spec)
    const done = await handle.done
    const out = String(await readTextOr(outPath, '') || '')
    let code = done.exitCode ?? 0
    const metaRaw = await readTextOr(metaPath, null)
    if (metaRaw) { try { const meta = JSON.parse(metaRaw); code = meta.code; if (meta.ok === false) return { code: -1, out, error: meta.error } } catch (e) {} }
    return { code, out }
  } catch (e) {
    return { code: -1, out: '', error: msg(e) }
  }
}

// ---------- 通用脚本执行 ----------
async function runScript(kind, payload, opts) {
  opts = opts || {}
  await ensureTmpDir()
  helperSeq += 1
  const seq = helperSeq
  const inPath = joinPath(tmpDirPath(), kind + '-' + seq + '.in.json')
  const outPath = joinPath(tmpDirPath(), kind + '-' + seq + '.out.json')
  await writeText(inPath, JSON.stringify(payload))
  const inTarget = await fs.resolve(inPath)
  const outTarget = await fs.resolve(outPath)
  let argv
  if (kind === 'node') {
    const scriptPath = await materializeScript(opts.script || 'mediakit.js')
    argv = [await resolveNodeExe(), fs.processPath(await fs.resolve(scriptPath)), fs.processPath(inTarget), fs.processPath(outTarget)]
  } else if (kind === 'python') {
    const py = await resolvePythonExe()
    if (!py) throw new Error('找不到可用的 Python（含 Pillow）解释器：请在 hanhua_config 里设置 pythonPath')
    const scriptPath = await materializeScript(opts.script || 'imglib.py')
    argv = [py, fs.processPath(await fs.resolve(scriptPath)), fs.processPath(inTarget), fs.processPath(outTarget)]
  } else if (kind === 'powershell') {
    const ps = await resolvePowershellExe()
    if (!ps) throw new Error('找不到 Windows PowerShell（图片 OCR 需要它）')
    const scriptPath = await materializeScript(opts.script || 'winocr.ps1')
    argv = [ps, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fs.processPath(await fs.resolve(scriptPath)), '-In', fs.processPath(inTarget), '-Out', fs.processPath(outTarget)]
  } else if (kind === 'argv') {
    argv = opts.argv
  } else {
    throw new Error('未知脚本类型: ' + kind)
  }
  const spec = { argv, cwd: spawnCwd(), stdio: { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' }, graceMs: opts.graceMs || HELPER_TIMEOUT_MS }
  const handle = subprocessOf().spawn(spec)
  const done = await handle.done
  const raw = await readTextOr(outPath, null)
  if (raw === null) throw new Error(kind + ' 脚本没有产出结果文件（code=' + (done.exitCode ?? 0) + '）')
  let parsed = null
  try { parsed = JSON.parse(String(raw).replace(/^\uFEFF/, '')) } catch (e) { throw new Error(kind + ' 结果不是合法 JSON: ' + String(raw).slice(0, 200)) }
  if (parsed && parsed.ok === false && !opts.allowFail) throw new Error(kind + ' 失败: ' + (parsed.error || '未知错误'))
  return parsed
}

let powershellExeCache = null
async function resolvePowershellExe() {
  if (powershellExeCache !== null) return powershellExeCache || null
  for (const cand of PS_CANDIDATES()) {
    try {
      if (isAbs(cand)) {
        const t = await fs.resolve(cand)
        if ((await fs.stat(t)) === undefined) continue
        powershellExeCache = cand
        return cand
      }
      const resolved = await subprocessOf().resolveExecutable(cand)
      if (resolved) { powershellExeCache = resolved; return resolved }
    } catch (e) {}
  }
  powershellExeCache = ''
  return null
}

// ---------- 便捷封装：ZIP / HTTP / 哈希 ----------
const media = {
  hash: (files) => runScript('node', { op: 'hash', files }),
  zipList: (file) => runScript('node', { op: 'zip-list', file }),
  zipRead: (file, name) => runScript('node', { op: 'zip-read', file, name }),
  zipExtract: (file, outDir, names) => runScript('node', { op: 'zip-extract', file, outDir, names }),
  zipWrite: (file, entries) => runScript('node', { op: 'zip-write', file, entries }),
  zipReplace: (file, outFile, replacements, add, remove) => runScript('node', { op: 'zip-replace', file, outFile, replacements, add, remove }),
  httpJson: (req) => runScript('node', { op: 'http-json', url: req.url, method: req.method, headers: req.headers, body: req.body, timeoutMs: req.timeoutMs }, { graceMs: req.timeoutMs ? req.timeoutMs + 30000 : 180000 }),
  img: (payload, opts) => runScript('python', payload, opts),
  ocr: (payload, opts) => runScript('powershell', payload, opts),
}

// ---------- 在线 API（翻译 / 视觉 OCR 共用） ----------
// 为什么走 node 子进程：DSH 的 ctx.web.fetch 只接受 url 且 provider 硬编码 GET，
// POST 主体发不出去（内外核皆然）。子进程里的 fetch 才是真正可用的 POST 通道；
// 只有子进程通道整体不可用时才退回归接口（此时 POST 通常仍会失败，但错误信息一致）。
async function apiRequest(bodyObj, timeoutMs) {
  if (!config.apiUrl) throw new Error('未配置 apiUrl')
  if (!config.apiKey) throw new Error('未配置 apiKey')
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.apiKey }
  let lastErr = null
  try {
    const r = await media.httpJson({ url: config.apiUrl, method: 'POST', headers, body: bodyObj, timeoutMs: timeoutMs || 180000 })
    const text = typeof r.text === 'string' ? r.text : ''
    let json = r.json || null
    if (!json && text) { try { json = JSON.parse(text) } catch (e) { json = null } }
    const choice = json && json.choices && json.choices[0]
    let contentText = ''
    if (choice && choice.message) {
      const c = choice.message.content
      contentText = typeof c === 'string' ? c : (Array.isArray(c) ? c.map((p) => (p && p.text) || '').join('') : '')
    }
    if (typeof r.status === 'number' && r.status >= 400) {
      const detail = (json && json.error && json.error.message) ? json.error.message : text.slice(0, 300)
      throw new Error('API HTTP ' + r.status + ': ' + detail)
    }
    return { ok: true, status: r.status, text, json, contentText, usage: (json && json.usage) || null, transport: 'node' }
  } catch (e) { lastErr = e }
  if (web && typeof web.fetch === 'function') {
    try {
      const res = await web.fetch({ url: config.apiUrl })
      const bodyText = (typeof res === 'string') ? res : (res && (res.body || res.text || res.data)) ? String(res.body || res.text || res.data) : JSON.stringify(res)
      return { ok: true, status: (res && (res.status ?? res.statusCode)) || null, text: String(bodyText), json: null, contentText: String(bodyText), usage: null, transport: 'web', warning: '经由 ctx.web.fetch（GET-only）返回，POST 主体未被发送' }
    } catch (e2) {}
  }
  throw lastErr
}

// ---------- 能力探测（ffmpeg / python+Pillow / Windows OCR / tesseract） ----------
async function probeAbilities(force) {
  // 探测结果进程内常驻（能力不会中途变化）；force=true 才重探。
  if (!force && abilityCache.value) return abilityCache.value
  const abilities = { os: (typeof process !== 'undefined' && process.platform) ? process.platform : 'unknown', ffmpeg: null, ffprobe: null, python: null, pillow: null, windowsOcr: null, ocrLangs: [], fonts: [], tesseract: null }
  for (const cand of FFMPEG_CANDIDATES()) {
    const r = await execCapture(cand, ['-version'], 20000)
    if (r.code === 0 && /ffmpeg version/i.test(r.out)) { abilities.ffmpeg = cand; break }
  }
  for (const cand of FFPROBE_CANDIDATES()) {
    const r = await execCapture(cand, ['-version'], 20000)
    if (r.code === 0 && /ffprobe version/i.test(r.out)) { abilities.ffprobe = cand; break }
  }
  const py = await resolvePythonExe()
  if (py) {
    abilities.python = py
    try {
      const probed = await media.img({ op: 'probe' })
      abilities.pillow = probed.pillow || null
      abilities.fonts = (probed.fonts || []).map((f) => f.path)
      abilities.pillowFonts = (probed.fonts || []).length
    } catch (e) { abilities.pillowError = msg(e) }
  }
  const ps = await resolvePowershellExe()
  if (ps) {
    // 能力探测不能靠「空 images 调用」：winocr.ps1 对空数组返回 ok:false（拿不到语言列表）。
    // 于是写一张 1×1 的合法 PNG 真跑一次 OCR —— 既验证脚本/引擎可用，也拿到识别语言清单。
    try {
      await ensureTmpDir()
      const probeImg = joinPath(tmpDirPath(), 'probe-1x1.png')
      await writeBytes(probeImg, b64ToBytes(PROBE_PNG_B64))
      const r = await media.ocr({ images: [{ path: fs.processPath(await fs.resolve(probeImg)), lang: 'en-US' }], langs: ['zh-Hans-CN', 'en-US'] })
      abilities.ocrLangs = r.availableLangs || []
      abilities.maxImageDimension = r.maxImageDimension || null
      abilities.windowsOcr = !!r.ok && abilities.ocrLangs.length > 0
      if (!abilities.windowsOcr && r.error) abilities.ocrError = r.error
    } catch (e) { abilities.windowsOcr = false; abilities.ocrError = msg(e) }
  }
  for (const cand of ['tesseract']) {
    const r = await execCapture(cand, ['--version'], 20000)
    if (r.code === 0 && /tesseract/i.test(r.out)) { abilities.tesseract = cand; break }
  }
  abilityCache.at = Date.now()
  abilityCache.value = abilities
  return abilities
}

// ---------- token / 成本账本 ----------
function noteUsage(patch) {
  const u = state.usage
  for (const k of Object.keys(patch || {})) u[k] = (u[k] || 0) + (patch[k] || 0)
}
const usageSnapshot = () => {
  const u = state.usage
  const apiTokens = (u.apiPromptTokens || 0) + (u.apiCompletionTokens || 0)
  const visionTokens = (u.visionPromptTokens || 0) + (u.visionCompletionTokens || 0)
  return {
    apiCalls: u.apiCalls || 0,
    apiPromptTokens: u.apiPromptTokens || 0,
    apiCompletionTokens: u.apiCompletionTokens || 0,
    visionCalls: u.visionCalls || 0,
    visionImages: u.visionImages || 0,
    visionPromptTokens: u.visionPromptTokens || 0,
    visionCompletionTokens: u.visionCompletionTokens || 0,
    totalTokens: apiTokens + visionTokens,
    saved: {
      translationCacheHits: u.cacheHits || 0,
      contextDedupHits: u.dedupHits || 0,
      skippedNoTranslate: u.skipHits || 0,
      localOcrHits: u.localOcrHits || 0,
      ocrCacheHits: u.ocrCacheHits || 0,
      ocrRegionDedup: u.ocrDedup || 0,
      visionBudgetSkipped: u.visionBudgetSkipped || 0,
    },
    ocrCalls: u.ocrCalls || 0,
    lastError: state.lastError,
  }
}
async function persistUsage() {
  try { await writeText(joinPath(state.root, META_USAGE), JSON.stringify({ savedAt: new Date().toISOString(), usage: state.usage, totals: usageSnapshot() }, null, 2)) } catch (e) {}
}
async function usageAction(args) {
  await loadMeta()
  if (args && args.action === 'reset') {
    state.usage = emptyUsage()
    await persistUsage()
    return { ok: true, action: 'reset', usage: usageSnapshot() }
  }
  return { ok: true, usage: usageSnapshot(), note: '统计自本轮进程：翻译缓存/去重/跳过、OCR 缓存命中、本地 OCR 命中、视觉模型调用与 token 用量。' }
}
const emptyUsage = () => ({
  apiCalls: 0, apiPromptTokens: 0, apiCompletionTokens: 0,
  visionCalls: 0, visionImages: 0, visionPromptTokens: 0, visionCompletionTokens: 0,
  cacheHits: 0, dedupHits: 0, skipHits: 0,
  localOcrHits: 0, ocrCacheHits: 0, ocrDedup: 0, visionBudgetSkipped: 0, ocrCalls: 0,
})

// ---------- 字幕回写 ----------
async function exportSubtitleFile(rel, rs, entryById, mode) {
  const srcPath = joinPath(state.root, rel)
  const bytes = await readBytesMax(srcPath, KRKR_MAX)
  const dec = decodeBytes(bytes, config.subtitleEncoding)
  const text = dec.text
  const patches = []
  for (const r of rs) {
    if (r.target === r.source) continue
    const e = entryById[r.id]
    if (!e || !e.ref) continue
    patches.push({ ref: e.ref, target: r.target, tokens: e.tokens })
  }
  const outText = applySubtitle(text, patches)
  if (dec.encoding === 'utf-8') return { text: outText, binary: false }
  if (dec.encoding === 'utf-16le' || dec.encoding === 'utf-16be') return { bytes: encodeText(outText, dec.encoding, dec.bom), binary: true }
  return { legacyText: outText, legacyEnc: dec.encoding, binary: 'legacy' }
}

// ---------- EPUB / HTML 回写 ----------
async function readEpubParts(rel) {
  const srcPath = joinPath(state.root, rel)
  const list = await media.zipList(srcPath)
  const names = (list.entries || []).map((e) => e.name)
  const containerName = names.find((n) => /^META-INF\/container\.xml$/i.test(n))
  let opfPath = null
  if (containerName) {
    const c = await media.zipRead(srcPath, containerName)
    opfPath = findContainerOpf(latin1ToText(c.base64))
  }
  if (!opfPath) opfPath = names.find((n) => /\.opf$/i.test(n)) || null
  let opf = null
  if (opfPath) {
    const r = await media.zipRead(srcPath, opfPath)
    opf = parseOpf(latin1ToText(r.base64))
  }
  return { list, names, opfPath, opf }
}
// base64 → UTF-8 文本（自己解码，避免依赖 vm 里未必存在的 atob）
// 注意：查表必须**懒建**——B64CHARS 定义在 core.js 里，而本文件在生成产物中排在 core 之前。
let B64LOOKUP = null
const b64LookupTable = () => {
  if (B64LOOKUP) return B64LOOKUP
  const t = new Int16Array(256).fill(-1)
  for (let i = 0; i < B64CHARS.length; i++) t[B64CHARS.charCodeAt(i)] = i
  t['='.charCodeAt(0)] = -2
  B64LOOKUP = t
  return t
}
const b64ToBytes = (b64) => {
  const table = b64LookupTable()
  const clean = String(b64 || '').replace(/[^A-Za-z0-9+/=]/g, '')
  const out = new Uint8Array(Math.floor(clean.length * 3 / 4))
  let o = 0
  let buf = 0
  let bits = 0
  for (let i = 0; i < clean.length; i++) {
    const v = table[clean.charCodeAt(i)]
    if (v < 0) continue
    buf = (buf << 6) | v
    bits += 6
    if (bits >= 8) { bits -= 8; out[o++] = (buf >> bits) & 0xFF }
  }
  return out.subarray(0, o)
}
const latin1ToText = (b64) => new TextDecoder('utf-8').decode(b64ToBytes(b64))

async function exportEpubFile(rel, rs, entryById, mode) {
  const srcPath = joinPath(state.root, rel)
  const parts = await readEpubParts(rel)
  if (!parts.opf) throw new Error('EPUB 缺少 opf 清单，无法回写')
  // 按「章节文件」归组
  const byChapter = {}
  for (const r of rs) {
    const e = entryById[r.id]
    if (!e || !e.ref || !e.ref.chapter) continue
    if (r.target === r.source) continue
    ;(byChapter[e.ref.chapter] = byChapter[e.ref.chapter] || []).push({ ref: e.ref, target: r.target })
  }
  const replacements = []
  for (const chapter of Object.keys(byChapter)) {
    const read = await media.zipRead(srcPath, chapter)
    const html = latin1ToText(read.base64)
    const patched = applyHtmlTextNodes(html, byChapter[chapter])
    replacements.push({ name: chapter, base64: utf8B64(patched) })
  }
  if (!replacements.length) return { text: null, binary: true, skip: true }
  return { epubReplace: { rel, replacements }, binary: true }
}

async function exportHtmlFile(rel, rs, entryById) {
  const srcPath = joinPath(state.root, rel)
  const bytes = await readBytesMax(srcPath, KRKR_MAX)
  const dec = decodeBytes(bytes, config.krkrEncoding)
  const patches = []
  for (const r of rs) {
    const e = entryById[r.id]
    if (!e || !e.ref || r.target === r.source) continue
    patches.push({ ref: e.ref, target: r.target })
  }
  return { text: applyHtmlTextNodes(dec.text, patches), binary: false }
}

// ---------- 图片 / 漫画回写（擦字 + 排版） ----------
async function exportImageFile(rel, rs, entryById, args) {
  const typeset = args.typeset !== false
  const fontPath = args.fontPath || config.typesetFont || ''
  const srcPath = joinPath(state.root, rel)
  const ext = extOf(rel)
  const isArchive = ['cbz', 'zip'].indexOf(ext) >= 0
  const destRel = args.mode === 'out' ? joinPath('.hanhua-out', rel) : rel

  const buildOps = (list) => list.map((r) => {
    const e = entryById[r.id]
    const box = (e && e.loc && Array.isArray(e.loc.box)) ? e.loc.box : null
    if (!box) return null
    return { box, text: r.target, style: Object.assign({ erase: 'auto' }, fontPath ? { fontPath } : {}) }
  }).filter(Boolean)

  if (!typeset) return { text: null, binary: true, skip: true }

  const tmp = tmpDirPath()
  helperSeq += 1
  const seq = helperSeq
  if (!isArchive) {
    const outPath = args.mode === 'out' ? joinPath(state.root, destRel) : srcPath
    const ops = buildOps(rs)
    if (!ops.length) return { text: null, binary: true, skip: true }
    const srcAbs = fs.processPath(await fs.resolve(srcPath))
    const outAbs = fs.processPath(await fs.resolve(outPath))
    const r = await media.img({ op: 'typeset', items: [{ path: srcAbs, out: outAbs, ops }] })
    return { text: null, binary: true, done: true, files: r.files }
  }
  // 漫画包：按页解包 → 排版 → 重新打包（保留条目顺序/压缩方式）
  const byPage = {}
  for (const r of rs) {
    const e = entryById[r.id]
    if (!e || !e.ref || !e.ref.pageEntry) continue
    if (r.target === r.source) continue
    ;(byPage[e.ref.pageEntry] = byPage[e.ref.pageEntry] || []).push(r)
  }
  const pageNames = Object.keys(byPage)
  if (!pageNames.length) return { text: null, binary: true, skip: true }
  const outDir = joinPath(tmp, 'pages-' + seq)
  const extractDirAbs = fs.processPath(await fs.resolve(outDir))
  const extracted = await media.zipExtract(srcPath, extractDirAbs, pageNames)
  const pathByName = {}
  for (const f of (extracted.files || [])) pathByName[f.name] = f.path
  const items = []
  for (const name of pageNames) {
    const inAbs = pathByName[name]
    if (!inAbs) continue
    const outAbs = inAbs + '.tl.png'
    const ops = buildOps(byPage[name])
    if (!ops.length) continue
    items.push({ path: inAbs, out: outAbs, ops, __name: name })
  }
  if (!items.length) return { text: null, binary: true, skip: true }
  await media.img({ op: 'typeset', items: items.map((it) => ({ path: it.path, out: it.out, ops: it.ops })) })
  const replacements = []
  for (const it of items) {
    const bytes = await readBytesMax(it.out, MARSHAL_MAX)
    replacements.push({ name: it.__name, base64: bytesToB64(bytes) })
  }
  return { epubReplace: { rel, replacements }, binary: true }
}

// ---------- 媒体操作工具 ----------
let ffprobeExeCache
async function resolveProbeExe(cands, label) {
  for (const cand of cands) {
    const r = await execCapture(cand, ['-version'], 20000)
    if (r.code === 0 && r.out.trim()) return cand
  }
  throw new Error('找不到 ' + label + '（可安装后重试，或用 hanhua_config 设置路径）')
}

async function mediaAction(args) {
  await loadMeta()
  const action = String((args && args.action) || 'probe')
  if (action === 'probe') {
    const abilities = await probeAbilities(true)
    const hints = []
    if (!abilities.ffmpeg) hints.push('没有 ffmpeg：视频字幕内嵌轨抽取/回封不可用；外挂字幕（.srt/.ass/.vtt…）不受影响，仍可全流程汉化。')
    if (abilities.ffmpeg && !abilities.ffprobe) hints.push('没有 ffprobe：建议与 ffmpeg 一起安装，否则无法列出字幕轨。')
    if (!abilities.windowsOcr && !abilities.tesseract) hints.push('本机没有可用的本地 OCR：图片/漫画只能走多模态视觉模型（会消耗 token），建议在 Windows 上启用「中文(简体)」语言包。')
    if (!abilities.python) hints.push('找不到带 Pillow 的 Python：图片区域检测/排版不可用（配置 pythonPath 可指定）。')
    return { ok: true, action, abilities, hints }
  }
  if (action === 'subs-list' || action === 'subs-extract') {
    const file = absOf(args.file)
    if (!file) throw new Error('需要 file（视频文件）')
    const ffprobe = await resolveProbeExe(FFPROBE_CANDIDATES(), 'ffprobe')
    const info = await execCapture(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_streams', '-select_streams', 's', file], 60000)
    let streams = []
    try { streams = (JSON.parse(info.out).streams || []) } catch (e) { streams = [] }
    const brief = streams.map((s, i) => ({ index: s.index, codec: s.codec_name, lang: (s.tags && s.tags.language) || '', title: (s.tags && s.tags.title) || '', order: i }))
    if (action === 'subs-list') return { ok: true, action, file: relOf(file), streams: brief }
    if (!streams.length) throw new Error('该视频没有内嵌字幕轨（可用 hanhua_scan 找外挂字幕）')
    const idx = typeof args.stream === 'number' ? args.stream : (brief[0] ? brief[0].index : 0)
    const outRel = args.out || (basenameOf(file).replace(/\.[^.]+$/, '') + '.srt')
    const outAbs = fs.processPath(await fs.resolve(joinPath(state.root, outRel)))
    const ffmpeg = await resolveProbeExe(FFMPEG_CANDIDATES(), 'ffmpeg')
    const r = await execCapture(ffmpeg, ['-y', '-v', 'error', '-i', file, '-map', '0:' + idx, '-c:s', 'srt', outAbs], 300000)
    if (r.code !== 0) throw new Error('ffmpeg 抽字幕失败: ' + (r.out || ('code=' + r.code)))
    return { ok: true, action, stream: idx, out: outRel, note: '已抽出字幕，接着 hanhua_scan/hanhua_parse/hanhua_translate/hanhua_export 即可翻译。' }
  }
  if (action === 'subs-mux') {
    const file = absOf(args.file)
    const sub = absOf(args.sub)
    if (!file || !sub) throw new Error('需要 file（视频）与 sub（译好的字幕）')
    const ffmpeg = await resolveProbeExe(FFMPEG_CANDIDATES(), 'ffmpeg')
    const outRel = args.out || (basenameOf(file).replace(/\.[^.]+$/, '') + '.hansub' + (extOf(file) ? '.' + extOf(file) : '.mkv'))
    const outAbs = fs.processPath(await fs.resolve(joinPath(state.root, outRel)))
    const codec = extOf(sub) === 'ass' ? 'ass' : 'srt'
    const r = await execCapture(ffmpeg, ['-y', '-v', 'error', '-i', file, '-i', sub, '-map', '0', '-map', '1', '-c', 'copy', '-c:s', codec, outAbs], 600000)
    if (r.code !== 0) throw new Error('ffmpeg 回封失败: ' + (r.out || ('code=' + r.code)))
    return { ok: true, action, out: outRel }
  }
  if (action === 'epub-unpack' || action === 'comic-pack') {
    const file = absOf(args.file)
    if (!file) throw new Error('需要 file')
    const outDir = args.out || (basenameOf(file).replace(/\.[^.]+$/, '') + '_unpacked')
    const outAbs = fs.processPath(await fs.resolve(joinPath(state.root, outDir)))
    const r = await media.zipExtract(file, outAbs)
    return { ok: true, action, out: outDir, count: (r.files || []).length }
  }
  if (action === 'epub-pack') {
    const dir = absOf(args.file) || (args.out ? null : null)
    const target = absOf(args.out)
    if (!dir || !target) throw new Error('需要 file（解包目录）与 out（目标 .epub/.cbz）')
    const r = await packDirectory(dir, target)
    return { ok: true, action, out: relOf(target), count: r.count }
  }
  throw new Error('未知 action: ' + action)
}

// 把目录打包成 zip：mimetype 优先且 store（EPUB 规范要求），其余 deflate
async function packDirectory(dir, target) {
  const names = []
  const walk = async (d, prefix) => {
    const items = await listChildren(d)
    for (const it of items) {
      if (it.isDir) await walk(it.path, prefix + it.name + '/')
      else names.push({ name: prefix + it.name, path: it.path })
    }
  }
  await walk(dir, '')
  names.sort((a, b) => a.name.localeCompare(b.name))
  const first = names.findIndex((n) => n.name === 'mimetype')
  if (first > 0) { const [m] = names.splice(first, 1); names.unshift(m) }
  // mimetype 必须是第一个条目且以 store 存放（EPUB 规范），其余用 deflate
  const out = []
  for (let i = 0; i < names.length; i++) {
    const abs = fs.processPath(await fs.resolve(names[i].path))
    out.push({ name: names[i].name, fromFile: abs, compress: names[i].name !== 'mimetype' })
  }
  const r = await media.zipWrite(target, out)
  return { count: out.length, size: r.size }
}

const absOf = (p) => {
  if (!p) return null
  return isAbs(p) ? p : joinPath(state.root, p)
}
const relOf = (p) => relPath(state.root, p)

// ---------- v2 解析器：字幕 / EPUB / HTML / PDF ----------
// 都是「往 list 里塞条目」的形态，ref 必须能被 exportXxx 精确回写。

function parseSubtitleEntries(text, ext, file, list, encoding) {
  const parsed = parseSubtitle(text, ext, { fps: Number(config.subtitleFps) || 0 })
  let n = 0
  for (const e of parsed.entries) {
    if (list.length >= MAX_ENTRIES) break
    const source = String(e.text || '')
    if (!source.trim()) continue
    list.push({
      id: file.rel + '#c' + e.index,
      file: file.rel,
      format: 'subtitle-' + parsed.format,
      engine: 'subtitle',
      source,
      tokens: e.tokens || null,
      ref: e.ref,
      loc: {
        loc: '字幕 #' + (e.index + 1) + '  ' + srtStamp(e.startMs) + ' → ' + srtStamp(e.endMs),
        start: e.startMs, end: e.endMs, subFormat: parsed.format, encoding: encoding || 'utf-8',
      },
    })
    n++
  }
  return n
}

function parseHtmlEntries(html, rel, file, list, fmt, chapter) {
  const nodes = parseHtmlTextNodes(html)
  let n = 0
  for (const node of nodes) {
    if (list.length >= MAX_ENTRIES) break
    if (!looksTranslatable(node.text)) continue
    list.push({
      id: rel + '#' + (chapter ? chapter + ':' : '') + 't' + node.index,
      file: rel,
      format: fmt,
      engine: fmt,
      source: node.text,
      ref: Object.assign({}, node.ref, { chapter: chapter || null }),
      loc: { loc: (chapter ? chapter + ' ' : '') + (node.tag || 'text'), chapter: chapter || null, inHead: !!node.inHead },
    })
    n++
  }
  return n
}

async function parseEpubEntries(rel, file, list) {
  const parts = await readEpubParts(rel)
  if (!parts.opf) throw new Error('EPUB 缺少 opf 清单（META-INF/container.xml 里没有 rootfile）')
  const spine = (parts.opf.spine && parts.opf.spine.length)
    ? parts.opf.spine
    : Object.keys(parts.opf.manifest).map((k) => parts.opf.manifest[k]).filter((it) => isContentMediaType(it.mediaType))
  let n = 0
  const seen = new Set()
  for (const item of spine) {
    const name = resolveHref(parts.opfPath, item.href)
    if (seen.has(name)) continue
    seen.add(name)
    const read = await media.zipRead(joinPath(state.root, rel), name)
    const html = latin1ToText(read.base64)
    n += parseHtmlEntries(html, rel, file, list, 'epub', name)
  }
  return n
}

async function parsePdfEntries(rel, file, list) {
  const abs = fs.processPath(await fs.resolve(joinPath(state.root, rel)))
  const r = await media.img({ op: 'pdf', file: abs, wantText: true, wantImages: false })
  if (!r.hasText) {
    state.lastError = rel + ' 没有可提取的文本层（多半是扫描件）：请用 hanhua_ocr 对页面图片做 OCR'
    return 0
  }
  const pages = String(r.text || '').split('\f')
  let n = 0
  pages.forEach((pageText, pageIndex) => {
    const lines = String(pageText).split(/\r?\n/)
    lines.forEach((line, li) => {
      const s = line.trim()
      if (!s || !looksTranslatable(s)) return
      if (list.length >= MAX_ENTRIES) return
      list.push({
        id: rel + '#p' + pageIndex + 'l' + li,
        file: rel,
        format: 'pdftext',
        engine: 'pdf',
        source: s,
        ref: { page: pageIndex, line: li },
        loc: { loc: '第 ' + (pageIndex + 1) + ' 页 第 ' + (li + 1) + ' 行' },
      })
      n++
    })
  })
  return n
}

// PDF 无法安全回写（要重排字库/字形），于是输出「译文对照文本」到 .hanhua-out/
async function exportPdfSidecar(rel, rs, entryById) {
  const byPage = {}
  for (const r of rs) {
    const e = entryById[r.id]
    if (!e || !e.ref) continue
    ;(byPage[e.ref.page] = byPage[e.ref.page] || []).push({ line: e.ref.line, source: r.source, target: r.target })
  }
  const out = []
  Object.keys(byPage).map(Number).sort((a, b) => a - b).forEach((page) => {
    out.push('===== page ' + (page + 1) + ' =====')
    byPage[page].sort((a, b) => a.line - b.line).forEach((x) => {
      out.push(x.source)
      if (x.target && x.target !== x.source) out.push(x.target)
    })
    out.push('')
  })
  return { text: out.join('\n'), binary: false, sidecar: true }
}
