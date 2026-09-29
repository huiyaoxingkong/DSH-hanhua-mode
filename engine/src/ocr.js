// ═══════════════════════════════════════════════════════════════════════════
// 汉化引擎 · OCR 组件（漫画页 / 图片艺术字 / 游戏 UI 图 / 扫描件）
//
// 省 token 的四道闸门（顺序即成本从低到高）：
//   1. 页面级内容哈希缓存（.hanhua-ocr-cache.json）—— 重复运行 0 成本、0 token；
//   2. 本地 Windows OCR（免费、离线、一次进程批量）—— 中文/英文常规字最省；
//   3. 裁剪去重（同图同框只识别一次）；
//   4. 视觉模型只兜底「本地搞不定」的区域（空结果/乱码＝疑似艺术字），且按 budget 限量。
//
// 关键实测结论（见 tests/winocr.test.mjs）：Windows OCR 对**描边中文艺术字**会返回
// 空串或乱码，而「空串」与「图中无字」不可区分 —— 所以「检测到有文字的区域却识别为空」
// 必须触发视觉兜底，否则漫画标题/logo 这类图片艺术字会被静默漏掉。
// ═══════════════════════════════════════════════════════════════════════════

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'tif', 'tiff', 'tga', 'dds', 'avif', 'jfif']
const COMIC_ARCHIVE_EXTS = ['cbz', 'zip']
const VIDEO_EXTS = ['mp4', 'mkv', 'avi', 'mov', 'webm', 'm4v', 'wmv', 'flv', 'ts', 'mpg', 'mpeg']
const isImageExt = (ext) => IMAGE_EXTS.indexOf(String(ext || '').toLowerCase()) >= 0
const isComicArchiveExt = (ext) => COMIC_ARCHIVE_EXTS.indexOf(String(ext || '').toLowerCase()) >= 0
const isVideoExt = (ext) => VIDEO_EXTS.indexOf(String(ext || '').toLowerCase()) >= 0

// ── 文本归一化：Windows OCR 会在相邻汉字之间插空格（"你 好 ， 世 界"）
function normalizeOcrText(text) {
  let s = String(text || '').replace(/\r\n?/g, '\n')
  s = s.replace(/[ \t\u00a0\u3000]+/g, ' ')
  s = s.replace(/([\u2e80-\u9fff\uff00-\uffef\uac00-\ud7af]) (?=[\u2e80-\u9fff\uff00-\uffef\uac00-\ud7af])/g, '$1')
  s = s.replace(/([\u2e80-\u9fff\uff00-\uffef\uac00-\ud7af]) (?=[，。、！？：；）」』】…—])/g, '$1')
  s = s.replace(/([（「『【]) (?=[\u2e80-\u9fff])/g, '$1')
  return s.split('\n').map((l) => l.trim()).filter((l) => l !== '').join('\n')
}

