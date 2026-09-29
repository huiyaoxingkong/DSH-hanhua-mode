// ═══════════════════════════════════════════════════════════════════════════
// 字幕格式库（纯函数，无 host 服务依赖，可单独单测）
//
// 设计要点：
//   · parse 只「读」，返回带 ref（在原文本里的精确位置）的条目；
//   · apply 只按 ref 打补丁，**不动**其它字节 —— 时间轴、样式、注释、
//     顺序、换行风格全部原样保留，这是字幕回写不出事故的关键；
//   · ASS/SSA 的覆写标签（{\an8}）、硬换行（\N）、\h 会被换成 ⟦n⟧ 占位符再送去翻译，
//     回写时还原，保证模型即使手滑也不会破坏样式。
// ═══════════════════════════════════════════════════════════════════════════

const SUB_EXTS = ['srt', 'vtt', 'ass', 'ssa', 'lrc', 'sub', 'smi']
const SUB_DESC = {
  srt: 'SubRip（最常见的外挂字幕）',
  vtt: 'WebVTT（HTML5 字幕）',
  ass: 'ASS（Advanced SubStation Alpha，带样式与覆写标签）',
  ssa: 'SSA（SubStation Alpha 旧版）',
  lrc: 'LRC（歌词/时间标签文本）',
  sub: 'MicroDVD .sub（帧号时间轴）',
  smi: 'SAMI .smi',
}
const isSubtitleExt = (ext) => SUB_EXTS.indexOf(String(ext || '').toLowerCase()) >= 0

// 占位符：ASS 覆写标签与硬换行。用 ⟦n⟧（U+27E6/U+27E7）标记，避免与正文冲突。
const TAG_OPEN = '\u27e6'
const TAG_CLOSE = '\u27e7'
const TAG_RE = /\u27e6(\d+)\u27e7/g

// 把需要保护的片段抽成占位符；返回 { text, tokens }
const protect = (text, patterns) => {
  const tokens = []
  let out = String(text)
  for (const re of patterns) {
    out = out.replace(re, (m) => {
      tokens.push(m)
      return TAG_OPEN + (tokens.length - 1) + TAG_CLOSE
    })
  }
  return { text: out, tokens }
}
const restore = (text, tokens) => String(text).replace(TAG_RE, (m, i) => {
  const t = tokens[Number(i)]
  return t === undefined ? m : t
})

const TIMECODE_SRT = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/
const msOf = (h, m, s, f, fracLen) => ((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1000 + Number(String(f).padEnd(3, '0').slice(0, 3))
const pad = (n, w) => String(n).padStart(w, '0')
const srtStamp = (ms) => {
  const t = Math.max(0, Math.round(ms))
  return pad(Math.floor(t / 3600000), 2) + ':' + pad(Math.floor(t / 60000) % 60, 2) + ':' + pad(Math.floor(t / 1000) % 60, 2) + ',' + pad(t % 1000, 3)
}
const vttStamp = (ms) => srtStamp(ms).replace(',', '.')

// 行切开并保留每行起始偏移（回写用偏移替换，避免重排）
const splitLines = (text) => {
  const lines = []
  let start = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      let end = i
      if (end > start && text[end - 1] === '\r') end--
      lines.push({ start, end, eolEnd: i + 1, text: text.slice(start, end) })
      start = i + 1
    }
  }
  if (start <= text.length) lines.push({ start, end: text.length, eolEnd: text.length, text: text.slice(start) })
  return lines
}

// ── SubRip / WebVTT：按块解析，只记录正文行的位置
function parseCueBlocks(text, fmt) {
  const lines = splitLines(text)
  const entries = []
  let i = 0
  let idx = 0
  while (i < lines.length) {
    const line = lines[i]
    const tc = line.text.match(fmt === 'vtt' ? /(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})/ : TIMECODE_SRT)
    if (!tc) { i++; continue }
    const startMs = msOf(tc[1], tc[2], tc[3], tc[4])
    const endMs = msOf(tc[5], tc[6], tc[7], tc[8])
    // NOTE 与 WEBVTT 的 NOTE 块：紧跟时间轴之后的非提示行
    let j = i + 1
    const bodyFrom = j
    while (j < lines.length && lines[j].text.trim() !== '') j++
    const body = lines.slice(bodyFrom, j).map((l) => l.text).join('\n')
    if (body.trim()) {
      entries.push({
        index: idx++,
        startMs, endMs,
        text: body,
        ref: { kind: 'lines', fmt, from: bodyFrom, to: j - 1, eol: lines[bodyFrom] ? (text[lines[bodyFrom].start - 2] === '\r' ? '\r\n' : '\n') : '\n' },
      })
    }
    i = j
  }
  return entries
}

