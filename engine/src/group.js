// ═══════════════════════════════════════════════════════════════════════════
// 图片字体分组（纯函数，无 host 服务依赖，可单独单测）
//
// 游戏常把字体做成图片：一个词/短语由多张小图组成，或一行文字被区域检测切成多个碎片。
// 逐个碎片送去翻译，模型看到的是「孤立的字」和「半截词」，译文必然不通顺。
// 所以在翻译前先把碎片**关联成语义单元**，两条互补的规则：
//
//   · atlas    —— 同一张图、同一行的碎片（一张图集里切出来的字）：
//                 先按垂直重叠分行，再按水平间隙切词组；
//   · sequence —— 文件名序号序列（btn_newgame_0.png、_1.png …），每张图一个碎片：
//                 用「目录 + 剥掉序号的 stem」聚合，要求序号连续、kind 一致。
//
// 约定：
//   · 只「读」items，绝不改字段（返回的 members 是原对象引用，引擎侧按 id 回写）；
//   · 输出完全确定：组按 file/page/位置排序，成员按阅读顺序排序，singles 也排序，
//     所以「同一批碎片换个顺序传进来」结果一致（QA/缓存要能按 id 对齐）。
//   · 注意 sequence 只认 page === null 的「独立小图」；调用方要把独立小图映射成
//     page:null（ocr.js 里独立小图的 loc.page 是 0，必须在适配层转换）。
// ═══════════════════════════════════════════════════════════════════════════

export const GROUP_DEFAULT_OPTIONS = {
  mode: 'auto',           // auto=两条规则都跑（atlas 优先）；filename=只按文件名序号；none=不分组
  minParts: 2,            // 少于这么多成员不成组
  sameLineOverlap: 0.5,   // 同一行判定：垂直重叠 / min(两者高) ≥ 该值
  phraseGap: 2.5,         // 行内词组切分：水平间隙 > phraseGap × 行高 才断开
  maxHeightRatio: 2.5,    // 同一行/同一组的高度比（最大/最小）超过它就不算同一行
  indexStrip: true,       // 文件名序号剥离（_0 / -1 / 2 / (3) / 空格+数字）
}
const GROUP_MODES = ['auto', 'filename', 'none']

// CJK / 假名 / 谚文 / 全角：这些文字之间**不能**插空格，所以拼接分隔符取空串；
// 其余（拉丁、西里尔、希腊…）按词分隔，用空格。
const GROUP_CJK_RE = /[\u1100-\u11FF\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/
// 结尾序号：name(3) / name_04 / name-1 / name 2；必须带分隔符，否则 level2、bg2 这类会被误剥。
const GROUP_INDEX_PAREN_RE = /^(.*?)\((\d+)\)$/
const GROUP_INDEX_TAIL_RE = /^(.*?)[_\- ](\d+)$/

const groupStr = (v) => (v === undefined || v === null ? '' : String(v))
const groupCompareStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
const groupNum = (v, d) => {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN)
  return Number.isFinite(n) ? n : d
}

// 选项归一：全部给默认值，脏值（'abc'、NaN、越界）落回默认，调用方永远不用先校验
const groupOptions = (options) => {
  const o = options || {}
  return {
    mode: GROUP_MODES.indexOf(o.mode) >= 0 ? o.mode : GROUP_DEFAULT_OPTIONS.mode,
    minParts: Math.max(1, Math.floor(groupNum(o.minParts, GROUP_DEFAULT_OPTIONS.minParts))),
    sameLineOverlap: Math.min(1, Math.max(0, groupNum(o.sameLineOverlap, GROUP_DEFAULT_OPTIONS.sameLineOverlap))),
    phraseGap: Math.max(0, groupNum(o.phraseGap, GROUP_DEFAULT_OPTIONS.phraseGap)),
    maxHeightRatio: Math.max(1, groupNum(o.maxHeightRatio, GROUP_DEFAULT_OPTIONS.maxHeightRatio)),
    indexStrip: o.indexStrip === undefined ? GROUP_DEFAULT_OPTIONS.indexStrip : !!o.indexStrip,
  }
}

// box 必须是 4 个有限数且宽高为正（宽高为 0 会让重叠/高度比除零，直接当脏数据）
const groupFiniteBox = (box) => {
  if (!Array.isArray(box) || box.length < 4) return null
  const out = [Number(box[0]), Number(box[1]), Number(box[2]), Number(box[3])]
  for (const n of out) if (!Number.isFinite(n)) return null
  return out[2] > 0 && out[3] > 0 ? out : null
}

