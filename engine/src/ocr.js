// ═══════════════════════════════════════════════════════════════════════════
// 汉化引擎 · OCR 组件（漫画页 / 图片艺术字 / 图片字体 / 游戏 UI 图 / 扫描件）
//
// 省 token 的闸门（顺序即成本从低到高）：
//   1. 页面级内容哈希缓存 + 语义单元级缓存 —— 重复运行 0 成本、0 token；
//   2. 本地 Windows OCR（免费、离线、一次进程批量）—— 中文/英文常规字最省；
//   3. 裁剪去重（同图同框只识别一次）；
//   4. 视觉模型只兜底「本地搞不定」的区域（空结果/乱码＝疑似艺术字），且按 budget 限量。
//
// 图片字体（游戏用图片代替字体）的关键：**先关联，再识别**。
// 逐张小图 OCR 只会得到碎片（"New" / "Ga" / "me"）甚至空串，翻译出来必然不通顺；
// 因此管线是「区域检测 → 裁剪 → **分组**（文件名序号序列 / 同一行的碎片）→
// **拼接成一条** → 整体 OCR → 一个语义单元条目 → 整句翻译」。
// 拼接后再识别同时更省钱：一次 OCR 出一个词，而不是每个碎片各跑一次（还可能各自触发视觉兜底）。
//
// 另一条实测结论（见 tests/winocr.test.mjs）：Windows OCR 对**描边中文艺术字**会返回
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

// 图片字体片段的「像精灵图」判定：整页很小（UI 小图），而不是整页漫画/插画。
// 只用来决定「文件名序号序列」是否可信，避免把 page_001..page_400 这种整页图当成一个词组。
const SPRITE_PAGE_AREA = 420000
const spriteLikePage = (w, h) => (Number(w) > 0 && Number(h) > 0 && Number(w) * Number(h) <= SPRITE_PAGE_AREA)