// ── ASS / SSA：解析 [Events] 段的 Dialogue 行（Format 行决定文本列）
function parseAss(text) {
  const lines = splitLines(text)
  const entries = []
  let inEvents = false
  let formatFields = null
  let idx = 0
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].text
    const section = raw.match(/^\s*\[(.+?)\]\s*$/)
    if (section) { inEvents = /^events$/i.test(section[1]); continue }
    if (!inEvents) continue
    const m = raw.match(/^\s*(Dialogue|Comment)\s*:\s*(.*)$/i)
    if (m && /^format/i.test(raw)) continue
    const fm = raw.match(/^\s*Format\s*:\s*(.*)$/i)
    if (fm) { formatFields = fm[1].split(',').map((s) => s.trim().toLowerCase()); continue }
    if (!m) continue
    if (/^comment$/i.test(m[1])) continue
    const fields = m[2].split(',')
    const textCol = formatFields && formatFields.indexOf('text') >= 0 ? formatFields.indexOf('text') : (fields.length - 1)
    if (textCol >= fields.length) continue
    const dialogueText = fields.slice(textCol).join(',')
    const { text: protectedText, tokens } = protect(dialogueText, [/\{[^{}]*\}/g, /\\[Nnh]/g])
    const prefixLen = m[0].length - m[2].length + fields.slice(0, textCol).join(',').length + (textCol > 0 ? 1 : 0)
    entries.push({
      index: idx++,
      startMs: assTimeToMs(fields[formatFields ? formatFields.indexOf('start') : 1]),
      endMs: assTimeToMs(fields[formatFields ? formatFields.indexOf('end') : 2]),
      text: protectedText,
      tokens,
      rawText: dialogueText,
      ref: { kind: 'chars', from: lines[i].start + prefixLen, to: lines[i].start + prefixLen + dialogueText.length },
    })
  }
  return entries
}
const assTimeToMs = (t) => {
  const m = String(t || '').trim().match(/^(\d+):(\d{2}):(\d{2})[.:](\d{1,2})$/)
  if (!m) return 0
  return ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4]) * 10
}

// ── LRC：[mm:ss.xx] 文本
function parseLrc(text) {
  const lines = splitLines(text)
  const entries = []
  let idx = 0
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].text.match(/^\s*((?:\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\])+)(.*)$/)
    if (!m) continue
    const body = m[2]
    if (!body.trim()) continue
    const tags = m[1].match(/\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g) || []
    const times = tags.map((t) => {
      const mm = t.match(/\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/)
      return (Number(mm[1]) * 60 + Number(mm[2])) * 1000 + Number(String(mm[3] || 0).padEnd(3, '0').slice(0, 3))
    })
    entries.push({
      index: idx++,
      startMs: times.length ? times[0] : 0,
      endMs: times.length > 1 ? times[1] : (times.length ? times[0] : 0),
      text: body,
      ref: { kind: 'chars', from: lines[i].start + m[1].length, to: lines[i].start + m[1].length + body.length },
    })
  }
  return entries
}

// ── MicroDVD .sub：{startFrame}{endFrame}文本|第二行
function parseMicroDvd(text, fps) {
  const lines = splitLines(text)
  const entries = []
  let idx = 0
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].text.match(/^\{(\d+)\}\{(\d+)\}([\s\S]*)$/)
    if (!m) continue
    const body = m[3]
    if (!body.trim()) continue
    const f = Number(fps) > 0 ? Number(fps) : 23.976
    entries.push({
      index: idx++,
      startMs: (Number(m[1]) / f) * 1000,
      endMs: (Number(m[2]) / f) * 1000,
      text: body.split('|').join('\n'),
      rawText: body,
      ref: { kind: 'chars', from: lines[i].start + m[1].length + m[2].length + 4, to: lines[i].start + lines[i].text.length },
    })
  }
  return entries
}