// 归一化一条 OCR 结果；脏数据（非对象 / box 不合法 / file 空 / text 非字符串）返回 null → 直接落 singles
const groupEntry = (item, seq) => {
  if (!item || typeof item !== 'object') return null
  if (typeof item.file !== 'string' || item.file === '') return null
  if (typeof item.text !== 'string') return null
  const box = groupFiniteBox(item.box)
  if (!box) return null
  return {
    item, seq, box,
    text: item.text,
    file: item.file,
    page: (typeof item.page === 'number' && Number.isFinite(item.page)) ? item.page : null,
    pageEntry: typeof item.pageEntry === 'string' ? item.pageEntry : null,
  }
}

const groupIdStr = (it) => (it && it.id !== undefined && it.id !== null ? String(it.id) : '')

// singles / 行内排序用的稳定键：file → page（null 排最前）→ pageEntry → 上边 → 左边 → id。
// 全用「自身字段」做键，所以输入顺序被打乱也不影响输出。
const groupItemKey = (it) => {
  const box = it && Array.isArray(it.box) ? it.box : []
  const num = (i) => { const n = Number(box[i]); return Number.isFinite(n) ? n : 0 }
  const page = it && typeof it.page === 'number' && Number.isFinite(it.page) ? it.page : -1
  return [groupStr(it && it.file), page, groupStr(it && it.pageEntry), num(1), num(0), groupIdStr(it)]
}
const groupCompareKeys = (a, b) => {
  for (let i = 0; i < a.length; i++) {
    const c = typeof a[i] === 'string' ? groupCompareStr(a[i], b[i]) : a[i] - b[i]
    if (c) return c
  }
  return 0
}