// ── OCR 缓存 ──
const OCR_CACHE_VERSION = 3
const ocrCacheKey = (hash, layout, lang) => 'v' + OCR_CACHE_VERSION + '|' + hash + '|' + layout + '|' + lang
// 语义单元（词组）缓存：键由成员裁剪的稳定标识拼成，跨文件也能命中
const groupCacheKey = (ids) => 'g' + OCR_CACHE_VERSION + '|' + ids.slice().sort().join('+')
async function loadOcrCache() {
  if (state.ocrCacheLoaded) return
  state.ocrCacheLoaded = true
  const raw = await readTextOr(joinPath(state.root, META_OCR_CACHE), null)
  if (!raw) return
  try {
    const parsed = JSON.parse(raw)
    if (parsed && parsed.pages) state.ocrCache = Object.assign({}, parsed.pages, parsed.groups || {})
  } catch (e) {}
}
async function persistOcrCache() {
  try {
    const keys = Object.keys(state.ocrCache)
    if (keys.length > 40000) {
      keys.sort((a, b) => (state.ocrCache[b].at || 0) - (state.ocrCache[a].at || 0))
      const keep = {}
      for (const k of keys.slice(0, 40000)) keep[k] = state.ocrCache[k]
      state.ocrCache = keep
    }
    const pages = {}
    const groups = {}
    for (const k of Object.keys(state.ocrCache)) (k.charAt(0) === 'g' ? groups : pages)[k] = state.ocrCache[k]
    await writeText(joinPath(state.root, META_OCR_CACHE), JSON.stringify({ savedAt: new Date().toISOString(), pages, groups }, null, 2))
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
        'Some images are several fragments of ONE label, already stitched left-to-right: read them as a single phrase.',
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

  // ── 1) 每个页面一条 plan（缓存命中直接用，否则检测）
  const plans = []
  const summary = {
    pages: pages.length, cachedPages: 0, regions: 0, localHits: 0, localEmpty: 0,
    visionRegions: 0, visionSkipped: 0, recognized: 0, entries: 0, pagesWithoutText: 0,
    groups: 0, groupCacheHits: 0, imageFontEntries: 0,
  }
  for (const p of pages) {
    const key = ocrCacheKey(hashMap[p.abs] || String(p.abs), hintMode, lang)
    const hit = (!force) ? state.ocrCache[key] : null
    if (hit && Array.isArray(hit.regions) && hit.regions.length) {
      noteUsage({ ocrCacheHits: 1 })
      summary.cachedPages += 1
      plans.push({ page: p, key, regions: hit.regions.map((r) => Object.assign({}, r)), fromCache: true, width: hit.width, height: hit.height })
    } else {
      plans.push({ page: p, key, regions: null, fromCache: false, width: 0, height: 0 })
    }
  }

  // ── 2) 区域检测（一次 Python 进程处理全部新页面）
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
      const regions = (r && r.regions) ? r.regions.map((g) => ({ box: [g.x, g.y, g.w, g.h], kind: g.kind || hintMode, ink: g.ink || 0, text: '', engine: '', done: false })) : []
      if (!regions.length) {
        const w = (r && r.width) || 0
        const h = (r && r.height) || 0
        if (w && h) regions.push({ box: [0, 0, w, h], kind: hintMode, ink: 1, text: '', engine: '', done: false, fallback: true })
        else hints.push('无法确定图片尺寸（' + it.page.file + '）：本次跳过该图。')
      }
      it.regions = regions
      it.width = (r && r.width) || 0
      it.height = (r && r.height) || 0
    })
  }
  for (const it of plans) for (const r of (it.regions || [])) { r.done = r.done === undefined ? !!r.text : r.done }
  for (const it of plans) summary.regions += (it.regions || []).length

  // ── 3) 图片字体关联：把碎片描述符交给分组器（先关联、再识别）
  const descriptors = []
  const refOf = new Map()
  for (const it of plans) {
    const regions = it.regions || []
    for (let ri = 0; ri < regions.length; ri++) {
      const reg = regions[ri]
      const id = it.key + '#' + ri
      descriptors.push({
        id,
        file: it.page.file,
        page: it.page.kind === 'comic' ? it.page.pageIndex : null,
        pageEntry: it.page.pageEntry,
        box: reg.box,
        text: reg.text || '',
        kind: reg.kind || hintMode,
        ink: reg.ink || 0,
      })
      refOf.set(id, { plan: it, ri, reg })
    }
  }
  const grouped = groupImageFonts(descriptors, {
    mode: force ? 'auto' : String(config.imageFontGrouping || 'auto'),
    minParts: Math.max(2, Number(config.imageFontMinParts) || 2),
    phraseGap: Number(config.imageFontPhraseGap) || 2.5,
  })
  // 「文件名序号序列」只对 UI 小图成立：整页图（漫画页/插画）不参与，避免把 page_001…page_400 拼成一个词；
  // 同时限制单组成员数（一个词很少由 8 张以上碎片拼成，超过就当它是「一串独立图标」而放弃关联）。
  const maxParts = Math.max(2, Number(config.imageFontMaxParts) || 8)
  const groups = grouped.groups.filter((g) => {
    if (g.members.length > maxParts) return false
    if (g.kind !== 'sequence') return true
    return g.members.every((m) => {
      const ref = refOf.get(m.id)
      if (!ref) return false
      return spriteLikePage(ref.plan.width, ref.plan.height)
    })
  })
  const droppedByMax = grouped.groups.length - groups.length
  if (droppedByMax > 0) {
    hints.push('有 ' + droppedByMax + ' 组编号小图因「成员过多 / 整页尺寸」未做关联（疑似一串独立图标而不是一个词）：想强制关联可调大 imageFontMaxParts，或把 imageFontGrouping 固定为 filename。')
  }
  const groupedIds = new Set()
  for (const g of groups) for (const m of g.members) groupedIds.add(m.id)

  // ── 4) 组缓存命中 / 待处理分组
  const groupJobs = []
  const cachedGroupText = new Map()   // groupId -> {text, engine}
  for (const g of groups) {
    const hit = (!force) ? state.ocrCache[groupCacheKey(g.members.map((m) => m.id))] : null
    if (hit && typeof hit.text === 'string') {
      noteUsage({ ocrCacheHits: 1 })
      summary.groupCacheHits += 1
      cachedGroupText.set(g.id, { text: hit.text, engine: hit.engine || 'cache' })
    } else {
      groupJobs.push(g)
    }
    summary.groups += 1
  }

  // ── 5) 裁剪（分组成员 + 单区域，同图同框去重）
  const regionJobs = []
  for (const it of plans) {
    const regions = it.regions || []
    for (let ri = 0; ri < regions.length; ri++) {
      const reg = regions[ri]
      const id = it.key + '#' + ri
      if (groupedIds.has(id)) continue
      if (reg.done && !reg.text) continue          // 已确认「此处无文字」，不再重试
      if (reg.text && reg.done) continue           // 已有文本
      regionJobs.push({ id, plan: it, ri, reg })
    }
  }
  const needCropIds = []
  for (const g of groupJobs) for (const m of g.members) needCropIds.push(m.id)
  for (const j of regionJobs) needCropIds.push(j.id)
  const cropPath = new Map()      // descriptor id -> crop 绝对路径
  const cropScale = new Map()     // descriptor id -> 裁剪放大倍数（拼接时间距要跟着放大）
  const seenCrop = new Set()
  const cropPayload = []
  const idOfDigest = new Map()
  const digestOfId = new Map()
  const scaleOfDigest = new Map()
  // 图片字体的「同一张图里同行碎片」（atlas）**不拼接**：直接按并集框裁一整块，
  // 保留原图里真实的字间距 —— 拼接会引入假空格（"Continue" 被读成 "Con tinue"）。
  const atlasUnionBox = new Map()
  const groupKindOf = new Map()
  for (const g of groups) groupKindOf.set(g.id, g.kind)
  for (const g of groupJobs) if (g.kind === 'atlas') atlasUnionBox.set(g.id, g.unionBox)
  const atlasJobIds = new Map()
  for (const g of groupJobs) {
    if (g.kind !== 'atlas') continue
    const ref = refOf.get(g.members[0].id)
    if (!ref || !Array.isArray(g.unionBox)) continue
    helperSeq += 1
    const out = fs.processPath(await fs.resolve(joinPath(tmpDirPath(), 'union-' + helperSeq + '.png')))
    const [ux, uy, uw, uh] = g.unionBox
    const upad = 2
    cropPayload.push({ digest: 'atlas:' + g.id, payload: { path: ref.plan.page.abs, box: [ux - upad, uy - upad, uw + upad * 2, uh + upad * 2], out, scale: (Math.min(uw, uh) < 120) ? 2 : 1 } })
    scaleOfDigest.set('atlas:' + g.id, (Math.min(uw, uh) < 48) ? 3 : ((Math.min(uw, uh) < 120) ? 2 : 1))
    atlasJobIds.set(g.id, 'atlas:' + g.id)
    idOfDigest.set('atlas:' + g.id, 'atlas:' + g.id)
  }
  for (const id of needCropIds) {
    const ref = refOf.get(id)
    if (!ref) continue
    const digest = (hashMap[ref.plan.page.abs] || ref.plan.page.file) + ':' + ref.reg.box.join(',')
    digestOfId.set(id, digest)
    if (seenCrop.has(digest)) { noteUsage({ ocrDedup: 1 }); continue }
    seenCrop.add(digest)
    helperSeq += 1
    const out = fs.processPath(await fs.resolve(joinPath(tmpDirPath(), 'crop-' + helperSeq + '.png')))
    const w = ref.reg.box[2]
    const h = ref.reg.box[3]
    // OCR 裁剪要留一点边：区域框常常贴着字形，裁到笔画边缘会让 OCR 把 'O' 读成 'P'。
    // 但**成组的碎片只留极小边**：边留多了会在拼接条里变成「假空格」，词组被读散。
    const inGroup = groupedIds.has(id)
    const pad = inGroup ? 1 : Math.max(2, Math.round(Math.min(w, h) * 0.06))
    const box = [ref.reg.box[0] - pad, ref.reg.box[1] - pad, w + pad * 2, h + pad * 2]
    // 图片字体的碎片常常只有十几像素高：放大 3× 再识别（本地 OCR 对小字基本无解）
    const scale = (Math.min(w, h) < 48) ? 3 : ((Math.min(w, h) < 120) ? 2 : 1)
    cropPayload.push({ digest, payload: { path: ref.plan.page.abs, box, out, scale } })
    scaleOfDigest.set(digest, scale)
    idOfDigest.set(digest, id)
  }
  if (cropPayload.length) {
    try {
      const r = await media.img({ op: 'crop', items: cropPayload.map((c) => c.payload) })
      ;(r.files || []).forEach((f, i) => { idOfDigest.set(cropPayload[i].digest, f.out) })
      for (const [id, digest] of digestOfId) { cropPath.set(id, idOfDigest.get(digest)); cropScale.set(id, scaleOfDigest.get(digest) || 1) }
      for (const [gid, aid] of atlasJobIds) atlasUnionBox.set(gid, idOfDigest.get(aid) || null)
    } catch (e) {
      hints.push('裁剪失败（' + msg(e) + '）：本次跳过图片区域识别。')
    }
  }

  // ── 6) 拼接：把每个待处理分组的成员拼成一条（整体识别才是语义完整的词）
  const stripPath = new Map()      // groupId -> strip 路径
  const stitchedOk = new Set()
  {
    const items = []
    const submitted = new Set()      // 真正提交给 stitch 的组（atlas 走并集裁剪，不在此列）
    const baseGap = Number(config.imageFontGap) || 2
    for (const g of groupJobs) {
      // atlas：直接用并集框那一张（保留原图真实字间距），不需要拼接
      if (g.kind === 'atlas') {
        const p = atlasUnionBox.get(g.id)
        if (p) { stripPath.set(g.id, p); stitchedOk.add(g.id) }
        continue
      }
      const paths = g.members.map((m) => cropPath.get(m.id)).filter(Boolean)
      if (paths.length < 2) continue
      helperSeq += 1
      const out = fs.processPath(await fs.resolve(joinPath(tmpDirPath(), 'strip-' + helperSeq + '.png')))
      // 裁剪为小字放大过 2–3×，间距要跟着放大但必须**很小**，否则 OCR 会在碎片之间插空格（"NewGame" → "New Game"）
      let sc = 1
      for (const m of g.members) sc = Math.max(sc, cropScale.get(m.id) || 1)
      items.push({ paths, out, gap: Math.round(baseGap * sc), padding: 0 })
      stripPath.set(g.id, out)
      stitchedOk.add(g.id)
      submitted.add(g.id)
    }
    if (items.length) {
      // stitch 单条失败时整体 ok:false（但成功的那些条目照常写盘）→ 用 allowFail 保住成功的部分
      const r = await media.img({ op: 'stitch', items }, { allowFail: true }).catch((e) => ({ ok: false, error: msg(e), files: [] }))
      const produced = new Set(((r && r.files) || []).map((f) => f.out))
      for (const id of Array.from(submitted)) {
        if (!produced.has(stripPath.get(id))) { stitchedOk.delete(id); stripPath.delete(id) }
      }
      if (r && r.ok === false) hints.push('部分碎片拼接失败（' + (r.error || '未知错误') + '）：这些碎片退化为逐个识别。')
    }
    if (groupJobs.some((g) => !stitchedOk.has(g.id))) {
      hints.push('有 ' + groupJobs.filter((g) => !stitchedOk.has(g.id)).length + ' 组碎片没能拼接（裁剪缺失或工具不可用），已退回逐个识别。')
    }
  }
  // 拼接失败的组：成员按单区域处理（有文本总比丢掉强）
  for (const g of groupJobs) {
    if (stitchedOk.has(g.id)) continue
    for (const m of g.members) {
      const ref = refOf.get(m.id)
      if (!ref) continue
      groupedIds.delete(m.id)
      if (!(ref.reg.done && (ref.reg.text || ref.reg.engine))) regionJobs.push({ id: m.id, plan: ref.plan, ri: ref.ri, reg: ref.reg })
    }
  }

  // ── 7) 本地 OCR：一次进程批量识别 [拼接条 + 单区域裁剪]
  const useWindows = (localEngine === 'auto' || localEngine === 'windows') && abilities.windowsOcr !== false
  const ocrLang = (lang && lang !== 'auto') ? lang : undefined
  const localText = new Map()     // 路径 -> { ok, text, lang }
  const ocrTargets = []
  for (const g of groupJobs) { if (!stitchedOk.has(g.id)) continue; const p = stripPath.get(g.id); if (p) ocrTargets.push(p) }
  for (const j of regionJobs) { const p = cropPath.get(j.id); if (p) ocrTargets.push(p) }
  const uniqueTargets = Array.from(new Set(ocrTargets))
  if (useWindows && uniqueTargets.length) {
    try {
      const r = await media.ocr({ images: uniqueTargets.map((p) => ({ path: p, lang: ocrLang })), langs: ['zh-Hans-CN', 'en-US'] })
      noteUsage({ ocrCalls: 1 })
      for (const res of (r.results || [])) localText.set(res.path, { ok: !!res.ok, text: normalizeOcrText(res.text || ''), lang: res.lang || '' })
    } catch (e) {
      hints.push('Windows OCR 调用失败（' + msg(e) + '）：' + (abilities.windowsOcr === false ? '本机没有可用的识别语言包（控制面板→语言→中文(简体) 添加「光学字符识别」）。' : '将只使用视觉模型。'))
    }
  }

  // ── 8) 判定：谁可信、谁要视觉兜底
  const inkOfGroup = (g) => {
    let sum = 0
    for (const m of g.members) { const ref = refOf.get(m.id); sum += (ref && ref.reg.ink) || m.ink || 0 }
    return g.members.length ? sum / g.members.length : 0
  }
  const needVision = []
  const groupText = new Map(cachedGroupText)
  for (const g of groupJobs) {
    if (!stitchedOk.has(g.id)) continue
    const p = stripPath.get(g.id)
    const local = p ? localText.get(p) : null
    const text = local ? local.text : ''
    if (local && local.ok && !ocrLooksUnreliable(text, inkOfGroup(g))) {
      groupText.set(g.id, { text, engine: 'windows-ocr' })
      noteUsage({ localOcrHits: 1 })
      summary.localHits += 1
      continue
    }
    summary.localEmpty += 1
    if (p) needVision.push({ kind: 'group', id: g.id, out: p, ink: inkOfGroup(g), members: g.members.length })
  }
  const singleText = new Map()     // descriptor id -> { text, engine, final }
  for (const j of regionJobs) {
    const p = cropPath.get(j.id)
    const local = p ? localText.get(p) : null
    const text = local ? local.text : ''
    if (local && local.ok && !ocrLooksUnreliable(text, j.reg.ink)) {
      singleText.set(j.id, { text, engine: 'windows-ocr', final: true })
      noteUsage({ localOcrHits: 1 })
      summary.localHits += 1
      continue
    }
    summary.localEmpty += 1
    const worthVision = !!p && (j.reg.fallback || j.reg.kind === 'art' || localEngine === 'vision' || !text.trim() || (j.reg.ink || 0) >= 0.03)
    if (worthVision) needVision.push({ kind: 'single', id: j.id, out: p, ink: j.reg.ink || 0 })
  }
  const visionOrder = needVision.slice().sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'group' ? -1 : 1    // 词组优先：语义完整性远比单碎片重要
    return (b.ink || 0) - (a.ink || 0)
  })
  const chosen = []
  const budgetSkippedIds = new Set()
  for (const v of visionOrder) {
    if (chosen.length >= budget) { summary.visionSkipped += 1; noteUsage({ visionBudgetSkipped: 1 }); if (v.kind === 'single') budgetSkippedIds.add(v.id); continue }
    chosen.push(v)
  }
  if (chosen.length) {
    try {
      const results = await visionOcrCrops(chosen.map((c) => ({ key: c.kind + ':' + c.id, out: c.out })), hintMode === 'bubble' ? 'manga speech bubbles' : (hintMode === 'art' ? 'stylized / outlined art text' : 'UI labels assembled from image fragments'))
      for (const r of results) {
        const kind = String(r.crop.key).split(':')[0]
        const id = String(r.crop.key).slice(kind.length + 1)
        if (kind === 'group') { groupText.set(id, { text: r.text, engine: r.text ? 'vision' : 'vision-empty' }); if (r.text) summary.visionRegions += 1 } else { singleText.set(id, { text: r.text, engine: r.text ? 'vision' : 'vision-empty', final: true }); if (r.text) summary.visionRegions += 1 }
      }
    } catch (e) {
      hints.push('视觉 OCR 失败（' + msg(e) + '）：本次只保留本地 OCR 结果。')
    }
  }
  if (summary.visionSkipped) hints.push('有 ' + summary.visionSkipped + ' 个区域因视觉预算（ocrBudget=' + budget + '）未识别：再调一次 hanhua_ocr（可加大 budget）即可继续；已识别的区域命中缓存，不会重复花钱。')

  // ── 9) 落缓存 + 生成条目
  const newEntries = []
  const imageReport = []
  const touched = new Set(plans.map((it) => it.page.file))
  const markDirty = (ref) => { if (ref) ref.plan.dirty = true }
  // 9a) 分组条目
  for (const g of groups) {
    if (!stitchedOk.has(g.id) && !cachedGroupText.has(g.id)) continue
    const parts = []
    for (const m of g.members) {
      const ref = refOf.get(m.id)
      if (!ref) continue
      parts.push({ file: ref.plan.page.file, page: ref.plan.page.kind === 'comic' ? ref.plan.page.pageIndex : null, pageEntry: ref.plan.page.pageEntry, box: ref.reg.box })
    }
    if (parts.length < 2) continue
    const stored = groupText.get(g.id)
    const text = stored ? stored.text : ''
    const anchorFile = parts[0].file
    const anchorBox = (g.kind === 'sequence') ? parts[0].box : g.unionBox
    // 组缓存：未解决（预算不足）就不写，下次继续
    const membersResolved = !!stored
    if (membersResolved) {
      state.ocrCache[groupCacheKey(g.members.map((m) => m.id))] = { at: Date.now(), kind: g.kind, file: anchorFile, memberCount: parts.length, text, engine: stored.engine }
      for (const m of g.members) { const ref = refOf.get(m.id); if (ref) { ref.reg.text = text; ref.reg.engine = stored.engine; ref.reg.done = true; markDirty(ref) } }
    }
    if (!text) continue
    const entryFile = g.kind === 'sequence' ? anchorFile : anchorFile
    newEntries.push({
      id: entryFile + '#' + (parts[0].pageEntry ? parts[0].pageEntry + ':' : '') + 'gf' + newEntries.length,
      file: entryFile,
      format: 'image',
      engine: stored && stored.engine === 'vision' ? 'ocr-vision' : 'ocr-local',
      loc: {
        kind: 'imagefont', groupKind: g.kind, parts, box: anchorBox, unionBox: g.unionBox,
        page: parts[0].page, pageEntry: parts[0].pageEntry, groupId: g.id, memberCount: parts.length,
        naiveSource: g.naiveSource,
      },
      source: text,
      ref: { kind: 'imagefont', parts, box: anchorBox, page: parts[0].page, pageEntry: parts[0].pageEntry, groupKind: g.kind },
    })
    summary.imageFontEntries += 1
    summary.recognized += 1
  }
  // 9b) 单区域条目
  for (const it of plans) {
    const regions = it.regions || []
    for (let ri = 0; ri < regions.length; ri++) {
      const reg = regions[ri]
      const id = it.key + '#' + ri
      if (groupedIds.has(id)) continue
      const s = singleText.get(id)
      if (s) { reg.text = s.text; reg.engine = s.engine; reg.done = true; it.dirty = true }
      // 预算没轮到的区域**不能**标记完成，否则下次不会重试
      else if (!reg.done && !budgetSkippedIds.has(id)) { reg.done = true; it.dirty = true }
      const withText = !!(reg.text && reg.text.trim())
      if (withText) {
        summary.recognized += 1
        newEntries.push({
          id: it.page.file + '#' + (it.page.pageEntry ? it.page.pageEntry + ':' : '') + 'r' + ri,
          file: it.page.file,
          format: 'image',
          engine: reg.engine === 'vision' ? 'ocr-vision' : 'ocr-local',
          loc: { box: reg.box, kind: reg.kind, page: it.page.pageIndex, pageEntry: it.page.pageEntry, ocr: reg.engine },
          source: reg.text,
          ref: { page: it.page.pageIndex, pageEntry: it.page.pageEntry, box: reg.box, kind: reg.kind },
        })
      }
    }
  }
  // 9c) 页面缓存（只存区域几何 + 单区域结果；分组结果在组缓存里）
  for (const it of plans) {
    if (it.fromCache && !it.dirty) continue
    const regions = (it.regions || []).map((r) => ({ box: r.box, kind: r.kind, ink: r.ink, text: r.text || '', engine: r.engine || '', done: !!r.done, fallback: !!r.fallback }))
    if (regions.length) state.ocrCache[it.key] = { at: Date.now(), file: it.page.file, pageEntry: it.page.pageEntry, width: it.width, height: it.height, regions }
  }
  for (const it of plans) {
    const regions = it.regions || []
    const texts = regions.filter((r) => r.text && r.text.trim()).length
    imageReport.push({ file: it.page.file, page: it.page.pageEntry, pageIndex: it.page.pageIndex, regions: regions.length, recognized: texts, cached: !!it.fromCache })
    if (!texts) summary.pagesWithoutText += 1
  }
  // 合并进 state.entries：替换这些文件的旧图片条目，其它条目原样保留
  const kept = state.entries.filter((e) => !(e.format === 'image' && touched.has(e.file)))
  state.entries = kept.concat(newEntries)
  state.summary.parsed = state.entries.length
  await persistOcrCache()
  await persistParsed()
  await persistUsage()
  summary.entries = newEntries.length
  if (summary.imageFontEntries) hints.push('已把 ' + summary.imageFontEntries + ' 个「图片字体」语义单元（共 ' + summary.groups + ' 组候选）整体识别后再翻译：源文本是拼接后的完整词组，不是单碎片。')
  if (abilities.windowsOcr === false && budget === 0) hints.push('本机没有本地 OCR 且视觉预算为 0：本次不会有任何识别结果。')
  return {
    ok: true,
    summary,
    images: imageReport.slice(0, 100),
    preview: newEntries.slice(0, 20).map((e) => ({ file: e.file, page: e.loc.pageEntry, box: e.loc.box, source: e.source, engine: e.loc.ocr || e.engine, parts: e.loc.parts ? e.loc.parts.length : 0 })),
    usage: usageSnapshot(),
    hints,
  }
}