// ── SAMI .smi：<SYNC Start=...><P ...>文本
function parseSami(text) {
  const entries = []
  let idx = 0
  const re = /<sync[^>]*start\s*=\s*(\d+)[^>]*>([\s\S]*?)(?=<sync|<\/body|<\/sami|$)/gi
  let m
  while ((m = re.exec(text)) !== null) {
    const block = m[2]
    const p = block.match(/<p\b[^>]*>([\s\S]*)$/i)
    if (!p) continue
    const bodyStart = m.index + m[0].length - p[0].length + p[0].indexOf('>') + 1
    const bodyEnd = m.index + m[0].length
    let body = text.slice(bodyStart, bodyEnd)
    body = body.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    body = body.replace(/\s+$/, '')
    if (!body.trim()) continue
    entries.push({ index: idx++, startMs: Number(m[1]), endMs: Number(m[1]), text: body, ref: { kind: 'chars', from: bodyStart, to: bodyStart + body.length } })
  }
  return entries
}

const detectSubtitleFormat = (ext, text) => {
  const e = String(ext || '').toLowerCase()
  if (e === 'srt' || e === 'vtt' || e === 'ass' || e === 'ssa' || e === 'lrc' || e === 'sub' || e === 'smi') return e
  const head = String(text || '').slice(0, 400)
  if (/^WEBVTT/i.test(head)) return 'vtt'
  if (/\[Script Info\]/i.test(head) || /\[Events\]/i.test(head)) return /^ScriptType:\s*v4\.00\+/im.test(text) ? 'ass' : 'ssa'
  if (/<SAMI|<SYNC/i.test(head)) return 'smi'
  if (/^\{\d+\}\{\d+\}/m.test(head)) return 'sub'
  if (/^\s*\[\d{1,3}:\d{1,2}/m.test(head)) return 'lrc'
  if (/\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->/.test(head)) return 'srt'
  return e || 'srt'
}

// 解析：返回 { format, entries, meta }
const parseSubtitle = (text, ext, options) => {
  const opts = options || {}
  const fmt = detectSubtitleFormat(ext, text)
  let entries = []
  if (fmt === 'ass' || fmt === 'ssa') entries = parseAss(text)
  else if (fmt === 'lrc') entries = parseLrc(text)
  else if (fmt === 'sub') entries = parseMicroDvd(text, opts.fps)
  else if (fmt === 'smi') entries = parseSami(text)
  else entries = parseCueBlocks(text, fmt)
  return {
    format: fmt,
    entries,
    meta: {
      desc: SUB_DESC[fmt] || fmt,
      fps: fmt === 'sub' ? (Number(opts.fps) > 0 ? Number(opts.fps) : 23.976) : null,
      hasStyles: fmt === 'ass' || fmt === 'ssa',
    },
  }
}

// 回写：patches = [{ ref, target, tokens? }]（只替换指定条目，其余字节不动）
const applySubtitle = (text, patches) => {
  const sorted = patches.slice().sort((a, b) => {
    const sa = a.ref.kind === 'lines' ? (a.lineStarts ? a.lineStarts[a.ref.from] : null) : a.ref.from
    const sb = b.ref.kind === 'lines' ? (b.lineStarts ? b.lineStarts[b.ref.from] : null) : b.ref.from
    return (sb || 0) - (sa || 0)
  })
  let out = String(text)
  for (const p of sorted) {
    const target = p.tokens ? restore(p.target, p.tokens) : p.target
    if (p.ref.kind === 'chars') {
      out = out.slice(0, p.ref.from) + target + out.slice(p.ref.to)
    } else if (p.ref.kind === 'lines') {
      // 行范围替换：保留原行尾（EOL）风格
      const lines = splitLines(out)
      const from = lines[p.ref.from]
      const to = lines[p.ref.to]
      if (!from || !to) continue
      const eol = to.eolEnd > to.end ? (to.end > to.start && out[to.end - 1] === '\r' ? '\r\n' : '\n') : ''
      out = out.slice(0, from.start) + String(target).split('\n').join(eol || '\n') + eol + out.slice(to.eolEnd)
    }
  }
  return out
}

export { SUB_EXTS, SUB_DESC, isSubtitleExt, TAG_OPEN, TAG_CLOSE, TAG_RE, protect, restore, splitLines, parseSubtitle, applySubtitle, detectSubtitleFormat, srtStamp, vttStamp, msOf, assTimeToMs }