// 垂直重叠 / min(两者高)：0 = 完全错开，1 = 一方完全落在另一方的高度带内
const groupOverlapRatio = (a, b) => {
  const overlap = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1])
  const base = Math.min(a[3], b[3])
  return base > 0 ? Math.max(0, overlap) / base : 0
}
const groupHeightRatio = (a, b) => Math.max(a[3], b[3]) / Math.min(a[3], b[3])
const groupUnionBox = (boxes) => {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity
  for (const b of boxes) {
    x1 = Math.min(x1, b[0]); y1 = Math.min(y1, b[1])
    x2 = Math.max(x2, b[0] + b[2]); y2 = Math.max(y2, b[1] + b[3])
  }
  return [x1, y1, x2 - x1, y2 - y1]
}
// 行高用中位数：比最大值抗「混进来一个略高的块」，比平均值抗离群点
const groupMedian = (nums) => {
  const s = nums.slice().sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

// 拼接文本：空文本跳过（OCR 可能对纯图形区域返回空串），首尾空白去掉
const groupJoinTexts = (texts, sep) => texts.map((t) => groupStr(t).trim()).filter((t) => t !== '').join(sep)
const groupJoinSeparator = (texts) => {
  for (const t of texts) if (GROUP_CJK_RE.test(groupStr(t))) return ''
  return ' '
}

// ── 文件名：目录 + 去扩展名的 name；再剥离结尾序号得到 stem
export const groupSplitFileName = (file) => {
  const s = groupStr(file).replace(/\\/g, '/')
  const cut = s.lastIndexOf('/')
  const dir = cut >= 0 ? s.slice(0, cut) : ''
  const base = cut >= 0 ? s.slice(cut + 1) : s
  const dot = base.lastIndexOf('.')
  return { dir, base, name: dot > 0 ? base.slice(0, dot) : base }
}
// 无序号（title/logo/bg）或 indexStrip=false → null：绝不把小图卷进序号组
export const groupParseIndexName = (name, indexStrip) => {
  const s = groupStr(name)
  if (indexStrip === false) return null
  const paren = s.match(GROUP_INDEX_PAREN_RE)
  if (paren) return { stem: paren[1], index: Number(paren[2]) }
  const tail = s.match(GROUP_INDEX_TAIL_RE)
  if (tail) return { stem: tail[1], index: Number(tail[2]) }
  return null
}

// ── 规则 1 第一步：分行
// 按上边排序后，「与行锚点垂直重叠 ≥ sameLineOverlap **且** 高度比 ≤ maxHeightRatio」才归入该行；
// 高度也参与判定，是为了让同一横带里的标题/图注自成一「行」，而不是把正文碎片带进同组。
const groupAtlasLines = (list, opts) => {
  const sorted = list.slice().sort((a, b) => (a.box[1] - b.box[1]) || (a.box[0] - b.box[0]) || groupCompareStr(groupIdStr(a.item), groupIdStr(b.item)))
  const lines = []
  for (const en of sorted) {
    let hit = null
    for (const line of lines) {
      if (groupOverlapRatio(line.anchor.box, en.box) < opts.sameLineOverlap) continue
      if (groupHeightRatio(line.anchor.box, en.box) > opts.maxHeightRatio) continue
      hit = line
      break
    }
    if (!hit) { hit = { anchor: en, members: [] }; lines.push(hit) }
    hit.members.push(en)
  }
  for (const line of lines) line.members.sort((a, b) => (a.box[0] - b.box[0]) || (a.box[1] - b.box[1]) || groupCompareStr(groupIdStr(a.item), groupIdStr(b.item)))
  return lines
}

// ── 规则 1 第二步：行内按水平间隙切词组（间隙 = 后一个 x - 前一个 x+w，负数=重叠 → 不断开）
const groupSplitPhrases = (members, lineHeight, phraseGap) => {
  const limit = phraseGap * lineHeight
  const segs = []
  let cur = []
  for (const en of members) {
    if (cur.length) {
      const prev = cur[cur.length - 1]
      if (en.box[0] - (prev.box[0] + prev.box[2]) > limit) { segs.push(cur); cur = [] }
    }
    cur.push(en)
  }
  if (cur.length) segs.push(cur)
  return segs
}

// 规则 1：同一 file + 同一 page 才可比（不同图/不同页的坐标没有共同参照系）
const groupAtlasSpecs = (entries, opts) => {
  const buckets = new Map()
  for (const en of entries) {
    const key = en.file + '\u0000' + (en.page === null ? '' : en.page)
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key).push(en)
  }
  const specs = []
  for (const bucket of buckets.values()) {
    for (const line of groupAtlasLines(bucket, opts)) {
      const members = line.members
      if (members.length < opts.minParts) continue
      const hs = members.map((e) => e.box[3])
      // 锚点比对只保证「与锚点」的比值达标，行内最大/最小仍可能超标（例如 16px 与 100px 都在 40px 锚点的 2.5 倍内）→ 整行不分组
      if (Math.max.apply(null, hs) / Math.min.apply(null, hs) > opts.maxHeightRatio) continue
      for (const seg of groupSplitPhrases(members, groupMedian(hs), opts.phraseGap)) {
        if (seg.length < opts.minParts) continue
        specs.push({
          kind: 'atlas',
          entries: seg,
          meta: { file: seg[0].file, page: seg[0].page, pageEntry: seg[0].pageEntry, unionBox: groupUnionBox(seg.map((e) => e.box)), anchorIndex: 0 },
        })
      }
    }
  }
  return specs
}

// 序号连续段：3,4,5 可以；3,5,6 断成 [3] 与 [5,6]
const groupSplitRuns = (list) => {
  const runs = []
  let cur = []
  for (const c of list) {
    if (cur.length && c.index !== cur[cur.length - 1].index + 1) { runs.push(cur); cur = [] }
    cur.push(c)
  }
  if (cur.length) runs.push(cur)
  return runs
}
// kind 一致才算一组：同一 stem 下混了 art/text 时按 kind 切开（切开后还要再验连续性）
const groupSplitByKind = (list) => {
  const parts = []
  let cur = []
  for (const c of list) {
    if (cur.length && c.kind !== cur[cur.length - 1].kind) { parts.push(cur); cur = [] }
    cur.push(c)
  }
  if (cur.length) parts.push(cur)
  return parts
}

// 规则 2：目录 + stem 相同的 item，序号必须构成连续段、kind 一致，且成员数 ≥ minParts
const groupSequenceSpecs = (entries, opts) => {
  const buckets = new Map()
  for (const en of entries) {
    const parts = groupSplitFileName(en.file)
    const hit = groupParseIndexName(parts.name, opts.indexStrip)
    if (!hit) continue
    const key = parts.dir + '\u0000' + hit.stem
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key).push({ en, index: hit.index, kind: groupStr(en.item.kind) })
  }
  const specs = []
  for (const list of buckets.values()) {
    list.sort((a, b) => (a.index - b.index) || groupCompareKeys(groupItemKey(a.en.item), groupItemKey(b.en.item)))
    // 同号（a_1 与 a_01 同时存在）只留第一个，避免"两张图挤进同一个序号"导致错位
    const uniq = list.filter((c, i) => i === 0 || c.index !== list[i - 1].index)
    for (const run of groupSplitRuns(uniq)) {
      for (const part of groupSplitByKind(run)) {
        for (const sub of groupSplitRuns(part)) {
          if (sub.length < opts.minParts) continue
          specs.push({
            kind: 'sequence',
            entries: sub.map((c) => c.en),
            meta: { file: sub[0].en.file, page: null, pageEntry: null, unionBox: sub[0].en.box.slice(), anchorIndex: 0 },
          })
        }
      }
    }
  }
  return specs
}