// 本地识别结果是否「不可信」→ 需要视觉兜底
function ocrLooksUnreliable(text, ink) {
  const t = String(text || '')
  if (!t.trim()) return true
  const letters = (t.match(/[A-Za-z]/g) || []).length
  const cjk = (t.match(/[\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]/g) || []).length
  const signal = letters + cjk
  if (signal === 0) return true
  const junk = (t.match(/[^\w\s\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af，。、！？：；「」『』（）【】…—─·~～!?,.:;'"()\[\]-]/g) || []).length
  if (signal <= 2 && (ink || 0) > 0.05) return true
  if (junk >= 1 && junk >= signal * 0.6) return true
  return false
}

// ── OCR 缓存 ──
const OCR_CACHE_VERSION = 2
const ocrCacheKey = (hash, layout, lang) => 'v' + OCR_CACHE_VERSION + '|' + hash + '|' + layout + '|' + lang
async function loadOcrCache() {
  if (state.ocrCacheLoaded) return
  state.ocrCacheLoaded = true
  const raw = await readTextOr(joinPath(state.root, META_OCR_CACHE), null)
  if (!raw) return
  try {
    const parsed = JSON.parse(raw)
    if (parsed && parsed.pages) state.ocrCache = parsed.pages
  } catch (e) {}
}
async function persistOcrCache() {
  try {
    const keys = Object.keys(state.ocrCache)
    if (keys.length > 20000) {
      keys.sort((a, b) => (state.ocrCache[b].at || 0) - (state.ocrCache[a].at || 0))
      const keep = {}
      for (const k of keys.slice(0, 20000)) keep[k] = state.ocrCache[k]
      state.ocrCache = keep
    }
    await writeText(joinPath(state.root, META_OCR_CACHE), JSON.stringify({ savedAt: new Date().toISOString(), pages: state.ocrCache }, null, 2))
  } catch (e) {}
}

// ── 候选页面：单图文件 + 漫画包内的图片条目（按页号排序）
async function collectOcrTargets(args) {
  const maxImages = Math.max(1, Math.min(Number(args.maxImages || config.ocrMaxImages || 40), 2000))
  const files = Array.isArray(args.files) && args.files.length ? args.files : null
  const source = files
    ? files.map((f) => ({ rel: typeof f === 'string' ? f : f.rel, path: typeof f === 'string' ? joinPath(state.root, f) : f.path }))
    : state.files.filter((f) => f.kind === 'image' || f.kind === 'comic')
  const picked = []
  for (const f of source) {
    if (picked.length >= maxImages) break
    const rel = relOf(f.path || f.rel)
    const ext = extOf(rel)
    if (isImageExt(ext)) { picked.push({ file: rel, kind: 'image', pageEntry: null, pageIndex: 0 }); continue }
    if (!isComicArchiveExt(ext)) continue
    const list = await media.zipList(isAbs(f.path) ? f.path : joinPath(state.root, rel))
    const names = (list.entries || []).map((e) => e.name).filter((n) => isImageExt(extOf(n)))
    names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    for (let i = 0; i < names.length && picked.length < maxImages; i++) {
      picked.push({ file: rel, kind: 'comic', pageEntry: names[i], pageIndex: i })
    }
  }
  return { pages: picked, truncated: picked.length >= maxImages }
}

// ── 页面落到本地绝对路径（漫画包按需解包到 .hanhua-tmp）
async function materializePages(targets) {
  const out = []
  const byArchive = {}
  for (const t of targets.pages) {
    if (t.kind === 'image') out.push(Object.assign({}, t, { abs: fs.processPath(await fs.resolve(joinPath(state.root, t.file))) }))
    else (byArchive[t.file] = byArchive[t.file] || []).push(t)
  }
  if (Object.keys(byArchive).length) await ensureTmpDir()
  for (const rel of Object.keys(byArchive)) {
    const group = byArchive[rel]
    helperSeq += 1
    const outAbs = fs.processPath(await fs.resolve(joinPath(tmpDirPath(), 'ocr-' + helperSeq)))
    const r = await media.zipExtract(joinPath(state.root, rel), outAbs, group.map((g) => g.pageEntry))
    const pathByName = {}
    for (const f of (r.files || [])) pathByName[f.name] = f.path
    for (const g of group) {
      const abs = pathByName[g.pageEntry]
      if (abs) out.push(Object.assign({}, g, { abs }))
    }
  }
  return out
}

// ── 视觉模型 OCR：多图一批（摊薄提示词开销），只回传 JSON 数组
const VISION_BATCH = 4
async function visionOcrCrops(crops, hint) {
  const model = config.visionModel || config.model
  if (!config.apiUrl || !config.apiKey) throw new Error('未配置 apiUrl/apiKey，无法使用视觉 OCR')
  const results = []
  for (let i = 0; i < crops.length; i += VISION_BATCH) {
    const batch = crops.slice(i, i + VISION_BATCH)
    const content = [{
      type: 'text',
      text: [
        'You are an OCR engine for manga / game images.',
        'Transcribe EXACTLY the visible text of each of the ' + batch.length + ' images, in order.',
        'Cover speech bubbles, captions, stylized or outlined art text (logos/titles) and UI labels.',
        'Keep the original language and punctuation. Do not translate. Do not explain.',
        hint ? ('Context hint: ' + hint) : '',
        'Return ONLY a JSON array of ' + batch.length + ' strings; use "" for an image with no text.',
      ].filter(Boolean).join('\n'),
    }]
    for (const c of batch) {
      const bytes = await readBytesMax(c.out, 24 * 1024 * 1024)
      content.push({ type: 'image_url', image_url: { url: 'data:image/png;base64,' + bytesToB64(bytes) } })
    }
    const res = await apiRequest({
      model,
      temperature: 0.1,
      max_tokens: Math.max(64, Math.min(Number(config.visionMaxTokens) || 1024, 4096)),
      messages: [{ role: 'user', content }],
    }, 240000)
    noteUsage({ visionCalls: 1, visionImages: batch.length })
    if (res.usage) noteUsage({ visionPromptTokens: res.usage.prompt_tokens || 0, visionCompletionTokens: res.usage.completion_tokens || 0 })
    const text = res.contentText || ''
    let arr = null
    const s = text.indexOf('[')
    const e = text.lastIndexOf(']')
    if (s >= 0 && e > s) { try { arr = JSON.parse(text.slice(s, e + 1)) } catch (err) { arr = null } }
    batch.forEach((c, j) => {
      const v = Array.isArray(arr) ? arr[j] : null
      results.push({ crop: c, text: normalizeOcrText(typeof v === 'string' ? v : ((v && v.text) || '')), engine: 'vision' })
    })
    state.summary.apiUsed = true
  }
  return results
}

// ── 主流程 ──
async function ocrAction(args, exec) {
  await loadMeta()
  await loadOcrCache()
  args = args || {}
  const layout = String(args.layout || config.ocrLayout || 'auto')
  const hintMode = layout === 'manga' ? 'bubble' : (layout === 'art' ? 'art' : 'text')
  const lang = String(args.lang || config.ocrLang || 'auto')
  const force = !!args.force
  const budget = args.budget === undefined ? (Number(config.ocrBudget) || 8) : Math.max(0, Number(args.budget) || 0)
  const localEngine = String(args.engine || config.ocrEngine || 'auto')
  const abilities = await probeAbilities(false)
  const hints = []

  const targets = await collectOcrTargets(args)
  if (!targets.pages.length) {
    return {
      ok: true,
      summary: { pages: 0, regions: 0, recognized: 0, entries: 0 },
      images: [],
      preview: [],
      hints: ['没有可 OCR 的图片：先用 hanhua_scan 扫描项目（会收集 .png/.jpg/.webp/.cbz 等），或用 files 参数指定图片路径。'],
      usage: usageSnapshot(),
    }
  }
  const pages = await materializePages(targets)
  const hashRes = await media.hash(pages.map((p) => p.abs))
  const hashMap = hashRes.hashes || {}

  // 每个页面一条 plan：regions 是最终结果（含缓存文本），todo 是本次要处理的区域下标
  const plans = []
  const summary = { pages: pages.length, cachedPages: 0, regions: 0, localHits: 0, localEmpty: 0, visionRegions: 0, visionSkipped: 0, recognized: 0, entries: 0, pagesWithoutText: 0 }
  for (const p of pages) {
    const key = ocrCacheKey(hashMap[p.abs] || String(p.abs), hintMode, lang)
    const hit = (!force) ? state.ocrCache[key] : null
    if (hit && (!hit.pending || !hit.pending.length)) {
      noteUsage({ ocrCacheHits: 1 })
      summary.cachedPages += 1
      summary.regions += (hit.regions || []).length
      plans.push({ page: p, key, regions: (hit.regions || []).map((r) => Object.assign({}, r)), todo: null, fromCache: true })
    } else if (hit) {
      const regions = (hit.regions || []).map((r) => Object.assign({}, r))
      plans.push({ page: p, key, regions, todo: (hit.pending || []).slice(), fromCache: false })
    } else {
      plans.push({ page: p, key, regions: null, todo: null, fromCache: false })
    }
  }

  // ── 1) 区域检测（一次 Python 进程处理全部新页面）
  const fresh = plans.filter((it) => it.regions === null)
  if (fresh.length) {
    let det = null
    try {
      det = await media.img({ op: 'regions', images: fresh.map((it) => ({ path: it.page.abs, hint: it.page.kind === 'comic' ? 'bubble' : hintMode })), minArea: Number(config.ocrMinArea) || 24, maxRegions: Number(config.ocrMaxRegions) || 60 })
    } catch (e) {
      hints.push('区域检测不可用（' + msg(e) + '）：已退化为「整页当作一个区域」。装好带 Pillow 的 Python（或用 hanhua_config 设置 pythonPath）可获得更准的气泡/艺术字定位。')
    }
    fresh.forEach((it, i) => {
      const r = det && det.results && det.results[i]
      const regions = (r && r.regions) ? r.regions.map((g) => ({ box: [g.x, g.y, g.w, g.h], kind: g.kind || hintMode, ink: g.ink || 0, text: '', engine: '' })) : []
      if (!regions.length) {
        const w = (r && r.width) || 0
        const h = (r && r.height) || 0
        if (w && h) regions.push({ box: [0, 0, w, h], kind: hintMode, ink: 1, text: '', engine: '', fallback: true })
        else hints.push('无法确定图片尺寸（' + it.page.file + '）：本次跳过该图。')
      }
      it.regions = regions
      it.todo = regions.map((_r, idx) => idx)
    })
  }
  for (const it of plans) {
    if (!it.todo) it.todo = it.regions ? it.regions.map((_r, idx) => idx) : []
    summary.regions += (it.regions || []).length
  }

  // ── 2) 裁剪（同一图同框去重）+ 3) 本地 Windows OCR（一次进程批量）
  const useWindows = (localEngine === 'auto' || localEngine === 'windows') && abilities.windowsOcr !== false
  const ocrLang = (lang && lang !== 'auto') ? lang : undefined
  const cropOfRegion = new Map()      // plan.key + '#' + ri -> cropPath
  const localText = new Map()         // cropPath -> { ok, text, lang }
  const toProcess = []
  for (const it of plans) {
    if (it.fromCache) continue
    for (const ri of it.todo) {
      const reg = (it.regions || [])[ri]
      if (!reg) continue
      toProcess.push({ it, ri, reg })
    }
  }
  const seenCrop = new Set()
  const cropItems = []
  for (const job of toProcess) {
    const digest = (hashMap[job.it.page.abs] || '') + ':' + job.reg.box.join(',')
    if (seenCrop.has(digest)) { noteUsage({ ocrDedup: 1 }); cropOfRegion.set(job.it.key + '#' + job.ri, 'dup:' + digest); continue }
    seenCrop.add(digest)
    helperSeq += 1
    const out = fs.processPath(await fs.resolve(joinPath(tmpDirPath(), 'crop-' + helperSeq + '.png')))
    const w = job.reg.box[2]
    const h = job.reg.box[3]
    const scale = (Math.min(w, h) < 120) ? 2 : 1
    cropItems.push({ digest, payload: { path: job.it.page.abs, box: job.reg.box, out, scale } })
    cropOfRegion.set(job.it.key + '#' + job.ri, out)
  }
  const dupCropPath = new Map()
  if (cropItems.length) {
    try {
      const r = await media.img({ op: 'crop', items: cropItems.map((c) => c.payload) })
      ;(r.files || []).forEach((f, i) => {
        const digest = cropItems[i].digest
        dupCropPath.set(digest, f.out)
        cropOfRegion.set(digest, f.out)
      })
      for (const job of toProcess) {
        const cur = cropOfRegion.get(job.it.key + '#' + job.ri)
        if (typeof cur === 'string' && cur.startsWith('dup:')) cropOfRegion.set(job.it.key + '#' + job.ri, dupCropPath.get(cur.slice(4)) || null)
      }
    } catch (e) {
      hints.push('裁剪失败（' + msg(e) + '）：本次跳过图片区域识别。')
    }
  }
  const cropPaths = []
  for (const job of toProcess) {
    const p = cropOfRegion.get(job.it.key + '#' + job.ri)
    if (p) cropPaths.push(p)
  }
  const uniquePaths = Array.from(new Set(cropPaths))
  if (useWindows && uniquePaths.length) {
    try {
      const r = await media.ocr({ images: uniquePaths.map((p) => ({ path: p, lang: ocrLang })), langs: ['zh-Hans-CN', 'en-US'] })
      noteUsage({ ocrCalls: 1 })
      for (const res of (r.results || [])) localText.set(res.path, { ok: !!res.ok, text: normalizeOcrText(res.text || ''), lang: res.lang || '' })
    } catch (e) {
      hints.push('Windows OCR 调用失败（' + msg(e) + '）：' + (abilities.windowsOcr === false ? '本机没有可用的识别语言包（控制面板→语言→中文(简体) 添加「光学字符识别」）。' : '将只使用视觉模型。'))
    }
  }

  // ── 4) 判定每个区域：本地可用 or 需要视觉兜底
  const needVision = []
  for (const job of toProcess) {
    const path = cropOfRegion.get(job.it.key + '#' + job.ri)
    const local = path ? localText.get(path) : null
    const text = local ? local.text : ''
    if (local && local.ok && !ocrLooksUnreliable(text, job.reg.ink)) {
      job.reg.text = text
      job.reg.engine = 'windows-ocr'
      noteUsage({ localOcrHits: 1 })
      summary.localHits += 1
      continue
    }
    summary.localEmpty += 1
    const ink = job.reg.ink || 0
    const worthVision = !!(path) && (job.reg.fallback || job.reg.kind === 'art' || localEngine === 'vision' || !text.trim() || ink >= 0.03)
    if (worthVision) needVision.push({ it: job.it, ri: job.ri, reg: job.reg, path, ink })
  }
  needVision.sort((a, b) => (b.ink || 0) - (a.ink || 0))

  // ── 5) 视觉兜底（按预算限量；没轮到的留到下次，本地结果照常缓存）
  const chosen = []
  for (const v of needVision) {
    if (chosen.length >= budget) { summary.visionSkipped += 1; noteUsage({ visionBudgetSkipped: 1 }); continue }
    chosen.push(v)
  }
  if (chosen.length) {
    try {
      const results = await visionOcrCrops(chosen.map((c) => ({ key: c.it.key, ri: c.ri, out: c.path })), hintMode === 'bubble' ? 'manga speech bubbles' : (hintMode === 'art' ? 'stylized / outlined art text' : ''))
      for (const r of results) {
        const v = chosen.find((c) => c.it.key === r.crop.key && c.ri === r.crop.ri)
        if (!v) continue
        v.reg.text = r.text
        v.reg.engine = r.text ? 'vision' : 'vision-empty'
        if (r.text) summary.visionRegions += 1
      }
    } catch (e) {
      hints.push('视觉 OCR 失败（' + msg(e) + '）：本次只保留本地 OCR 结果。')
    }
  }
  if (summary.visionSkipped) hints.push('有 ' + summary.visionSkipped + ' 个区域因视觉预算（ocrBudget=' + budget + '）未识别：再调一次 hanhua_ocr（可加大 budget）即可继续；已识别的区域命中缓存，不会重复花钱。')

  // ── 6) 写缓存 + 产出条目
  const newEntries = []
  const imageReport = []
  for (const it of plans) {
    const regions = it.regions || []
    const withText = regions.filter((r) => r.text && r.text.trim())
    summary.recognized += withText.length
    if (!withText.length) summary.pagesWithoutText += 1
    if (it.fromCache) {
      imageReport.push({ file: it.page.file, page: it.page.pageEntry, pageIndex: it.page.pageIndex, regions: regions.length, recognized: withText.length, cached: true })
    } else {
      const pendingIdx = regions.map((r, i) => (r.text ? -1 : i)).filter((i) => i >= 0)
      state.ocrCache[it.key] = { at: Date.now(), file: it.page.file, pageEntry: it.page.pageEntry, regions: regions.map((r) => ({ box: r.box, kind: r.kind, ink: r.ink, text: r.text, engine: r.engine })), pending: pendingIdx }
      imageReport.push({ file: it.page.file, page: it.page.pageEntry, pageIndex: it.page.pageIndex, regions: regions.length, recognized: withText.length, cached: false })
    }
    withText.forEach((r, i) => {
      newEntries.push({
        id: it.page.file + '#' + (it.page.pageEntry ? it.page.pageEntry + ':' : '') + 'r' + i,
        file: it.page.file,
        format: 'image',
        engine: r.engine === 'vision' ? 'ocr-vision' : 'ocr-local',
        loc: { box: r.box, kind: r.kind, page: it.page.pageIndex, pageEntry: it.page.pageEntry, ocr: r.engine },
        source: r.text,
        ref: { page: it.page.pageIndex, pageEntry: it.page.pageEntry, box: r.box, kind: r.kind },
      })
    })
  }
  // 合并进 state.entries：替换这些文件的旧图片条目，其它条目原样保留
  const touched = new Set(plans.map((it) => it.page.file))
  const kept = state.entries.filter((e) => !(e.format === 'image' && touched.has(e.file)))
  state.entries = kept.concat(newEntries)
  state.summary.parsed = state.entries.length
  await persistOcrCache()
  await persistParsed()
  await persistUsage()
  summary.entries = newEntries.length
  if (abilities.windowsOcr === false && budget === 0) hints.push('本机没有本地 OCR 且视觉预算为 0：本次不会有任何识别结果。')
  return {
    ok: true,
    summary,
    images: imageReport.slice(0, 100),
    preview: newEntries.slice(0, 20).map((e) => ({ file: e.file, page: e.loc.pageEntry, box: e.loc.box, source: e.source, engine: e.loc.ocr })),
    usage: usageSnapshot(),
    hints,
  }
}