// 组对象：members 保持规范顺序；boxes/unionBox 是新数组（不与入参共享引用）
const groupMakeGroup = (entries, kind, meta, usedIds) => {
  const head = entries[0]
  const anchorKey = groupIdStr(head.item) !== '' ? groupIdStr(head.item) : 'i' + head.seq
  let id = 'g:' + anchorKey + '+' + entries.length
  if (usedIds.has(id)) { let k = 2; while (usedIds.has(id + '#' + k)) k++; id += '#' + k }
  usedIds.add(id)
  const texts = entries.map((e) => e.text)
  const sep = groupJoinSeparator(texts)
  return {
    id,
    kind,
    file: meta.file,
    page: meta.page === undefined ? null : meta.page,
    pageEntry: meta.pageEntry === undefined ? null : meta.pageEntry,
    members: entries.map((e) => e.item),
    boxes: entries.map((e) => e.box.slice()),
    unionBox: meta.unionBox || groupUnionBox(entries.map((e) => e.box)),
    anchorIndex: Number.isFinite(meta.anchorIndex) ? meta.anchorIndex : 0,
    naiveSource: groupJoinTexts(texts, sep),
    joinSeparator: sep,
  }
}

// 组排序：file → page → pageEntry → kind → 上边 → 左边 → id（全用自身字段，与输入顺序无关）
const groupCompareGroup = (a, b) => groupCompareStr(a.file, b.file)
  || ((a.page === null ? -1 : a.page) - (b.page === null ? -1 : b.page))
  || groupCompareStr(a.pageEntry || '', b.pageEntry || '')
  || groupCompareStr(a.kind, b.kind)
  || (a.unionBox[1] - b.unionBox[1])
  || (a.unionBox[0] - b.unionBox[0])
  || groupCompareStr(a.id, b.id)

// ── 主入口
// items: [{ id, file, page, pageEntry, box:[x,y,w,h], text, kind, engine, ink }, ...]
// 返回 { groups, singles, stats }；stats.byKind 是**组数**（成员数看 grouped 或各组 members.length）
export const groupImageFonts = (items, options) => {
  const list = Array.isArray(items) ? items : []
  const opts = groupOptions(options)
  if (opts.mode === 'none' || !list.length) {
    return {
      groups: [],
      singles: list.slice(),
      stats: { input: list.length, grouped: 0, groups: 0, singles: list.length, byKind: { atlas: 0, sequence: 0 } },
    }
  }
  const usable = []
  for (let i = 0; i < list.length; i++) {
    const en = groupEntry(list[i], i)
    if (en) usable.push(en)
  }
  const specs = opts.mode === 'auto' ? groupAtlasSpecs(usable, opts) : []
  // auto 下 atlas 优先：同图同行是更强的证据；sequence 只在剩下的独立小图上跑
  const groupedSeq = new Set()
  for (const s of specs) for (const e of s.entries) groupedSeq.add(e.seq)
  const pool = usable.filter((e) => e.page === null && !groupedSeq.has(e.seq))
  for (const s of groupSequenceSpecs(pool, opts)) specs.push(s)
  const usedIds = new Set()
  const groups = specs.map((s) => groupMakeGroup(s.entries, s.kind, s.meta, usedIds)).sort(groupCompareGroup)
  const usedSeq = new Set()
  for (const s of specs) for (const e of s.entries) usedSeq.add(e.seq)
  const singles = list.filter((_it, i) => !usedSeq.has(i)).sort((a, b) => groupCompareKeys(groupItemKey(a), groupItemKey(b)))
  const stats = { input: list.length, grouped: usedSeq.size, groups: groups.length, singles: singles.length, byKind: { atlas: 0, sequence: 0 } }
  for (const g of groups) stats.byKind[g.kind] += 1
  return { groups, singles, stats }
}
