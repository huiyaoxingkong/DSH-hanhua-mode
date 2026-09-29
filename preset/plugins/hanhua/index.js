// ═══════════════════════════════════════════════════════════════════════════
// 汉化引擎 · 静态插件包（「汉化模式」预设用）
//
// ⚠ 本文件由 tools/build-engine.mjs 从 engine/src/ 生成，请勿直接编辑：
//    改功能 → 改 engine/src/ 下的规范源码 → 跑 node tools/build-engine.mjs
//    校验一致性 → node tools/build-engine.mjs --check
//
// 消费 host 的 tools/systemPrompt/fs/web/sandboxPolicy/subprocess 服务；不提供任何服务，无需 isolate realm。
// ═══════════════════════════════════════════════════════════════════════════

export const name = 'hanhua-engine'
export const inject = ['tools', 'systemPrompt', 'fs', 'web', 'sandboxPolicy', 'subprocess']
export const version = '2.0.0'

export function apply(ctx) {
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

  // ═══════════════════════════════════════════════════════════════════════════
  // 电子书文本层（纯函数，无 host 服务依赖，可单独单测）
  //
  // EPUB 是 ZIP 容器：opf 清单 + spine 阅读顺序 + 若干 XHTML 正文文件。
  // 这里只做「文本层」的事：定位 opf、按 spine 排出正文顺序、抽取/回写 XHTML 文本节点。
  // 真正的解包/打包由 media.js 调 mediakit.js（zlib + 中央目录）完成。
  // ═══════════════════════════════════════════════════════════════════════════

  const EBOOK_EXTS = ['epub', 'pdf', 'html', 'htm', 'xhtml', 'xht']
  const isEbookExt = (ext) => EBOOK_EXTS.indexOf(String(ext || '').toLowerCase()) >= 0

  const decodeEntities = (s) => String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&nbsp;/g, '\u00a0')
    .replace(/&amp;/g, '&')

  const escapeHtmlText = (s) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\u00a0/g, '&nbsp;')

  // ── container.xml → opf 路径
  const findContainerOpf = (containerXml) => {
    const m = String(containerXml || '').match(/<rootfile[^>]*full-path\s*=\s*"([^"]+)"/i)
      || String(containerXml || '').match(/<rootfile[^>]*full-path\s*=\s*'([^']+)'/i)
    return m ? m[1] : null
  }

  // ── opf 解析：manifest + spine（只看属性，够用且对命名空间鲁棒）
  const parseOpf = (opfXml) => {
    const xml = String(opfXml || '')
    const manifest = {}
    const items = xml.match(/<item\b[^>]*>/gi) || []
    for (const it of items) {
      const id = (it.match(/\bid\s*=\s*"([^"]*)"/i) || it.match(/\bid\s*=\s*'([^']*)'/i) || [])[1]
      const href = (it.match(/\bhref\s*=\s*"([^"]*)"/i) || it.match(/\bhref\s*=\s*'([^']*)'/i) || [])[1]
      const mediaType = (it.match(/\bmedia-type\s*=\s*"([^"]*)"/i) || it.match(/\bmedia-type\s*=\s*'([^']*)'/i) || [])[1]
      const properties = (it.match(/\bproperties\s*=\s*"([^"]*)"/i) || [])[1] || ''
      if (id && href) manifest[id] = { id, href, mediaType: mediaType || '', properties }
    }
    const spine = []
    const refs = xml.match(/<itemref\b[^>]*>/gi) || []
    for (const r of refs) {
      if (/\blinear\s*=\s*"no"/i.test(r)) continue
      const idref = (r.match(/\bidref\s*=\s*"([^"]*)"/i) || r.match(/\bidref\s*=\s*'([^']*)'/i) || [])[1]
      if (idref && manifest[idref]) spine.push(manifest[idref])
    }
    return { version: (xml.match(/<package[^>]*version\s*=\s*"([^"]*)"/i) || [])[1] || '2.0', manifest, spine }
  }

  // zip 内相对路径归一化（opf 里的 href 相对 opf 所在目录）
  const resolveHref = (opfPath, href) => {
    const stash = String(opfPath || '').split('/').slice(0, -1)
    const parts = String(href || '').split('/')
    for (const p of parts) {
      if (p === '' || p === '.') continue
      if (p === '..') stash.pop()
      else stash.push(p)
    }
    return stash.join('/')
  }

  // ── XHTML 文本节点抽取：返回 { index, text, ref:{from,to}, tag, inHead }
  const HTML_SKIP_TAGS = new Set(['script', 'style', 'svg', 'math'])
  const parseHtmlTextNodes = (html) => {
    const s = String(html || '')
    const nodes = []
    const stack = []
    let i = 0
    let idx = 0
    let textStart = -1
    const flush = (end) => {
      if (textStart < 0) return
      const from = textStart
      const raw = s.slice(from, end)
      textStart = -1
      if (!raw.trim()) return
      // script/style/svg/math 内部的文本不是正文（栈里只要出现过就整段跳过）
      for (const t of stack) if (HTML_SKIP_TAGS.has(t)) return
      const decoded = decodeEntities(raw)
      if (!decoded.trim()) return
      const top = stack.length ? stack[stack.length - 1] : ''
      nodes.push({
        index: idx++,
        text: decoded,
        ref: { kind: 'htmlchars', from, to: end },
        tag: top,
        inHead: stack.indexOf('head') >= 0,
      })
    }
    while (i < s.length) {
      const lt = s.indexOf('<', i)
      if (lt < 0) { if (textStart < 0) textStart = i; break }
      if (textStart < 0) textStart = i
      flush(lt)
      // 注释 / CDATA / 声明
      if (s.startsWith('<!--', lt)) { const e = s.indexOf('-->', lt); i = e < 0 ? s.length : e + 3; continue }
      if (s.startsWith('<![CDATA[', lt)) { const e = s.indexOf(']]>', lt); i = e < 0 ? s.length : e + 3; continue }
      const gt = s.indexOf('>', lt)
      if (gt < 0) break
      const tagText = s.slice(lt + 1, gt)
      const close = tagText.startsWith('/')
      const name = (tagText.replace(/^\//, '').match(/^[A-Za-z0-9:_-]+/) || [''])[0].toLowerCase()
      const selfClose = /\/\s*$/.test(tagText)
      if (close) {
        const at = stack.lastIndexOf(name)
        if (at >= 0) stack.length = at
      } else if (name && !selfClose && !HTML_SKIP_TAGS.has(name)) {
        stack.push(name)
      } else if (name && !selfClose) {
        stack.push(name) // script/style 也入栈，让 flush 时被判为跳过
      }
      i = gt + 1
      textStart = i
    }
    return nodes
  }

  // 回写：按 offset 倒序替换，附带 HTML 转义；只替换给了 target 的节点
  const applyHtmlTextNodes = (html, patches) => {
    let out = String(html || '')
    const sorted = patches.slice().sort((a, b) => b.ref.from - a.ref.from)
    for (const p of sorted) {
      out = out.slice(0, p.ref.from) + escapeHtmlText(p.target) + out.slice(p.ref.to)
    }
    return out
  }

  // 文本节点里的「非正文」过滤：纯符号/纯数字/过短且无字母
  const looksTranslatable = (text) => /[A-Za-z\u00c0-\u024f\u0400-\u04ff\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]/.test(String(text || ''))

  // EPUB 里应当翻译的非正文媒体类型（封面样式等）
  const isContentMediaType = (mt) => /xhtml|html|xml/i.test(String(mt || '')) && !/ncx|opf/i.test(String(mt || ''))

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

  // ═══════════════════════════════════════════════════════════════════════════
  // 汉化引擎 · 规范源码（canonical core）—— 唯一真源
  //
  // tools/build-engine.mjs 把本文件（连同 subtitle.js / ebook.js / scripts/* 资源）
  // 注入两个信封，生成：
  //   · engine/host.js                  动态包（「汉化工作台」host 半）
  //   · preset/plugins/hanhua/index.js  静态插件（预设里的 hanhua_* 工具）
  // 改功能只改 engine/src/ 下的规范源码，然后跑：
  //   node tools/build-engine.mjs          重新生成两个产物
  //   node tools/build-engine.mjs --check  校验产物与源码一致（CI/自检用）
  //
  // 约定：
  //   · 顶层缩进为 0，生成器按信封补缩进（静态 2 空格 / 动态 4 空格）；
  //   · 不使用顶层 await、不使用 import/require（子进程脚本放在 src/scripts/ 里，由生成器内联）；
  //   · 通过 svc() 取 host 服务，两个信封行为一致。
  // ═══════════════════════════════════════════════════════════════════════════

  // ── 服务访问 ────────────────────────────────────────────────────────────────
  // 两个信封取服务的写法不同（动态包只能走 ctx.get；静态插件另有 ctx 上的服务属性），
  // 统一走 svc()：先 ctx.get，再退回 ctx[name]；两条都拿不到时由调用点报错。
  const svc = (name) => {
    try { const v = ctx.get(name); if (v) return v } catch (e) {}
    try { return ctx[name] } catch (e) { return undefined }
  }
  const fs = svc('fs')
  const web = svc('web')
  const sandboxPolicy = svc('sandboxPolicy')
  const subprocessOf = () => {
    const s = svc('subprocess')
    if (!s) throw new Error('subprocess 服务不可用（二进制回写 / 媒体处理需要它）')
    return s
  }
  // 静态插件在 host 平面能由 import.meta.url 推出自己的安装目录（插件自带的 iconv-lite 在里面）；
  // 动态包跑在 vm 里拿不到 import.meta，于是由静态半在首次 legacy 回写时把绝对路径写进 config.iconvPath。
  let pluginDirOverride = ''

  const msg = (e) => (e && e.message) ? String(e.message) : String(e)

  let lastExec = null
  const withExec = (exec, fn) => { lastExec = exec; return fn() }
  const cwdOfExec = () => {
    try {
      const c = lastExec && lastExec.agent && lastExec.agent.session && lastExec.agent.session.header && lastExec.agent.session.header.cwd
      return typeof c === 'string' && c ? c : null
    } catch (e) { return null }
  }

  // 写入策略：优先按本轮工具的 exec 所属会话解析；拿不到就退到「当前发起者」。
  // （旧版静态半只认 lastExec，工作台面板从浏览器发起的写回会拿不到 policy。）
  const resolvePolicy = () => {
    try {
      let session = lastExec && lastExec.agent && lastExec.agent.session
      if (!session) {
        const agents = svc('agents')
        const initiator = agents && agents.currentInitiator ? agents.currentInitiator() : null
        if (initiator && initiator.session) session = initiator.session
      }
      if (session && sandboxPolicy) return sandboxPolicy.resolve({ session })
    } catch (e) {}
    return undefined
  }
  const state = {
    root: '',
    files: [],
    entries: [],
    translated: [],
    summary: { scanned: 0, parsed: 0, translated: 0, exported: 0, qaWarnings: 0, apiUsed: false },
    busy: false,
    lastError: null,
    // v2：token 账本 + OCR 缓存（图文载体）
    usage: {
      apiCalls: 0, apiPromptTokens: 0, apiCompletionTokens: 0,
      visionCalls: 0, visionImages: 0, visionPromptTokens: 0, visionCompletionTokens: 0,
      cacheHits: 0, dedupHits: 0, skipHits: 0,
      localOcrHits: 0, ocrCacheHits: 0, ocrDedup: 0, visionBudgetSkipped: 0, ocrCalls: 0,
    },
    ocrCache: {},
    ocrCacheLoaded: false,
  }

  const META_CONFIG = '.hanhua-config.json'
  const META_GLOSSARY = '.hanhua-glossary.json'
  const META_CACHE = '.hanhua-cache.json'
  const META_PARSED = '.hanhua-parsed.json'
  const META_TRANSLATED = '.hanhua-translated.json'

  const SEED_GLOSSARY = [
    { source: 'Potion', target: '药水' }, { source: 'Hi-Potion', target: '高级药水' },
    { source: 'Ether', target: '以太' }, { source: 'Phoenix Down', target: '不死鸟之尾' },
    { source: 'Sword', target: '剑' }, { source: 'Shield', target: '盾' },
    { source: 'Armor', target: '护甲' }, { source: 'Weapon', target: '武器' },
    { source: 'Item', target: '物品' }, { source: 'Skill', target: '技能' },
    { source: 'Magic', target: '魔法' }, { source: 'Attack', target: '攻击' },
    { source: 'Defense', target: '防御' }, { source: 'HP', target: '生命值' },
    { source: 'MP', target: '魔法值' }, { source: 'EXP', target: '经验值' },
    { source: 'Level', target: '等级' }, { source: 'Gold', target: '金币' },
    { source: 'Save', target: '保存' }, { source: 'Load', target: '读取' },
    { source: 'New Game', target: '新游戏' }, { source: 'Continue', target: '继续游戏' },
    { source: 'Options', target: '设置' }, { source: 'Quit', target: '退出' },
    { source: 'Yes', target: '是' }, { source: 'No', target: '否' },
    { source: 'Chapter', target: '章节' }, { source: 'Quest', target: '任务' },
    { source: 'Monster', target: '怪物' }, { source: 'Boss', target: '首领' },
    { source: 'Victory', target: '胜利' }, { source: 'Defeat', target: '战败' },
    { source: 'Experience', target: '经验' }, { source: 'Inventory', target: '背包' },
    { source: 'Equipment', target: '装备' }, { source: 'Shop', target: '商店' },
    { source: 'Buy', target: '购买' }, { source: 'Sell', target: '出售' },
    { source: 'Menu', target: '菜单' }, { source: 'Status', target: '状态' },
    { source: 'Party', target: '队伍' }, { source: 'Dungeon', target: '地牢' },
    { source: 'Village', target: '村庄' }, { source: 'Town', target: '城镇' },
    { source: 'Castle', target: '城堡' }, { source: 'Forest', target: '森林' },
    { source: 'Mountain', target: '山脉' }, { source: 'River', target: '河流' },
    { source: 'Cave', target: '洞穴' }, { source: 'Tower', target: '高塔' },
    { source: 'Ruins', target: '遗迹' }, { source: 'Treasure', target: '宝箱' },
    { source: 'Key', target: '钥匙' }, { source: 'Door', target: '门' },
    { source: 'Chest', target: '宝箱' }, { source: 'Game Over', target: '游戏结束' },
    { source: 'Battle', target: '战斗' }, { source: 'Run', target: '逃跑' },
    { source: 'Fire', target: '火焰' }, { source: 'Ice', target: '冰霜' },
    { source: 'Thunder', target: '雷电' }, { source: 'Heal', target: '治疗' },
    { source: 'Poison', target: '中毒' }, { source: 'Cure', target: '解毒' },
  ]
  const SEED_CONFIG = {
    root: '',
    apiUrl: 'https://api.openai.com/v1/chat/completions',
    apiKey: '',
    model: 'deepseek-chat',
    targetLang: '简体中文',
    sourceLang: 'auto',
    rgssEncoding: 'auto',
    krkrEncoding: 'auto',
    subtitleEncoding: 'auto',
    apiChunk: 40,
    iconvPath: '',
    // ── v2：图文载体与 OCR ──
    visionModel: 'glm-4v-flash',
    visionMaxTokens: 1024,
    ocrEngine: 'auto',
    ocrLang: 'auto',
    ocrBudget: 8,
    ocrMaxImages: 40,
    ocrLayout: 'auto',
    ocrMinArea: 24,
    ocrMaxRegions: 60,
    typesetFont: '',
    pythonPath: '',
    powershellPath: '',
    ffmpegPath: '',
    ffprobePath: '',
  }

  let config = Object.assign({}, SEED_CONFIG)
  let glossary = SEED_GLOSSARY.slice()
  let cache = {}
  let metaLoaded = false

  const joinPath = (a, b) => String(a).replace(/[\\/]+$/, '') + '/' + String(b).replace(/^[\\/]+/, '')
  const extOf = (p) => { const m = /\.([A-Za-z0-9]+)$/.exec(String(p)); return m ? m[1].toLowerCase() : '' }
  const basenameOf = (p) => { const m = String(p).split(/[\\/]/).filter(Boolean); return m.length ? m[m.length - 1] : String(p) }
  const isAbs = (p) => /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('\\\\')
  const relPath = (root, p) => {
    const r = String(root).replace(/[\\/]+$/, '')
    let s = String(p)
    if (s.toLowerCase().startsWith(r.toLowerCase())) s = s.slice(r.length)
    return s.replace(/^[\\/]+/, '')
  }

  const resolveRoot = async () => {
    const t = await fs.resolve('.')
    return String((t && t.displayPath) || fs.processPath(t))
  }
  const needFs = () => { if (!fs) throw new Error('fs 服务不可用') }
  async function readText(p) { needFs(); const t = await fs.resolve(p); return fs.readText(t) }
  async function readTextOr(p, fallback) { try { return await readText(p) } catch (e) { return fallback } }
  async function writeText(p, content) {
    const t = await fs.resolve(p)
    const out = await fs.writeText(t, content, undefined, undefined, resolvePolicy())
    if (out && out.ok === false) throw new Error('写入被拒绝: ' + (out.status || out.error || p))
    return out
  }
  async function listChildren(dirPath) {
    needFs()
    const t = await fs.resolve(dirPath)
    const items = await fs.listDir(t)
    const out = []
    for (const e of items) {
      const name = e.name ?? String((e.target && e.target.displayPath) || '').split(/[\\/]/).pop()
      if (!name) continue
      let isDir = e.type === 'directory'
      const childPath = joinPath(dirPath, name)
      if (!isDir && e.type === undefined) {
        try {
          const ct = e.target ?? await fs.resolve(childPath)
          const info = await fs.stat(ct)
          isDir = !!(info && info.type === 'directory')
        } catch (err) { isDir = false }
      }
      out.push({ name, path: childPath, isDir: !!isDir })
    }
    return out
  }
  async function pickRoot(rootArg) {
    let root = rootArg
    if (root && !isAbs(root)) root = joinPath(state.root, root)
    else if (!root) root = state.root
    if (!root) throw new Error('未配置项目根目录：请先用 hanhua_config 设置 root')
    try { await listChildren(root) } catch (e) { throw new Error('目录不可用: ' + root + ' (' + msg(e) + ')') }
    return root
  }

  // ---------- 字节级读写与编码 ----------
  const MARSHAL_MAX = 40 * 1024 * 1024
  const KRKR_MAX = 16 * 1024 * 1024
  async function readBytesMax(p, maxBytes) { needFs(); const t = await fs.resolve(p); return fs.readBytes(t, undefined, maxBytes) }
  const strToBytes = (s) => { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xFF; return b }
  const latin1Of = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return s }
  const B64CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const bytesToB64 = (bytes) => {
    let s = ''
    for (let i = 0; i < bytes.length; i += 3) {
      const b0 = bytes[i]
      const b1 = i + 1 < bytes.length ? bytes[i + 1] : undefined
      const b2 = i + 2 < bytes.length ? bytes[i + 2] : undefined
      s += B64CHARS[b0 >> 2]
      s += B64CHARS[((b0 & 3) << 4) | (b1 === undefined ? 0 : b1 >> 4)]
      s += b1 === undefined ? '=' : B64CHARS[((b1 & 15) << 2) | (b2 === undefined ? 0 : b2 >> 6)]
      s += b2 === undefined ? '=' : B64CHARS[b2 & 63]
    }
    return s
  }
  const utf8B64 = (text) => bytesToB64(new TextEncoder().encode(text))
  // 子进程工作目录：DSH 0.1.6-alpha.2 起 subprocess.spawn 会强制校验 `cwd`
  // （旧版 0.1.1-rc.2 的实现容忍缺省，缺省即抛
  //  "Cannot read properties of undefined (reading 'includes')"）。
  // SubprocessSpawnSpec.cwd 在两版都是必填字符串，这里统一传项目根目录。
  const spawnCwd = () => {
    const r = (typeof state.root === 'string' && state.root) ? state.root : ''
    return r || '.'
  }
  // iconv-lite 的解析位置取决于子进程的 cwd 与 NODE_PATH：`node -e` 从 cwd
  // 逐级向上找 node_modules，而我们的子进程 cwd 是项目根（游戏目录），通常没有
  // node_modules，于是单点 require('iconv-lite') 会以 code=3 静默失败，
  // GBK/Shift-JIS 回写整条链路失效。这里按
  // 「显式配置 → 插件自带 node_modules → 部署内已知位置 → 全局」给出候选清单，
  // 子进程逐个尝试；同时把候选的 node_modules 目录塞进 NODE_PATH。
  //
  const ICONV_CANDIDATES = () => {
    const specs = []
    if (config.iconvPath) specs.push(config.iconvPath)
    if (pluginDirOverride) specs.push(pluginDirOverride + '/node_modules/iconv-lite')
    const home = (typeof process !== 'undefined' && process.env && process.env.DSH_HOME)
      ? String(process.env.DSH_HOME).replace(/[\\/]+$/, '')
      : ''
    const profile = (typeof process !== 'undefined' && process.env && process.env.DSH_PROFILE) ? String(process.env.DSH_PROFILE) : ''
    if (home) {
      // 桌面版把内核打进 app.asar，但 profile 的 node_modules 仍是真实目录（iconv-lite 常在里面）
      if (profile) specs.push(home + '/profiles/' + profile + '/node_modules/iconv-lite')
      specs.push(home + '/profiles/node_modules/iconv-lite')
      specs.push(home + '/profiles/web/node_modules/iconv-lite')
    }
    specs.push('iconv-lite')
    return specs
  }
  const iconvEnv = () => {
    const dirs = []
    if (pluginDirOverride) dirs.push(pluginDirOverride + '/node_modules')
    const home = (typeof process !== 'undefined' && process.env && process.env.DSH_HOME)
      ? String(process.env.DSH_HOME).replace(/[\\/]+$/, '')
      : ''
    const profile = (typeof process !== 'undefined' && process.env && process.env.DSH_PROFILE) ? String(process.env.DSH_PROFILE) : ''
    if (home) {
      if (profile) dirs.push(home + '/profiles/' + profile + '/node_modules')
      dirs.push(home + '/profiles/node_modules')
      dirs.push(home + '/profiles/web/node_modules')
    }
    const prior = (typeof process !== 'undefined' && process.env && process.env.NODE_PATH) ? String(process.env.NODE_PATH) : ''
    if (prior) dirs.push(prior)
    return dirs.length ? { NODE_PATH: dirs.join(';') } : undefined
  }
  // 首次需要 legacy 编码时，把插件自带的 iconv 绝对路径写进 config：
  // 动态半（engine/host.js，运行在 vm 里、拿不到 import.meta）与后续会话都因此受益。
  const ensureIconvPath = async () => {
    if (config.iconvPath || !pluginDirOverride) return
    const candidate = pluginDirOverride + '/node_modules/iconv-lite'
    try {
      const t = await fs.resolve(candidate)
      if ((await fs.stat(t)) === undefined) return
      config.iconvPath = candidate
      try { await persistConfig() } catch (e) {}
    } catch (e) {}
  }
  async function nodeSpawn(script, args, env) {
    const node = await subprocessOf().resolveExecutable('node').catch(() => 'node')
    const spec = { argv: [node, '-e', script].concat(args), cwd: spawnCwd(), stdio: { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' }, graceMs: 60000 }
    if (env) spec.env = env
    const handle = subprocessOf().spawn(spec)
    const done = await handle.done
    if ((done.exitCode ?? 0) !== 0) throw new Error('node 子进程失败 code=' + done.exitCode)
  }
  const ARGV_SAFE_CHARS = 16000
  // 把 base64 载荷交给子进程：小载荷直接进 argv，大载荷先落盘再传路径。
  // （Windows 命令行上限 32767 字符：漫画页/EPUB 的 base64 轻松超过，旧实现会静默失败。）
  async function base64PayloadArg(b64, tag) {
    if (b64.length < ARGV_SAFE_CHARS) return { inline: b64, path: null }
    await ensureTmpDir()
    helperSeq += 1
    const p = joinPath(tmpDirPath(), tag + '-' + helperSeq + '.b64')
    await writeText(p, b64)
    return { inline: null, path: fs.processPath(await fs.resolve(p)) }
  }
  async function writeBytes(p, bytes) {
    needFs()
    const t = await fs.resolve(p)
    const outPath = fs.processPath(t)
    const payload = await base64PayloadArg(bytesToB64(bytes), 'write')
    if (payload.path) {
      const script = 'const fs=require("fs");const pt=require("path");try{fs.mkdirSync(pt.dirname(process.argv[1]),{recursive:true});fs.writeFileSync(process.argv[1],Buffer.from(fs.readFileSync(process.argv[2],"utf8"),"base64"));}catch(e){process.exitCode=2;}'
      await nodeSpawn(script, [outPath, payload.path])
      return
    }
    const script = 'const fs=require("fs");const pt=require("path");try{fs.mkdirSync(pt.dirname(process.argv[1]),{recursive:true});fs.writeFileSync(process.argv[1],Buffer.from(process.argv[2],"base64"));}catch(e){process.exitCode=2;}'
    await nodeSpawn(script, [outPath, payload.inline])
  }
  // 子进程内按候选清单装载 iconv；全部失败才以 code=3 退出。
  // `node -e script a b c` 下 process.argv = [node, a, b, c]，候选清单的下标由调用方给出。
  const iconvLoad = (argIndex) => 'let i=null;for(const s of JSON.parse(process.argv[' + argIndex + '])){try{i=require(s);break}catch(e){}}if(!i){process.exitCode=3;}'
  async function writeTextLegacy(p, text, encoding) {
    await ensureIconvPath()
    const t = await fs.resolve(p)
    const outPath = fs.processPath(t)
    const payload = await base64PayloadArg(utf8B64(text), 'legacy')
    // 大文本同样不能进 argv：让子进程自己读 base64 文件
    const inner = payload.path
      ? 'fs.readFileSync(process.argv[2],"utf8")'
      : 'process.argv[2]'
    const script = 'const fs=require("fs");const pt=require("path");' + iconvLoad(4)
      + 'else{try{fs.mkdirSync(pt.dirname(process.argv[1]),{recursive:true});fs.writeFileSync(process.argv[1],i.encode(Buffer.from(' + inner + ',"base64").toString("utf8"),process.argv[3]));}catch(e){process.exitCode=2;}}'
    await nodeSpawn(script, [outPath, payload.path || payload.inline, encoding, JSON.stringify(ICONV_CANDIDATES())], iconvEnv())
  }
  async function iconvBatch(items) {
    await ensureIconvPath()
    const node = await subprocessOf().resolveExecutable('node').catch(() => 'node')
    const tmpIn = joinPath(state.root, '.hanhua-iconv.in.json')
    const tmpOut = joinPath(state.root, '.hanhua-iconv.bin')
    const inTarget = await fs.resolve(tmpIn)
    const outTarget = await fs.resolve(tmpOut)
    await writeText(tmpIn, JSON.stringify(items.map((x) => ({ t: x.text, e: x.enc }))))
    const script = 'const fs=require("fs");' + iconvLoad(3)
      + 'else{const items=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const frames=[];for(const it of items){const b=i.encode(it.t,it.e);const h=Buffer.alloc(4);h.writeUInt32LE(b.length);frames.push(h,b);}fs.writeFileSync(process.argv[2],Buffer.concat(frames));}'
    const spec = { argv: [node, '-e', script, fs.processPath(inTarget), fs.processPath(outTarget), JSON.stringify(ICONV_CANDIDATES())], cwd: spawnCwd(), stdio: { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' }, graceMs: 60000 }
    const env = iconvEnv()
    if (env) spec.env = env
    const handle = subprocessOf().spawn(spec)
    const done = await handle.done
    if ((done.exitCode ?? 0) !== 0) throw new Error('iconv 批量编码失败 code=' + done.exitCode)
    const bin = await readBytesMax(tmpOut, 64 * 1024 * 1024)
    const out = []
    let p = 0
    for (let k = 0; k < items.length; k++) {
      const len = (bin[p] | (bin[p + 1] << 8) | (bin[p + 2] << 16) | (bin[p + 3] << 24)) >>> 0
      p += 4
      out.push(latin1Of(bin.subarray(p, p + len)))
      p += len
    }
    return out
  }
  function decodeBytes(arr, hintEncoding) {
    if (arr.length >= 2 && arr[0] === 0xFF && arr[1] === 0xFE) return { text: new TextDecoder('utf-16le').decode(arr.subarray(2)), encoding: 'utf-16le', bom: true }
    if (arr.length >= 2 && arr[0] === 0xFE && arr[1] === 0xFF) return { text: new TextDecoder('utf-16be').decode(arr.subarray(2)), encoding: 'utf-16be', bom: true }
    try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(arr), encoding: 'utf-8', bom: false } } catch (e) {}
    const tries = []
    if (hintEncoding && hintEncoding !== 'auto') tries.push(hintEncoding)
    tries.push('shift_jis', 'gbk', 'latin1')
    for (const enc of tries) {
      try { return { text: new TextDecoder(enc).decode(arr), encoding: enc, bom: false } } catch (e) {}
    }
    return { text: new TextDecoder('latin1').decode(arr), encoding: 'latin1', bom: false }
  }
  function encodeText(text, encoding, bom) {
    if (encoding === 'utf-8') return new TextEncoder().encode(text)
    if (encoding === 'utf-16le' || encoding === 'utf-16be') {
      const out = new Uint8Array(text.length * 2 + (bom ? 2 : 0))
      let o = 0
      if (bom) { out[0] = 0xFF; out[1] = 0xFE; o = 2 }
      for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i)
        if (encoding === 'utf-16le') { out[o++] = c & 0xFF; out[o++] = (c >> 8) & 0xFF }
        else { out[o++] = (c >> 8) & 0xFF; out[o++] = c & 0xFF }
      }
      return out
    }
    throw new Error('需要 iconv 编码: ' + encoding)
  }

  // ---------- Ruby Marshal 读取器 ----------
  function marshalRead(bytes) {
    let pos = 0
    if (bytes.length >= 2 && bytes[0] === 0x04 && bytes[1] === 0x08) pos = 2
    const nodes = []
    const readByte = () => { if (pos >= bytes.length) throw new Error('Marshal 数据不完整 @' + pos); return bytes[pos++] }
    const readLong = () => {
      let c = readByte()
      if (c >= 128) c -= 256
      if (c === 0) return 0
      if (c > 0) {
        if (c < 5) { let v = 0; for (let k = 0; k < c; k++) v += readByte() << (8 * k); return v }
        return c - 5
      }
      if (c > -5) { let v = 0; for (let k = 0; k < -c; k++) v += readByte() << (8 * k); return -v }
      return c + 5
    }
    const readRaw = (n) => { if (n < 0 || pos + n > bytes.length) throw new Error('Marshal 数据不完整'); const out = bytes.subarray(pos, pos + n); pos += n; return out }
    const readName = () => {
      const n = readLong()
      return latin1Of(readRaw(n))
    }
    const readSym = () => {
      const n = readNode()
      if (n && n.t === ':') return n.v
      throw new Error('期望 symbol @' + pos)
    }
    function readNode() {
      const ch = String.fromCharCode(readByte())
      if (ch === '0') return { t: 'nil' }
      if (ch === 'T') return { t: 'true' }
      if (ch === 'F') return { t: 'false' }
      if (ch === 'i') return { t: 'i', v: readLong() }
      if (ch === ':') return { t: ':', v: readName() }
      if (ch === ';') { const idx = readLong(); return nodes[idx] }
      if (ch === 'l') {
        const sign = readByte() === 0x2B ? 1 : -1
        const words = readLong() * 2
        return { t: 'l', sign, d: readRaw(words) }
      }
      if (ch === '"') {
        const n = readLong()
        const node = { t: 's', v: latin1Of(readRaw(n)) }
        nodes.push(node)
        return node
      }
      if (ch === 'f') {
        let s = ''
        for (;;) {
          const c = bytes[pos]
          if (c === undefined) break
          const cc = String.fromCharCode(c)
          if (!/[0-9+\-eE.]/.test(cc)) break
          s += cc; pos++
        }
        return { t: 'f', v: parseFloat(s) }
      }
      if (ch === '[') {
        const n = readLong()
        const node = { t: 'a', v: [] }
        nodes.push(node)
        for (let i = 0; i < n; i++) node.v.push(readNode())
        return node
      }
      if (ch === '{') {
        const n = readLong()
        const node = { t: 'h', v: [], def: undefined }
        nodes.push(node)
        const count = Math.abs(n)
        for (let i = 0; i < count; i++) { const k = readNode(); const v = readNode(); node.v.push([k, v]) }
        if (n < 0) node.def = readNode()
        return node
      }
      if (ch === 'o') {
        const cname = readSym()
        const n = readLong()
        const node = { t: 'o', c: cname, iv: {} }
        nodes.push(node)
        for (let i = 0; i < n; i++) { const k = readSym(); const v = readNode(); node.iv[k] = v }
        return node
      }
      if (ch === 'u') {
        const cname = readSym()
        const n = readLong()
        const node = { t: 'u', c: cname, d: readRaw(n) }
        nodes.push(node)
        return node
      }
      if (ch === 'U') {
        const cname = readSym()
        const node = { t: 'U', c: cname, v: readNode() }
        nodes.push(node)
        return node
      }
      if (ch === 'e') {
        const cname = readSym()
        const node = { t: 'x', c: cname, v: readNode() }
        nodes.push(node)
        return node
      }
      if (ch === 'I') {
        const inner = readNode()
        const n = readLong()
        const iv = {}
        for (let i = 0; i < n; i++) { const k = readSym(); const v = readNode(); iv[k] = v }
        if (inner.t === 's') { inner.t = 'sI'; inner.iv = iv; return inner }
        return { t: 'I', v: inner, iv }
      }
      if (ch === '@') { const idx = readLong(); return nodes[idx] }
      if (ch === 'S') {
        const cname = readSym()
        const n = readLong()
        const node = { t: 'S', c: cname, iv: {} }
        nodes.push(node)
        for (let i = 0; i < n; i++) { const k = readSym(); const v = readNode(); node.iv[k] = v }
        return node
      }
      if (ch === 'c' || ch === 'm') return { t: ch, v: readName() }
      throw new Error('不支持的 Marshal 类型: 0x' + bytes[pos - 1].toString(16))
    }
    return readNode()
  }

  // ---------- Ruby Marshal 写入器 ----------
  function marshalWrite(root) {
    const seen = new Map()
    let order = 0
    const out = [0x04, 0x08]
    const pushByte = (b) => out.push(b & 0xFF)
    const pushRaw = (bytes) => { for (let i = 0; i < bytes.length; i++) out.push(bytes[i] & 0xFF) }
    const writeLong = (v) => {
      if (v === 0) { pushByte(0); return }
      if (v > 0 && v < 123) { pushByte(v + 5); return }
      if (v < 0 && v > -124) { pushByte(v - 5); return }
      if (v >= 0 && v < 0x40000000) { pushByte(4); for (let k = 0; k < 4; k++) pushByte((v >>> (8 * k)) & 0xFF); return }
      if (v < 0 && v >= -0x40000000) { pushByte(0xFC); const w = v & 0xFFFFFFFF; for (let k = 0; k < 4; k++) pushByte((w >>> (8 * k)) & 0xFF); return }
      throw new Error('超大整数不支持: ' + v)
    }
    const writeSymbol = (s) => { const b = strToBytes(s); writeLong(b.length); pushRaw(b) }
    const writeIvars = (iv) => {
      const keys = Object.keys(iv)
      writeLong(keys.length)
      for (const k of keys) { pushByte(0x3A); writeSymbol(k); writeNode(iv[k]) }
    }
    function writeNode(node) {
      if (node === null || node === undefined) { pushByte(0x30); return }
      const t = node.t
      if (t === 'nil') { pushByte(0x30); return }
      if (t === 'true') { pushByte(0x54); return }
      if (t === 'false') { pushByte(0x46); return }
      if (t === 'i') { pushByte(0x69); writeLong(node.v); return }
      if (t === 'l') { pushByte(0x6C); pushByte(node.sign > 0 ? 0x2B : 0x2D); writeLong(node.d.length / 2); pushRaw(node.d); return }
      if (t === ':') { pushByte(0x3A); writeSymbol(node.v); return }
      if (t === 'f') { pushByte(0x66); pushRaw(strToBytes(String(node.v))); return }
      if (t === 's' || t === 'sI') {
        if (seen.has(node)) { pushByte(0x40); writeLong(seen.get(node)); return }
        seen.set(node, order++)
        if (t === 'sI') {
          pushByte(0x49); pushByte(0x22)
          const b = strToBytes(node.v); writeLong(b.length); pushRaw(b)
          writeIvars(node.iv)
        } else {
          pushByte(0x22)
          const b = strToBytes(node.v); writeLong(b.length); pushRaw(b)
        }
        return
      }
      if (t === 'a') {
        if (seen.has(node)) { pushByte(0x40); writeLong(seen.get(node)); return }
        seen.set(node, order++)
        pushByte(0x5B); writeLong(node.v.length)
        for (const item of node.v) writeNode(item)
        return
      }
      if (t === 'h') {
        if (seen.has(node)) { pushByte(0x40); writeLong(seen.get(node)); return }
        seen.set(node, order++)
        pushByte(0x7B)
        writeLong(node.def !== undefined ? -node.v.length : node.v.length)
        for (const pair of node.v) { writeNode(pair[0]); writeNode(pair[1]) }
        if (node.def !== undefined) writeNode(node.def)
        return
      }
      if (t === 'o') {
        if (seen.has(node)) { pushByte(0x40); writeLong(seen.get(node)); return }
        seen.set(node, order++)
        pushByte(0x6F)
        pushByte(0x3A); writeSymbol(node.c)
        writeIvars(node.iv)
        return
      }
      if (t === 'u') {
        if (seen.has(node)) { pushByte(0x40); writeLong(seen.get(node)); return }
        seen.set(node, order++)
        pushByte(0x75); pushByte(0x3A); writeSymbol(node.c)
        writeLong(node.d.length); pushRaw(node.d)
        return
      }
      if (t === 'U') {
        if (seen.has(node)) { pushByte(0x40); writeLong(seen.get(node)); return }
        seen.set(node, order++)
        pushByte(0x55); pushByte(0x3A); writeSymbol(node.c); writeNode(node.v)
        return
      }
      if (t === 'x') { pushByte(0x65); pushByte(0x3A); writeSymbol(node.c); writeNode(node.v); return }
      if (t === 'I') { pushByte(0x49); writeNode(node.v); writeIvars(node.iv); return }
      if (t === 'S') {
        if (seen.has(node)) { pushByte(0x40); writeLong(seen.get(node)); return }
        seen.set(node, order++)
        pushByte(0x53); pushByte(0x3A); writeSymbol(node.c)
        writeIvars(node.iv)
        return
      }
      if (t === 'c' || t === 'm') { pushByte(t === 'c' ? 0x63 : 0x6D); const b = strToBytes(node.v); writeLong(b.length); pushRaw(b); return }
      throw new Error('无法写回 Marshal 节点类型: ' + t)
    }
    writeNode(root)
    return new Uint8Array(out)
  }

  // ---------- RGSS 提取与回写 ----------
  const DB_FIELDS_RGSS = {
    'RPG::Actor': ['name', 'nickname', 'description', 'profile'],
    'RPG::Class': ['name'],
    'RPG::Skill': ['name', 'description', 'message1', 'message2'],
    'RPG::Item': ['name', 'description'],
    'RPG::Weapon': ['name', 'description'],
    'RPG::Armor': ['name', 'description'],
    'RPG::Enemy': ['name'],
    'RPG::State': ['name', 'description', 'message1', 'message2', 'message3', 'message4'],
    'RPG::Troop': ['name'],
  }
  const keyScalar = (k) => {
    if (!k) return undefined
    if (k.t === 'i' || k.t === ':') return k.v
    if (k.t === 's' || k.t === 'sI') return k.v
    return undefined
  }
  const nodeAt = (root, ops) => {
    let cur = root
    for (const op of ops) {
      if (cur === undefined || cur === null) return undefined
      const kind = op[0]
      if (kind === 'iv') { if (cur.t === 'o' || cur.t === 'S' || cur.t === 'I') cur = cur.iv[op[1]]; else return undefined }
      else if (kind === 'idx') { if (cur.t === 'a') cur = cur.v[op[1]]; else return undefined }
      else if (kind === 'key') {
        if (cur.t === 'h') {
          let hit
          for (const pair of cur.v) { if (keyScalar(pair[0]) === op[1]) { hit = pair[1]; break } }
          cur = hit
        } else return undefined
      } else return undefined
    }
    return cur
  }
  function rgssText(node, hintEnc) {
    const d = decodeBytes(strToBytes(node.v), hintEnc)
    return d.text
  }
  function extractCommandList(lst, file, list, hintEnc, baseOps, idPrefix) {
    let n = 0
    lst.v.forEach((cmd, li) => {
      if (!cmd || cmd.t !== 'o') return
      const codeNode = cmd.iv['@code']
      const code = codeNode && codeNode.t === 'i' ? codeNode.v : null
      const params = cmd.iv['@parameters']
      if (!params || params.t !== 'a') return
      const ops = baseOps.concat([['idx', li], ['iv', '@parameters']])
      if (code === 101 || code === 102) {
        const arr = params.v[0]
        if (arr && arr.t === 'a') {
          arr.v.forEach((line, i) => {
            if (line && (line.t === 's' || line.t === 'sI')) {
              n++
              pushEntry(list, file, 'rgss', 'rgss-map', rgssText(line, hintEnc), ops.concat([['idx', 0], ['idx', i]]), { loc: idPrefix + '.l' + li + (code === 101 ? '#' + i : '.c' + i) }, idPrefix + '.' + li + '.' + i)
            }
          })
        }
      } else if (code === 401) {
        const v = params.v[0]
        if (v && (v.t === 's' || v.t === 'sI')) { n++; pushEntry(list, file, 'rgss', 'rgss-map', rgssText(v, hintEnc), ops.concat([['idx', 0]]), { loc: idPrefix + '.l' + li + '.m' }, idPrefix + '.' + li + '.m') }
      } else if (code === 402) {
        const v = params.v[1]
        if (v && (v.t === 's' || v.t === 'sI')) { n++; pushEntry(list, file, 'rgss', 'rgss-map', rgssText(v, hintEnc), ops.concat([['idx', 1]]), { loc: idPrefix + '.l' + li + '.w' }, idPrefix + '.' + li + '.w') }
      } else if (code === 408) {
        const v = params.v[0]
        if (v && (v.t === 's' || v.t === 'sI')) { n++; pushEntry(list, file, 'rgss', 'rgss-map', rgssText(v, hintEnc), ops.concat([['idx', 0]]), { loc: idPrefix + '.l' + li + '.x' }, idPrefix + '.' + li + '.x') }
      }
    })
    return n
  }
  function extractRgss(tree, file, list, hintEnc) {
    const name = basenameOf(file.rel)
    const root = tree
    let n = 0
    if (/^Map\d{3}\./i.test(name)) {
      const evHash = root.t === 'o' ? root.iv['@events'] : undefined
      if (evHash && evHash.t === 'h') {
        for (const pair of evHash.v) {
          const kkey = keyScalar(pair[0])
          const ev = pair[1]
          if (kkey === undefined || !ev || ev.t !== 'o') continue
          const nm = ev.iv['@name']
          if (nm && (nm.t === 's' || nm.t === 'sI')) { n++; pushEntry(list, file, 'rgss', 'rgss-map', rgssText(nm, hintEnc), [['iv', '@events'], ['key', kkey], ['iv', '@name']], { loc: 'Event#' + kkey + '.name' }, 'ev' + kkey + '.name') }
          const pages = ev.iv['@pages']
          if (pages && pages.t === 'a') {
            pages.v.forEach((pg, pi) => {
              const lst = pg && pg.t === 'o' ? pg.iv['@list'] : undefined
              if (lst && lst.t === 'a') n += extractCommandList(lst, file, list, hintEnc, [['iv', '@events'], ['key', kkey], ['iv', '@pages'], ['idx', pi], ['iv', '@list']], 'ev' + kkey + '.p' + pi)
            })
          }
        }
      }
      return n
    }
    if (/^System\./i.test(name)) {
      if (root.t === 'o') {
        for (const f of ['@game_title', '@currency_unit']) {
          const v = root.iv[f]
          if (v && (v.t === 's' || v.t === 'sI')) { n++; pushEntry(list, file, 'rgss', 'rgss-system', rgssText(v, hintEnc), [['iv', f]], { loc: f }, f) }
        }
        const terms = root.iv['@terms']
        if (terms && terms.t === 'o') {
          for (const arrName of ['@basic', '@params', '@commands']) {
            const arr = terms.iv[arrName]
            if (arr && arr.t === 'a') {
              arr.v.forEach((v, i) => {
                if (v && (v.t === 's' || v.t === 'sI')) { n++; pushEntry(list, file, 'rgss', 'rgss-system', rgssText(v, hintEnc), [['iv', '@terms'], ['iv', arrName], ['idx', i]], { loc: 'terms.' + arrName + '[' + i + ']' }, 'terms.' + arrName + '.' + i) }
              })
            }
          }
          const msgs = terms.iv['@messages']
          if (msgs && msgs.t === 'h') {
            for (const pair of msgs.v) {
              const ks = keyScalar(pair[0])
              if (ks === undefined) continue
              const words = pair[1]
              const nm = words && words.t === 'o' ? words.iv['@name'] : undefined
              if (nm && (nm.t === 's' || nm.t === 'sI')) { n++; pushEntry(list, file, 'rgss', 'rgss-system', rgssText(nm, hintEnc), [['iv', '@terms'], ['iv', '@messages'], ['key', ks], ['iv', '@name']], { loc: 'terms.messages.' + ks }, 'terms.messages.' + ks) }
            }
          }
        }
      }
      return n
    }
    if (/^CommonEvents\./i.test(name)) {
      if (root.t === 'a') {
        root.v.forEach((ce, i) => {
          if (!ce || ce.t !== 'o') return
          const nm = ce.iv['@name']
          if (nm && (nm.t === 's' || nm.t === 'sI')) { n++; pushEntry(list, file, 'rgss', 'rgss-db', rgssText(nm, hintEnc), [['idx', i], ['iv', '@name']], { loc: 'CE[' + i + '].name' }, 'ce' + i + '.name') }
          const lst = ce.iv['@list']
          if (lst && lst.t === 'a') n += extractCommandList(lst, file, list, hintEnc, [['idx', i], ['iv', '@list']], 'ce' + i)
        })
      }
      return n
    }
    if (root.t === 'a') {
      root.v.forEach((rec, i) => {
        if (!rec || rec.t !== 'o') return
        const flds = DB_FIELDS_RGSS[rec.c] || ['name']
        for (const f of flds) {
          const val = rec.iv['@' + f]
          if (!val) continue
          if (val.t === 's' || val.t === 'sI') { n++; pushEntry(list, file, 'rgss', 'rgss-db', rgssText(val, hintEnc), [['idx', i], ['iv', '@' + f]], { loc: rec.c + '[' + i + '].' + f }, rec.c + '.' + i + '.' + f) }
          else if (val.t === 'a') {
            val.v.forEach((sv, j) => {
              if (sv && (sv.t === 's' || sv.t === 'sI')) { n++; pushEntry(list, file, 'rgss', 'rgss-db', rgssText(sv, hintEnc), [['idx', i], ['iv', '@' + f], ['idx', j]], { loc: rec.c + '[' + i + '].' + f + '[' + j + ']' }, rec.c + '.' + i + '.' + f + '.' + j) }
            })
          }
        }
      })
      return n
    }
    return 0
  }

  // ---------- krkr 提取 ----------
  const KRKR_TEXT_ATTRS = new Set(['text', 'name', 'title', 'label', 'hint', 'message', 'caption'])
  function parseKrkrKs(text, file, list) {
    let n = 0
    const lines = text.split(/\r?\n/)
    lines.forEach((line, i) => {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('*') || trimmed.startsWith('@') || trimmed.startsWith('#') || trimmed.startsWith('//')) return
      if (trimmed.startsWith('[')) {
        const re = /([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(["'])(.*?)\2/g
        let mm
        while ((mm = re.exec(line))) {
          if (!KRKR_TEXT_ATTRS.has(mm[1].toLowerCase())) continue
          const value = mm[3]
          if (!value.trim()) continue
          const qIdx = mm.index + mm[0].indexOf(mm[2])
          n++
          pushEntry(list, file, 'krkr-ks', 'krkr', value, { line: i, start: qIdx, end: qIdx + 1 + value.length, quote: mm[2], kind: 'attr' }, { loc: 'line' + (i + 1) + '.' + mm[1] }, 'line' + (i + 1) + '.' + mm[1])
        }
        return
      }
      const idx = line.indexOf(trimmed)
      n++
      pushEntry(list, file, 'krkr-ks', 'krkr', trimmed, { line: i, start: idx, end: idx + trimmed.length, quote: '', kind: 'line' }, { loc: 'line' + (i + 1) }, 'line' + (i + 1))
    })
    return n
  }
  function parseKrkrTjs(text, file, list) {
    let n = 0
    const lines = text.split(/\r?\n/)
    lines.forEach((line, i) => {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) return
      const m = /^(["'])(.*?)\1/.exec(trimmed)
      if (!m) return
      const value = m[2]
      if (!value.trim()) return
      const idx = line.indexOf(trimmed)
      const start = idx + trimmed.indexOf(m[1])
      const end = start + 1 + value.length
      n++
      pushEntry(list, file, 'krkr-tjs', 'krkr', value, { line: i, start, end, quote: m[1] }, { loc: 'line' + (i + 1) }, 'line' + (i + 1))
    })
    return n
  }

  async function persistConfig() { try { await writeText(joinPath(state.root, META_CONFIG), JSON.stringify(config, null, 2)) } catch (e) {} }
  async function persistGlossary() { try { await writeText(joinPath(state.root, META_GLOSSARY), JSON.stringify(glossary, null, 2)) } catch (e) {} }
  async function persistCache() { try { await writeText(joinPath(state.root, META_CACHE), JSON.stringify(cache, null, 2)) } catch (e) {} }
  async function persistParsed() { try { await writeText(joinPath(state.root, META_PARSED), JSON.stringify({ savedAt: new Date().toISOString(), entries: state.entries.slice(0, 5000) }, null, 2)) } catch (e) {} }
  async function persistTranslated() { try { await writeText(joinPath(state.root, META_TRANSLATED), JSON.stringify({ savedAt: new Date().toISOString(), entries: state.translated }, null, 2)) } catch (e) {} }

  async function loadMeta() {
    if (metaLoaded) return
    metaLoaded = true
    if (!state.root) {
      const cwd = cwdOfExec()
      if (cwd) state.root = cwd
      else {
        try { state.root = await resolveRoot() } catch (e) { state.root = '' }
      }
    }
    let sawConfig = false, sawGlossary = false
    const cfgRaw = await readTextOr(joinPath(state.root, META_CONFIG), null)
    if (cfgRaw) { try { const c = JSON.parse(cfgRaw); if (c && typeof c === 'object') { config = Object.assign(config, c); sawConfig = true } } catch (e) {} }
    if (config.root && config.root !== state.root) state.root = config.root
    const gRaw = await readTextOr(joinPath(state.root, META_GLOSSARY), null)
    if (gRaw) { try { const g = JSON.parse(gRaw); if (Array.isArray(g)) { glossary = g; sawGlossary = true } } catch (e) {} }
    const cRaw = await readTextOr(joinPath(state.root, META_CACHE), null)
    if (cRaw) { try { const c = JSON.parse(cRaw); if (c && typeof c === 'object' && !Array.isArray(c)) cache = c } catch (e) {} }
    const pRaw = await readTextOr(joinPath(state.root, META_PARSED), null)
    if (pRaw) { try { const p = JSON.parse(pRaw); if (p && Array.isArray(p.entries)) { state.entries = p.entries; state.summary.parsed = p.entries.length } } catch (e) {} }
    const tRaw = await readTextOr(joinPath(state.root, META_TRANSLATED), null)
    if (tRaw) { try { const t = JSON.parse(tRaw); if (t && Array.isArray(t.entries)) { state.translated = t.entries; state.summary.translated = t.entries.length } } catch (e) {} }
    if (!sawConfig) persistConfig()
    if (!sawGlossary) persistGlossary()
  }

  // `tl` 是 Ren'Py 的官方翻译目录（game/tl/<lang>/*.rpy）：那是译文参考/来源，
  // 不是待汉化的游戏脚本，就地翻译会破坏参考译文（也正是汉化缓存的来源）。
  // 需要处理它时请把文件显式传给 hanhua_parse/hanhua_export。
  const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hanhua', '.hanhua-out', '.hanhua-tmp', 'tl', 'dist', 'build', 'out', 'backup', 'target', 'bin', 'obj', '__pycache__'])
  const SKIP_FILES = new Set(['.hanhua-config.json', '.hanhua-glossary.json', '.hanhua-cache.json', '.hanhua-parsed.json', '.hanhua-translated.json', '.hanhua-ocr-cache.json', '.hanhua-usage.json', '.hanhua-iconv.in.json', '.hanhua-iconv.bin'])
  // 游戏文本
  const GAME_EXT = new Set(['json', 'csv', 'tsv', 'po', 'pot', 'txt', 'ini', 'yaml', 'yml', 'rpy', 'rxdata', 'rvdata', 'rvdata2', 'ks', 'tjs', 'scn'])
  // v2 新增载体：视频字幕 / 电子书 / 漫画与图片 / 视频（抽字幕轨）
  const SUBTITLE_EXT = new Set(SUB_EXTS)
  const EBOOK_EXT = new Set(['epub', 'pdf', 'html', 'htm', 'xhtml', 'xht'])
  const MAX_SCAN_FILES = 2000
  const MAX_SCAN_IMAGES = 400
  const MAX_DEPTH = 10

  // 文件 → 汉化载体类别（scan 用它分流：文本走 parse，图片/漫画走 ocr，视频走 media）
  const kindOfFile = (name, ext) => {
    if (SUBTITLE_EXT.has(ext)) return 'subtitle'
    if (ext === 'epub' || ext === 'pdf') return 'ebook'
    if (ext === 'html' || ext === 'htm' || ext === 'xhtml' || ext === 'xht') return 'ebook'
    if (isImageExt(ext)) return 'image'
    if (isComicArchiveExt(ext)) return 'comic'
    if (isVideoExt(ext)) return 'video'
    if (GAME_EXT.has(ext)) return 'game'
    return ''
  }
  const SCAN_EXT = new Set([].concat(Array.from(GAME_EXT), Array.from(SUBTITLE_EXT), Array.from(EBOOK_EXT), IMAGE_EXTS, COMIC_ARCHIVE_EXTS, VIDEO_EXTS))

  const guessEngine = (name) => {
    if (/^Map\d{3}\.json$/i.test(name)) return 'rpgmaker-map'
    if (/^Map\d{3}\.(rxdata|rvdata|rvdata2)$/i.test(name)) return 'rgss-map'
    if (/^(Actors|Classes|Skills|Items|Weapons|Armors|Enemies|States|Troops|CommonEvents|System)\.json$/i.test(name)) return 'rpgmaker-db'
    if (/^(Actors|Classes|Skills|Items|Weapons|Armors|Enemies|States|Troops|CommonEvents|System)\.(rxdata|rvdata|rvdata2)$/i.test(name)) return 'rgss-db'
    if (/^Scripts\.(rxdata|rvdata|rvdata2)$/i.test(name)) return 'rgss-scripts'
    return ''
  }

  async function scanRoot(rootArg, opts) {
    await loadMeta()
    opts = opts || {}
    const wantKinds = Array.isArray(opts.kinds) && opts.kinds.length ? new Set(opts.kinds) : null
    const root = await pickRoot(rootArg)
    state.root = root
    if (config.root !== root) { config.root = root; persistConfig() }
    const files = []
    const kinds = { game: 0, subtitle: 0, ebook: 0, image: 0, comic: 0, video: 0 }
    const walk = async (dir, depth) => {
      if (files.length >= MAX_SCAN_FILES || depth > MAX_DEPTH) return
      let children
      try { children = await listChildren(dir) } catch (e) { return }
      for (const c of children) {
        if (files.length >= MAX_SCAN_FILES) return
        if (c.isDir) { if (!SKIP_DIRS.has(c.name.toLowerCase()) && !c.name.startsWith('.')) await walk(c.path, depth + 1); continue }
        if (c.name.startsWith('.')) continue
        if (SKIP_FILES.has(c.name.toLowerCase())) continue
        const ext = extOf(c.name)
        if (!SCAN_EXT.has(ext)) continue
        const kind = kindOfFile(c.name, ext)
        if (!kind) continue
        if (wantKinds && !wantKinds.has(kind)) continue
        if (kind === 'image' && kinds.image >= MAX_SCAN_IMAGES) continue
        kinds[kind] += 1
        files.push({ path: c.path, rel: relPath(root, c.path), ext, kind, engine: guessEngine(c.name) })
      }
    }
    await walk(root, 0)
    state.files = files
    state.summary.scanned = files.length
    const limit = Math.max(1, Math.min(Number(opts.limit) || 200, 2000))
    return { root, total: files.length, kinds, files: files.slice(0, limit), truncated: files.length > limit }
  }

  const SKIP_KEYS = new Set(['id', 'code', 'iconIndex', 'priority', 'note', 'meta'])
  const DB_FIELDS = {
    Actors: ['name', 'nickname', 'profile', 'description'],
    Classes: ['name'],
    Skills: ['name', 'description', 'message1', 'message2'],
    Items: ['name', 'description'],
    Weapons: ['name', 'description'],
    Armors: ['name', 'description'],
    Enemies: ['name'],
    States: ['name', 'description', 'message1', 'message2', 'message3', 'message4'],
    Troops: ['name'],
  }
  const MAX_ENTRIES = 20000
  const MAX_FILE_ENTRIES = 3000

  const pushEntry = (list, file, format, engine, source, ref, loc, idSuffix) => {
    if (typeof source !== 'string' || !source.trim()) return
    if (list.length >= MAX_ENTRIES) return
    list.push({ id: file.rel + '#' + (idSuffix !== undefined ? idSuffix : list.length), file: file.rel, format, engine: engine || '', loc, source, ref })
  }

  function walkJson(value, path, list, file, format, engine) {
    if (list.length >= MAX_FILE_ENTRIES) return
    if (typeof value === 'string') pushEntry(list, file, format, engine, value, path.slice(), { path: path.join('.') }, path.join('.'))
    else if (Array.isArray(value)) { for (let i = 0; i < value.length; i++) walkJson(value[i], path.concat(String(i)), list, file, format, engine) }
    else if (value && typeof value === 'object') {
      for (const k of Object.keys(value)) {
        if (SKIP_KEYS.has(k)) continue
        walkJson(value[k], path.concat(k), list, file, format, engine)
      }
    }
  }

  function parseCommandList(cmds, file, list, idPrefix, refBase) {
    if (!Array.isArray(cmds)) return 0
    let n = 0
    cmds.forEach((cmd, li) => {
      const code = cmd && cmd.code
      const params = cmd && cmd.parameters
      if (code === 101 && params && Array.isArray(params[0])) {
        params[0].forEach((line, i) => { n++; pushEntry(list, file, 'json', refBase.engine, line, Object.assign({ li, code: 101, p: 0, line: i }, refBase), { loc: idPrefix + '.l' + li + '#' + i }, idPrefix + '.' + li + '.' + i) })
      } else if (code === 102 && params && Array.isArray(params[0])) {
        params[0].forEach((ch, i) => { n++; pushEntry(list, file, 'json', refBase.engine, ch, Object.assign({ li, code: 102, p: 0, line: i }, refBase), { loc: idPrefix + '.l' + li + '.c' + i }, idPrefix + '.' + li + '.c' + i) })
      } else if (code === 402 && params && typeof params[1] === 'string') {
        n++; pushEntry(list, file, 'json', refBase.engine, params[1], Object.assign({ li, code: 402, p: 1 }, refBase), { loc: idPrefix + '.l' + li + '.w' }, idPrefix + '.' + li + '.w')
      } else if (code === 408 && params && typeof params[0] === 'string') {
        n++; pushEntry(list, file, 'json', refBase.engine, params[0], Object.assign({ li, code: 408, p: 0 }, refBase), { loc: idPrefix + '.l' + li + '.x' }, idPrefix + '.' + li + '.x')
      }
    })
    return n
  }

  function parseMap(data, file, list) {
    const events = data && data.events
    if (!events || typeof events !== 'object') return 0
    let n = 0
    for (const evKey of Object.keys(events)) {
      const ev = events[evKey]
      if (!ev || !Array.isArray(ev.pages)) continue
      ev.pages.forEach((pg, pi) => {
        if (!Array.isArray(pg.list)) return
        n += parseCommandList(pg.list, file, list, 'ev' + evKey + '.p' + pi, { ev: evKey, pg: pi, engine: 'rpgmaker-map' })
      })
    }
    return n
  }

  function parseDbRows(name, data, file, list) {
    const fields = DB_FIELDS[name]
    if (!fields || !Array.isArray(data)) return 0
    let n = 0
    data.forEach((rec, i) => {
      if (!rec || typeof rec !== 'object') return
      for (const f of fields) {
        const v = rec[f]
        if (typeof v === 'string') { n++; pushEntry(list, file, 'json', 'rpgmaker-dbrow', v, [String(i), f], { loc: name + '[' + i + '].' + f }, name + '.' + i + '.' + f) }
        else if (Array.isArray(v)) {
          v.forEach((sv, j) => { if (typeof sv === 'string') { n++; pushEntry(list, file, 'json', 'rpgmaker-dbrow', sv, [String(i), f, String(j)], { loc: name + '[' + i + '].' + f + '[' + j + ']' }, name + '.' + i + '.' + f + '.' + j) } })
        }
      }
    })
    return n
  }

  function parseSystem(data, file, list) {
    let n = 0
    for (const f of ['gameTitle', 'currencyUnit']) {
      if (typeof data[f] === 'string') { n++; pushEntry(list, file, 'json', 'rpgmaker-system', data[f], [f], { loc: f }, f) }
    }
    const terms = data && data.terms
    if (terms && typeof terms === 'object') {
      for (const arrKey of ['basic', 'params', 'commands']) {
        const arr = terms[arrKey]
        if (Array.isArray(arr)) arr.forEach((v, i) => { if (typeof v === 'string') { n++; pushEntry(list, file, 'json', 'rpgmaker-system', v, ['terms', arrKey, String(i)], { loc: 'terms.' + arrKey + '[' + i + ']' }, 'terms.' + arrKey + '.' + i) } })
      }
      const msgs = terms.messages
      if (msgs && typeof msgs === 'object') {
        for (const k of Object.keys(msgs)) {
          if (typeof msgs[k] === 'string') { n++; pushEntry(list, file, 'json', 'rpgmaker-system', msgs[k], ['terms', 'messages', k], { loc: 'terms.messages.' + k }, 'terms.messages.' + k) }
        }
      }
    }
    return n
  }

  const csvDetect = (text) => {
    const first = text.split(/\r?\n/)[0] || ''
    let best = ',', bestN = 0
    for (const d of [',', ';', '\t']) { const c = first.split(d).length - 1; if (c > bestN) { bestN = c; best = d } }
    return best
  }
  function parseCsv(text, delim) {
    const rows = []
    let row = [], cell = '', inQ = false
    for (let i = 0; i < text.length; i++) {
      const c = text[i]
      if (inQ) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++ } else inQ = false } else cell += c }
      else if (c === '"') inQ = true
      else if (c === delim) { row.push(cell); cell = '' }
      else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = '' }
      else if (c !== '\r') cell += c
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row) }
    return rows
  }
  function csvEntries(text, file, list, fmt) {
    const delim = csvDetect(text)
    const rows = parseCsv(text, delim)
    if (!rows.length) return 0
    const header = rows[0].map((h) => h.trim().toLowerCase())
    let srcCol = 1, keyCol = 0
    header.forEach((h, i) => {
      if (['source', 'text', '\u539f\u6587', 'english', 'en', 'value', 'string', 'msgid'].includes(h)) srcCol = i
      if (['key', 'id', '\u952e'].includes(h)) keyCol = i
    })
    let n = 0
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r]
      if (srcCol >= row.length) continue
      const src = row[srcCol]
      if (!src || !src.trim()) continue
      const key = row[keyCol] || ('row' + r)
      n++
      pushEntry(list, file, fmt || 'csv', '', src, { row: r, col: srcCol }, { loc: 'row' + r + '.col' + srcCol }, key)
    }
    return n
  }

  const poUnescape = (s) => s.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  const poEscape = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '').replace(/\n/g, '\\n').replace(/\t/g, '\\t')
  function parsePo(text, file, list) {
    const blocks = text.split(/\r?\n\r?\n/)
    let n = 0
    blocks.forEach((block, bi) => {
      let msgctxt = null, msgid = '', inMsgid = false, msgstr = '', inMsgstr = false, hasStr = false
      for (const raw of block.split(/\r?\n/)) {
        if (/^msgctxt\s+"/.test(raw)) { msgctxt = poUnescape(raw.replace(/^msgctxt\s+"/, '').replace(/"$/, '')); inMsgid = false; inMsgstr = false }
        else if (/^msgid\s+"/.test(raw)) { msgid += poUnescape(raw.replace(/^msgid\s+"/, '').replace(/"$/, '')); inMsgid = true; inMsgstr = false }
        else if (/^msgstr\s+"/.test(raw)) { msgstr += poUnescape(raw.replace(/^msgstr\s+"/, '').replace(/"$/, '')); inMsgstr = true; inMsgid = false; hasStr = true }
        else if (/^\s*"/.test(raw) && inMsgid) { msgid += poUnescape(raw.trim().replace(/^"/, '').replace(/"$/, '')) }
        else if (/^\s*"/.test(raw) && inMsgstr) { msgstr += poUnescape(raw.trim().replace(/^"/, '').replace(/"$/, '')) }
      }
      if (!msgid) return
      n++
      pushEntry(list, file, 'po', '', msgid, { block: bi, key: msgctxt, pre: msgstr, hasStr }, { loc: 'block' + bi }, (msgctxt ? msgctxt + '|' : '') + msgid.slice(0, 40))
    })
    return n
  }

  function parseIni(text, file, list) {
    let n = 0
    text.split(/\r?\n/).forEach((line, i) => {
      const m = /^(\s*)([^#;\[][^=]*?)(\s*=\s*)(.*)$/.exec(line)
      if (!m) return
      const value = m[4].trim()
      if (!value) return
      const vs = m[4].indexOf(value)
      n++
      pushEntry(list, file, 'ini', '', value, { line: i, prefix: m[1] + m[2] + m[3], suffix: m[4].slice(vs + value.length) }, { loc: 'line' + (i + 1) }, 'line' + (i + 1))
    })
    return n
  }

  function parseTxt(text, file, list, fmt) {
    let n = 0
    text.split(/\r?\n/).forEach((line, i) => {
      const value = line.trim()
      if (!value || /^[#;\/]/.test(value)) return
      const idx = line.indexOf(value)
      n++
      pushEntry(list, file, fmt || 'txt', '', value, { line: i, prefix: line.slice(0, idx), suffix: line.slice(idx + value.length) }, { loc: 'line' + (i + 1) }, 'line' + (i + 1))
    })
    return n
  }

  function parseYaml(text, file, list) {
    let n = 0
    text.split(/\r?\n/).forEach((line, i) => {
      const colon = line.indexOf(':')
      if (colon <= 0) return
      const keyPart = line.slice(0, colon)
      if (!/^[A-Za-z0-9_.\- ]{1,100}$/.test(keyPart.trim())) return
      const rest = line.slice(colon + 1)
      const q = /^(\s*)(["'])/.exec(rest)
      if (q) {
        const qch = q[2]
        const openIdx = q[1].length
        const closeIdx = rest.indexOf(qch, openIdx + 1)
        if (closeIdx < 0) return
        const value = rest.slice(openIdx + 1, closeIdx)
        if (!value.trim()) return
        n++
        pushEntry(list, file, 'yaml', '', value, { line: i, prefix: line.slice(0, colon + 1) + rest.slice(0, openIdx + 1), suffix: rest.slice(closeIdx) }, { loc: 'line' + (i + 1) }, 'line' + (i + 1))
      } else {
        const um = /^(\s+)([^#\s\[{][^#]*?)(\s*)(#.*)?$/.exec(rest)
        if (!um) return
        const value = um[2].trim()
        if (!value) return
        const vs = um[2].indexOf(value)
        n++
        pushEntry(list, file, 'yaml', '', value, { line: i, prefix: line.slice(0, colon + 1) + um[1] + um[2].slice(0, vs), suffix: um[2].slice(vs + value.length) + um[3] + (um[4] || '') }, { loc: 'line' + (i + 1) }, 'line' + (i + 1))
      }
    })
    return n
  }

  function parseRenpy(text, file, list) {
    let n = 0
    text.split(/\r?\n/).forEach((line, i) => {
      const trimLine = line.trim()
      if (!trimLine || trimLine.startsWith('#')) return
      if (/^(import|init|define|default|label|menu|call|jump|return|if|elif|else|while|with|scene|show|hide|play|stop|screen|transform|image|style|$)\b/.test(trimLine)) return
      const re = /(["'])(.*?)\1/g
      let mm, first = true
      while ((mm = re.exec(line))) {
        const value = mm[2]
        if (!value.trim()) continue
        n++
        pushEntry(list, file, 'renpy', '', value, { line: i, start: mm.index + 1, end: mm.index + 1 + value.length, quote: mm[1] }, { loc: 'line' + (i + 1) }, 'line' + (i + 1) + (first ? '' : '.' + mm.index))
        first = false
      }
    })
    return n
  }

  async function parseFiles(filesArg, rootArg) {
    await loadMeta()
    if (rootArg) {
      state.root = await pickRoot(rootArg)
      if (config.root !== state.root) { config.root = state.root; persistConfig() }
    }
    const targets = []
    if (Array.isArray(filesArg) && filesArg.length) {
      for (const f of filesArg) {
        if (typeof f === 'string') targets.push({ rel: f, path: isAbs(f) ? f : joinPath(state.root, f) })
        else if (f && typeof f.path === 'string') targets.push({ rel: f.rel || f.path, path: f.path })
      }
    } else {
      targets.push(...state.files.map((f) => ({ rel: f.rel, path: f.path, kind: f.kind })))
    }
    if (!targets.length) throw new Error('没有可解析的文件，请先执行 hanhua_scan')
    const entries = []
    const errors = []
    const perFile = {}
    let truncated = false
    for (const t of targets) {
      if (entries.length >= MAX_ENTRIES) { truncated = true; break }
      const base = basenameOf(t.rel)
      const ext = extOf(t.rel)
      const kind = t.kind || kindOfFile(base, ext)
      // 图片/漫画/视频不是「文本条目」：由图文的 hanhua_ocr 与视频的 hanhua_media 处理
      if (kind === 'image' || kind === 'comic' || kind === 'video') continue
      const file = { rel: t.rel }
      const before = entries.length
      if (ext === 'json') {
        let text
        try { text = await readText(t.path) } catch (e) { continue }
        let data
        try { data = JSON.parse(text) } catch (e) { data = null }
        if (data === null) continue
        const engine = guessEngine(base)
        if (engine === 'rpgmaker-map') parseMap(data, file, entries)
        else if (base === 'System.json') parseSystem(data, file, entries)
        else if (base === 'CommonEvents.json') {
          if (Array.isArray(data)) data.forEach((item, ci) => { if (item && Array.isArray(item.list)) parseCommandList(item.list, file, entries, 'ce' + ci, { ci, engine: 'rpgmaker-db' }) })
        }
        else if (engine === 'rpgmaker-db') parseDbRows(base, data, file, entries)
        else walkJson(data, [], entries, file, 'json', '')
      } else if (ext === 'rxdata' || ext === 'rvdata' || ext === 'rvdata2') {
        if (/^scripts?\./i.test(base)) continue
        try {
          const bytes = await readBytesMax(t.path, MARSHAL_MAX)
          const tree = marshalRead(bytes)
          extractRgss(tree, file, entries, config.rgssEncoding)
        } catch (e) { errors.push({ file: t.rel, error: msg(e) }); continue }
      } else if (ext === 'ks' || ext === 'scn') {
        try {
          const bytes = await readBytesMax(t.path, KRKR_MAX)
          const dec = decodeBytes(bytes, config.krkrEncoding)
          parseKrkrKs(dec.text, file, entries)
        } catch (e) { errors.push({ file: t.rel, error: msg(e) }); continue }
      } else if (ext === 'tjs') {
        try {
          const bytes = await readBytesMax(t.path, KRKR_MAX)
          const dec = decodeBytes(bytes, config.krkrEncoding)
          parseKrkrTjs(dec.text, file, entries)
        } catch (e) { errors.push({ file: t.rel, error: msg(e) }); continue }
      } else if (ext === 'csv' || ext === 'tsv') {
        try { csvEntries(await readText(t.path), file, entries, 'csv') } catch (e) { try { const b = await readBytesMax(t.path, KRKR_MAX); const d = decodeBytes(b, config.krkrEncoding); csvEntries(d.text, file, entries, 'krkr-csv') } catch (e2) { errors.push({ file: t.rel, error: msg(e2) }) } }
      } else if (ext === 'txt') {
        try { parseTxt(await readText(t.path), file, entries, 'txt') } catch (e) { try { const b = await readBytesMax(t.path, KRKR_MAX); const d = decodeBytes(b, config.krkrEncoding); parseTxt(d.text, file, entries, 'krkr-txt') } catch (e2) { errors.push({ file: t.rel, error: msg(e2) }) } }
      } else if (ext === 'po' || ext === 'pot') {
        let text
        try { text = await readText(t.path) } catch (e) { continue }
        parsePo(text, file, entries)
      } else if (ext === 'ini') {
        let text
        try { text = await readText(t.path) } catch (e) { continue }
        parseIni(text, file, entries)
      } else if (ext === 'yaml' || ext === 'yml') {
        let text
        try { text = await readText(t.path) } catch (e) { continue }
        parseYaml(text, file, entries)
      } else if (ext === 'rpy') {
        let text
        try { text = await readText(t.path) } catch (e) { continue }
        parseRenpy(text, file, entries)
      } else if (isSubtitleExt(ext)) {
        // 视频字幕：保留时间轴/样式，只抽正文（ASS/SSA 的覆写标签换成 ⟦n⟧ 占位符）
        try {
          const bytes = await readBytesMax(t.path, KRKR_MAX)
          const dec = decodeBytes(bytes, config.subtitleEncoding)
          parseSubtitleEntries(dec.text, ext, file, entries, dec.encoding)
        } catch (e) { errors.push({ file: t.rel, error: msg(e) }); continue }
      } else if (ext === 'epub') {
        try { await parseEpubEntries(t.rel, file, entries) } catch (e) { errors.push({ file: t.rel, error: msg(e) }); continue }
      } else if (ext === 'html' || ext === 'htm' || ext === 'xhtml' || ext === 'xht') {
        try {
          const bytes = await readBytesMax(t.path, KRKR_MAX)
          const dec = decodeBytes(bytes, config.krkrEncoding)
          parseHtmlEntries(dec.text, t.rel, file, entries, 'html')
        } catch (e) { errors.push({ file: t.rel, error: msg(e) }); continue }
      } else if (ext === 'pdf') {
        try { await parsePdfEntries(t.rel, file, entries) } catch (e) { errors.push({ file: t.rel, error: msg(e) }); continue }
      } else continue
      perFile[t.rel] = (perFile[t.rel] || 0) + (entries.length - before)
      console.log('parsed ' + t.rel + ': ' + (entries.length - before) + ' entries')
    }
    // OCR 出来的图文条目（format=image）不参与文本解析，但要保留在工作集里。
    // files 参数是「只解析这几个文件」的增量语义：**不能**把其它文件的既有条目/译文丢掉，
    // 否则 hanhua_parse files=[一个文件] 会把之前整轮的解析结果清空。
    let merged
    if (Array.isArray(filesArg) && filesArg.length) {
      const replaced = new Set(targets.map((t) => t.rel))
      merged = state.entries.filter((e) => !replaced.has(e.file)).concat(entries)
    } else {
      merged = entries.concat(state.entries.filter((e) => e.format === 'image'))
    }
    state.entries = merged
    state.summary.parsed = state.entries.length
    // 重新解析后，剔除已不存在条目的旧译文，保证 export 与当前条目集一致
    const liveIds = new Set(state.entries.map((e) => e.id))
    const kept = state.translated.filter((r) => liveIds.has(r.id))
    if (kept.length !== state.translated.length) { state.translated = kept; await persistTranslated() }
    await persistParsed()
    return { total: entries.length, imageEntries: state.entries.filter((e) => e.format === 'image').length, truncated, files: targets.length, perFile, errors: errors.slice(0, 50), entries: entries.slice(0, 20) }
  }

  const PLACEHOLDER_RE = /(%[-+0-9.#]*[a-zA-Z%])|(\{\d+\})|(\$\{[^{}]*\})|(\\[A-Za-z]{1,2}\[\d+\])|(\$\.[A-Za-z]*)|(<\/?[A-Za-z][^>]*>)|(\u27e6\d+\u27e7)/g
  const placeholdersOf = (text) => { const m = text.match(PLACEHOLDER_RE); return (m || []).slice().sort() }
  const CJK_RE = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g
  const cjkRatio = (s) => { const m = s.match(CJK_RE); return s.length ? (m ? m.length : 0) / s.length : 0 }
  function ctxTagOf(e) {
    const f = e.format || ''
    const loc = e.loc && typeof e.loc === 'object' ? e.loc.loc : null
    if (e.engine === 'rgss-map' || e.engine === 'rgss-db' || e.engine === 'rgss-system') {
      if (e.engine === 'rgss-system') return '系统术语'
      if (typeof loc === 'string') {
        if (loc.endsWith('.name')) return '名称'
        if (loc.includes('.w')) return '选项分支'
        if (loc.includes('.c')) return '选项'
        if (loc.includes('.x')) return '注释'
        return '地图对话'
      }
      return '游戏文本'
    }
    if (f === 'krkr-ks' || f === 'krkr-tjs' || f === 'renpy') return '剧本对话'
    if (f === 'krkr-csv' || f === 'csv') return '表格'
    if (f === 'krkr-txt' || f === 'txt') return '文本'
    if (f === 'json') return 'JSON'
    if (f === 'ini') return 'INI'
    if (f === 'po') return '翻译条目'
    if (f === 'yaml') return 'YAML'
    // v2 新增载体
    if (f.indexOf('subtitle-') === 0) return '字幕'
    if (f === 'epub') return '电子书正文'
    if (f === 'html') return '网页正文'
    if (f === 'pdftext') return 'PDF 文本层'
    if (f === 'image') {
      const kind = (e.loc && e.loc.kind) || (e.ref && e.ref.kind) || ''
      if (kind === 'art') return '图片艺术字'
      if (kind === 'bubble') return '漫画气泡'
      return '图片文字'
    }
    return '文本'
  }

  function translateWithGlossary(text, gloss, cacheMap) {
    if (cacheMap && cacheMap[text] !== undefined && cacheMap[text] !== null && cacheMap[text] !== '') return { target: cacheMap[text], method: 'cache' }
    let result = text
    let hit = false
    for (const g of gloss) {
      if (!g.regex && g.source === text) { result = g.target; hit = true; break }
    }
    if (!hit) {
      const subs = gloss.filter((g) => !g.regex).slice().sort((a, b) => b.source.length - a.source.length)
      for (const g of subs) {
        if (/^[A-Za-z0-9][A-Za-z0-9 _'\-]*$/.test(g.source)) {
          try {
            const esc = g.source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            const re = new RegExp('(^|[^A-Za-z0-9_])(?:' + esc + ')(?=$|[^A-Za-z0-9_])', 'gi')
            if (re.test(result)) {
              result = result.replace(re, function (m, pre) { return pre + g.target })
              hit = true
            }
          } catch (e) {}
        } else {
          if (result.split(g.source).length > 1) { result = result.split(g.source).join(g.target); hit = true }
        }
      }
      for (const g of gloss) {
        if (!g.regex) continue
        try { const re = new RegExp(g.source, 'g'); if (re.test(result)) { result = result.replace(re, g.target); hit = true } } catch (e) {}
      }
    }
    return { target: result, method: hit ? 'glossary' : 'passthrough' }
  }

  async function translateWithApi(items) {
    if (!config.apiUrl || !config.apiKey) throw new Error('未配置 apiUrl/apiKey')
    const pairs = items.map((e) => [ctxTagOf(e), e.source])
    const prompt = 'Game / manga / subtitle localization. Translate each [context, text] pair into ' + config.targetLang + ' (from ' + config.sourceLang + '). Match the context style: names/menu short, dialogue natural, descriptions complete, subtitles concise (one line ≈ one line). Keep every placeholder exactly as-is (%s %d {0} \\N[1] \\V[1] <tag> and ⟦1⟧-style tokens). Output ONLY a JSON array of ' + items.length + ' strings, same order.\n' + JSON.stringify(pairs)
    const res = await apiRequest({ model: config.model, temperature: 0.1, messages: [{ role: 'user', content: prompt }] })
    noteUsage({ apiCalls: 1 })
    if (res.usage) noteUsage({ apiPromptTokens: res.usage.prompt_tokens || 0, apiCompletionTokens: res.usage.completion_tokens || 0 })
    const bodyText = String(res.contentText || res.text || '')
    const start = bodyText.indexOf('[')
    const end = bodyText.lastIndexOf(']')
    if (start < 0) throw new Error('API 响应中未找到 JSON 数组: ' + bodyText.slice(0, 200))
    const arr = JSON.parse(bodyText.slice(start, end + 1))
    if (!Array.isArray(arr)) throw new Error('API 响应不是数组')
    return arr.map((v) => String(v))
  }

  function qaCheck(source, target, method) {
    const w = []
    const ps = JSON.stringify(placeholdersOf(source))
    const pt = JSON.stringify(placeholdersOf(target))
    if (ps !== pt) w.push('\u5360\u4f4d\u7b26\u4e0d\u4e00\u81f4: ' + ps + ' => ' + pt)
    const ls = (source.match(/\n/g) || []).length
    const lt = (target.match(/\n/g) || []).length
    if (ls !== lt) w.push('\u6362\u884c\u6570 ' + ls + ' -> ' + lt)
    if (source.startsWith(' ') !== target.startsWith(' ')) w.push('\u884c\u9996\u7a7a\u683c\u4e0d\u4e00\u81f4')
    if (source.endsWith(' ') !== target.endsWith(' ')) w.push('\u884c\u5c3e\u7a7a\u683c\u4e0d\u4e00\u81f4')
    const quiet = method === 'passthrough' || method === 'skip'
    if (!quiet && source.length >= 8 && target.length > 0) {
      const ratio = target.length / source.length
      if (ratio > 3.5) w.push('\u8bd1\u6587\u8fc7\u957f x' + ratio.toFixed(1))
      if (ratio < 0.2) w.push('\u8bd1\u6587\u8fc7\u77ed x' + ratio.toFixed(1))
    }
    if (method !== 'api' && !quiet && /[A-Za-z]{3,}/.test(target)) w.push('\u8bd1\u6587\u6b8b\u7559\u82f1\u6587\uff08\u53ef\u7528 hanhua_config \u914d\u7f6e\u5728\u7ebf API \u8865\u5168\uff09')
    return w
  }

  function summaryOf(results, qaWarnings) {
    const methods = {}
    results.forEach((r) => { methods[r.method] = (methods[r.method] || 0) + 1 })
    return { total: results.length, methods, qaWarnings, lastError: state.lastError, apiUsed: state.summary.apiUsed }
  }

  // hanhua_qa 的实现（工具表里 TOOL_SPECS 引用它）
  async function qaAction(args) {
    await loadMeta()
    args = args || {}
    let pool = state.translated
    const ids = args.ids
    if (Array.isArray(ids) && ids.length) { const idSet = new Set(ids); pool = pool.filter((r) => idSet.has(r.id)) }
    const issues = []
    let warnings = 0
    for (const r of pool) {
      const w = qaCheck(r.source, r.target, r.method)
      if (w.length) { warnings++; issues.push({ id: r.id, file: r.file, source: r.source.slice(0, 80), target: r.target.slice(0, 80), method: r.method, warnings: w }) }
    }
    state.summary.qaWarnings = warnings
    return { ok: true, total: pool.length, warnings, issues: issues.slice(0, 300), usage: usageSnapshot() }
  }

  async function translateEntries(args) {
    await loadMeta()
    args = args || {}
    const ids = Array.isArray(args.ids) ? args.ids : null
    // limit 是「每批条数」而不是「本次总量」：默认只处理尚未翻译的条目，
    // 于是重复调用会一批批推进到全部条目；译文在 state.translated 中**累计**，
    // 一次 hanhua_export 即可写回全部结果。
    const limit = typeof args.limit === 'number' ? Math.max(1, Math.min(Math.floor(args.limit), MAX_ENTRIES)) : 500
    const offset = typeof args.offset === 'number' ? Math.max(0, Math.floor(args.offset)) : 0
    const forceApi = !!args.forceApi
    const chunkSize = Math.max(1, Math.min(parseInt(config.apiChunk, 10) || 40, 100))
    const doneById = new Map(state.translated.map((r) => [r.id, r]))
    let pool = state.entries
    if (ids && ids.length) {
      const idSet = new Set(ids)
      pool = pool.filter((e) => idSet.has(e.id))
    } else if (!forceApi) {
      pool = pool.filter((e) => !doneById.has(e.id))
    }
    if (offset > 0) pool = pool.slice(offset)
    const pendingBefore = pool.length
    pool = pool.slice(0, limit)
    if (!pool.length) {
      // 没有待处理条目：解析都没做过才是错误；「已全部翻译」是正常收敛状态，
      // 返回 no-op 结果而不是抛错，避免按 progress.remaining 循环的调用方在最后一轮失败。
      if (!state.entries.length) throw new Error('没有待翻译条目（先执行 hanhua_parse）')
      return {
        summary: summaryOf([], 0),
        preview: [],
        progress: { processed: 0, pendingBefore: 0, remaining: 0, translatedTotal: state.translated.length, entryTotal: state.entries.length },
        note: (ids && ids.length) ? '指定 id 均已翻译（重译请加 forceApi 或改 ids）' : '全部条目已翻译，无需再调用 hanhua_translate',
      }
    }
    const results = []
    const candidates = []
    if (forceApi) {
      if (!config.apiUrl || !config.apiKey) throw new Error('在线翻译不可用：请先通过 hanhua_config 配置 apiUrl/apiKey')
      candidates.push(...pool)
    } else {
      for (const e of pool) {
        const r = translateWithGlossary(e.source, glossary, cache)
        if (r.method === 'passthrough') candidates.push(e)
        else {
          if (r.method === 'cache') noteUsage({ cacheHits: 1 })
          results.push({ id: e.id, file: e.file, source: e.source, target: r.target, method: r.method })
        }
      }
    }
    // 智能过滤（省 API token）：无字母条目 / 已含大量中日韩字符条目直接跳过；同原文+语境去重
    const apiBatch = []
    const dedupedList = []
    const seenKey = new Set()
    const firstOfKey = new Map()
    for (const e of candidates) {
      if (!/[A-Za-z]{2,}/.test(e.source)) { noteUsage({ skipHits: 1 }); results.push({ id: e.id, file: e.file, source: e.source, target: e.source, method: 'skip' }); continue }
      if (cjkRatio(e.source) >= 0.5) { noteUsage({ skipHits: 1 }); results.push({ id: e.id, file: e.file, source: e.source, target: e.source, method: 'skip' }); continue }
      const key = e.source + '\u0000' + ctxTagOf(e)
      if (seenKey.has(key)) { noteUsage({ dedupHits: 1 }); dedupedList.push({ e, key }); continue }
      seenKey.add(key)
      firstOfKey.set(key, e.id)
      apiBatch.push(e)
    }
    if (apiBatch.length) {
      if (!config.apiUrl || !config.apiKey) {
        apiBatch.forEach((e) => results.push({ id: e.id, file: e.file, source: e.source, target: e.source, method: 'passthrough' }))
        state.lastError = '未配置在线翻译 API，仅使用词典（hanhua_config 可配置）'
      } else {
        for (let i = 0; i < apiBatch.length; i += chunkSize) {
          const chunk = apiBatch.slice(i, i + chunkSize)
          try {
            const outs = await translateWithApi(chunk)
            chunk.forEach((e, j) => {
              const t = typeof outs[j] === 'string' && outs[j] ? outs[j] : e.source
              cache[e.source] = t
              results.push({ id: e.id, file: e.file, source: e.source, target: t, method: 'api' })
            })
            state.summary.apiUsed = true
          } catch (err) {
            chunk.forEach((e) => results.push({ id: e.id, file: e.file, source: e.source, target: e.source, method: 'passthrough' }))
            state.lastError = 'API 翻译失败: ' + msg(err)
          }
        }
      }
    }
    // 去重条目复用同语境首条译文（不额外调用 API）
    if (dedupedList.length) {
      const byId = new Map()
      results.forEach((r) => { if (!byId.has(r.id)) byId.set(r.id, r) })
      for (const { e, key } of dedupedList) {
        const firstId = firstOfKey.get(key)
        const src = byId.get(firstId)
        const method = src && src.method === 'api' ? 'api' : 'passthrough'
        results.push({ id: e.id, file: e.file, source: e.source, target: src ? src.target : e.source, method })
      }
    }
    let qaWarnings = 0
    for (const r of results) {
      r.warnings = qaCheck(r.source, r.target, r.method)
      if (r.warnings.length) qaWarnings++
    }
    // 累计译文：本次处理到的 id 覆盖旧值，其余保留（重复调用可分批跑完全部条目）
    const touched = new Set(results.map((r) => r.id))
    state.translated = [...state.translated.filter((r) => !touched.has(r.id)), ...results]
    state.summary.translated = state.translated.length
    state.summary.qaWarnings = qaWarnings
    await persistTranslated()
    await persistCache()
    await persistUsage()
    return {
      summary: summaryOf(results, qaWarnings),
      preview: results.filter((r) => r.method !== 'passthrough' && r.method !== 'skip').slice(0, 20),
      usage: usageSnapshot(),
      progress: {
        processed: results.length,
        pendingBefore,
        remaining: Math.max(0, pendingBefore - results.length),
        translatedTotal: state.translated.length,
        entryTotal: state.entries.length,
      },
    }
  }

  const setByPath = (obj, segments, value) => {
    let cur = obj
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i]
      if (cur[seg] === undefined || cur[seg] === null) cur[seg] = /^\d+$/.test(segments[i + 1]) ? [] : {}
      cur = cur[seg]
    }
    cur[segments[segments.length - 1]] = value
  }
  const getByPath = (obj, segments) => {
    let cur = obj
    for (const seg of segments) {
      if (cur == null) return undefined
      cur = cur[seg]
    }
    return cur
  }

  function exportRoute(base, ext, firstEntry) {
    const engine = firstEntry ? firstEntry.engine : ''
    if (ext === 'json') {
      if (engine === 'rpgmaker-map') return 'map'
      if (engine === 'rpgmaker-db' && base === 'CommonEvents.json') return 'ce'
      return 'json'
    }
    if (ext === 'csv' || ext === 'tsv') return 'csv'
    if (ext === 'po' || ext === 'pot') return 'po'
    return 'lines'
  }

  function rebuildText(base, ext, text, rs, entryById) {
    const route = exportRoute(base, ext, entryById[rs[0].id])
    if (route === 'json') {
      const data = JSON.parse(text)
      for (const r of rs) {
        const e = entryById[r.id]
        if (!e || !Array.isArray(e.ref) || r.target === r.source) continue
        if (getByPath(data, e.ref) === e.source) setByPath(data, e.ref, r.target)
      }
      return JSON.stringify(data, null, 2)
    }
    if (route === 'map') {
      const data = JSON.parse(text)
      for (const r of rs) {
        const e = entryById[r.id]
        if (!e || !e.ref || e.ref.code === undefined) continue
        const ev = data.events && data.events[e.ref.ev]
        const lst = ev && ev.pages && ev.pages[e.ref.pg] && ev.pages[e.ref.pg].list
        const cmd = lst && lst[e.ref.li]
        if (!cmd || !Array.isArray(cmd.parameters)) continue
        if ((e.ref.code === 101 || e.ref.code === 102) && Array.isArray(cmd.parameters[0])) {
          if (cmd.parameters[0][e.ref.line] === e.source) cmd.parameters[0][e.ref.line] = r.target
        } else if (e.ref.code === 402 && cmd.parameters[1] === e.source) cmd.parameters[1] = r.target
        else if (e.ref.code === 408 && cmd.parameters[0] === e.source) cmd.parameters[0] = r.target
      }
      return JSON.stringify(data, null, 2)
    }
    if (route === 'ce') {
      const data = JSON.parse(text)
      for (const r of rs) {
        const e = entryById[r.id]
        if (!e || !e.ref || e.ref.code === undefined || !Array.isArray(data)) continue
        const item = data[e.ref.ci]
        const cmd = item && item.list && item.list[e.ref.li]
        if (!cmd || !Array.isArray(cmd.parameters)) continue
        if ((e.ref.code === 101 || e.ref.code === 102) && Array.isArray(cmd.parameters[0])) {
          if (cmd.parameters[0][e.ref.line] === e.source) cmd.parameters[0][e.ref.line] = r.target
        } else if (e.ref.code === 402 && cmd.parameters[1] === e.source) cmd.parameters[1] = r.target
        else if (e.ref.code === 408 && cmd.parameters[0] === e.source) cmd.parameters[0] = r.target
      }
      return JSON.stringify(data, null, 2)
    }
    if (route === 'csv') {
      const delim = csvDetect(text)
      const rows = parseCsv(text, delim)
      for (const r of rs) {
        const e = entryById[r.id]
        if (!e || !e.ref || e.ref.row === undefined) continue
        if (rows[e.ref.row] && rows[e.ref.row][e.ref.col] === e.source) rows[e.ref.row][e.ref.col] = r.target
      }
      return rows.map((row) => row.map((cell) => (cell.includes(delim) || cell.includes('"') || cell.includes('\n') ? '"' + cell.replace(/"/g, '""') + '"' : cell)).join(delim)).join('\n')
    }
    if (route === 'po') {
      const blocks = text.split(/\r?\n\r?\n/)
      for (const r of rs) {
        const e = entryById[r.id]
        if (!e || !e.ref || blocks[e.ref.block] === undefined) continue
        const escaped = poEscape(r.target)
        let block = blocks[e.ref.block]
        if (/\bmsgstr\s+"/.test(block)) block = block.replace(/msgstr\s+"(?:[^"\\]|\\.)*"([^\S\r\n]*)$/m, 'msgstr "' + escaped + '"$1')
        else block = block + '\nmsgstr "' + escaped + '"'
        blocks[e.ref.block] = block
      }
      return blocks.join('\n\n')
    }
    const lines = text.split(/\r?\n/)
    const newline = text.includes('\r\n') ? '\r\n' : '\n'
    for (const r of rs) {
      const e = entryById[r.id]
      if (!e || !e.ref || typeof e.ref.line !== 'number') continue
      const i = e.ref.line
      if (i >= lines.length) continue
      if (e.format === 'renpy') {
        if (e.ref.start !== undefined && e.ref.end !== undefined && e.ref.quote) {
          const seg = lines[i].slice(e.ref.start, e.ref.end)
          if (seg === e.source) lines[i] = lines[i].slice(0, e.ref.start) + r.target + lines[i].slice(e.ref.end)
        }
      } else {
        if (e.ref.prefix !== undefined && e.ref.suffix !== undefined) {
          const cur = lines[i].slice(e.ref.prefix.length, lines[i].length - e.ref.suffix.length)
          if (cur === e.source || cur.trim() === e.source.trim()) lines[i] = e.ref.prefix + r.target + e.ref.suffix
        }
      }
    }
    return lines.join(newline)
  }

  async function exportRgssFile(rel, rs, entryById) {
    const srcPath = joinPath(state.root, rel)
    const bytes = await readBytesMax(srcPath, MARSHAL_MAX)
    const tree = marshalRead(bytes)
    const hintEnc = config.rgssEncoding
    const pending = []
    const nodeSeen = new Set()
    for (const r of rs) {
      const e = entryById[r.id]
      if (!e || !Array.isArray(e.ref) || r.target === r.source) continue
      const node = nodeAt(tree, e.ref)
      if (!node || (node.t !== 's' && node.t !== 'sI')) continue
      if (rgssText(node, hintEnc) !== e.source) continue
      if (nodeSeen.has(node)) continue
      nodeSeen.add(node)
      pending.push({ node, target: r.target })
    }
    for (const p of pending) {
      p.enc = decodeBytes(strToBytes(p.node.v), hintEnc).encoding
    }
    const legacy = pending.filter((p) => p.enc !== 'utf-8' && p.enc !== 'latin1' && p.enc !== 'utf-16le' && p.enc !== 'utf-16be')
    if (legacy.length) {
      const outs = await iconvBatch(legacy.map((p) => ({ text: p.target, enc: p.enc })))
      legacy.forEach((p, i) => { p.node.v = outs[i] })
    }
    for (const p of pending) {
      if (p.enc === 'utf-8' || p.enc === 'latin1') p.node.v = latin1Of(new TextEncoder().encode(p.target))
      else if (p.enc === 'utf-16le' || p.enc === 'utf-16be') p.node.v = latin1Of(encodeText(p.target, p.enc, false))
    }
    return { bytes: marshalWrite(tree), binary: true }
  }

  async function exportKrkrFile(rel, rs, entryById) {
    const srcPath = joinPath(state.root, rel)
    const bytes = await readBytesMax(srcPath, KRKR_MAX)
    const dec = decodeBytes(bytes, config.krkrEncoding)
    let text = dec.text
    const first = entryById[rs[0].id]
    const fmt = first ? first.format : 'krkr-ks'
    if (fmt === 'krkr-csv') {
      const delim = csvDetect(text)
      const rows = parseCsv(text, delim)
      for (const r of rs) {
        const e = entryById[r.id]
        if (!e || !e.ref || e.ref.row === undefined) continue
        if (rows[e.ref.row] && rows[e.ref.row][e.ref.col] === e.source) rows[e.ref.row][e.ref.col] = r.target
      }
      text = rows.map((row) => row.map((cell) => (cell.includes(delim) || cell.includes('"') || cell.includes('\n') ? '"' + cell.replace(/"/g, '""') + '"' : cell)).join(delim)).join('\n')
    } else {
      const lines = text.split(/\r?\n/)
      const newline = text.includes('\r\n') ? '\r\n' : '\n'
      for (const r of rs) {
        const e = entryById[r.id]
        if (!e || !e.ref || typeof e.ref.line !== 'number') continue
        const i = e.ref.line
        if (i >= lines.length) continue
        if (fmt === 'krkr-txt') {
          const ref = e.ref
          const cur = lines[i].slice(ref.prefix.length, lines[i].length - ref.suffix.length)
          if (cur === e.source || cur.trim() === e.source.trim()) lines[i] = ref.prefix + r.target + ref.suffix
        } else {
          const ref = e.ref
          const isQ = !!ref.quote
          const inner = lines[i].slice(ref.start + (isQ ? 1 : 0), ref.end)
          if (inner !== e.source) continue
          lines[i] = lines[i].slice(0, ref.start) + ref.quote + r.target + ref.quote + lines[i].slice(ref.end + (isQ ? 1 : 0))
        }
      }
      text = lines.join(newline)
    }
    if (dec.encoding === 'utf-8') return { text, binary: false }
    if (dec.encoding === 'utf-16le' || dec.encoding === 'utf-16be') return { bytes: encodeText(text, dec.encoding, dec.bom), binary: true }
    return { legacyText: text, legacyEnc: dec.encoding, binary: 'legacy' }
  }

  async function exportEntries(args) {
    await loadMeta()
    await loadOcrCache()
    args = args || {}
    const mode = args.mode === 'out' ? 'out' : 'inplace'
    const results = state.translated
    if (!results.length) throw new Error('没有译文，请先执行 hanhua_translate')
    const entryById = {}
    state.entries.forEach((e) => { entryById[e.id] = e })
    const byFile = {}
    results.forEach((r) => { (byFile[r.file] = byFile[r.file] || []).push(r) })
    const out = []
    for (const rel of Object.keys(byFile)) {
      const rs = byFile[rel]
      const srcPath = joinPath(state.root, rel)
      const ext = extOf(rel)
      const base = basenameOf(rel)
      const firstEntry = entryById[rs[0].id]
      const fmt = firstEntry ? firstEntry.format : ''
      const kind = firstEntry && firstEntry.format === 'image' ? 'image' : kindOfFile(base, ext)
      let result
      try {
        if (fmt === 'rgss') {
          result = await exportRgssFile(rel, rs, entryById)
        } else if (fmt.indexOf('krkr-') === 0) {
          result = await exportKrkrFile(rel, rs, entryById)
        } else if (fmt.indexOf('subtitle-') === 0) {
          result = await exportSubtitleFile(rel, rs, entryById, mode)
        } else if (fmt === 'epub') {
          result = await exportEpubFile(rel, rs, entryById, mode)
        } else if (fmt === 'html') {
          result = await exportHtmlFile(rel, rs, entryById)
        } else if (fmt === 'pdftext') {
          result = await exportPdfSidecar(rel, rs, entryById)
        } else if (fmt === 'image') {
          result = await exportImageFile(rel, rs, entryById, args)
        } else {
          const text = await readText(srcPath)
          result = { text: rebuildText(base, ext, text, rs, entryById), binary: false }
        }
      } catch (e) { out.push({ file: rel, ok: false, error: msg(e) }); continue }
      if (result.skip) { out.push({ file: rel, ok: true, skipped: true, reason: '没有实际变更' }); continue }
      // ZIP 容器（EPUB / 漫画包）：整包重写，保留条目顺序与压缩方式
      if (result.epubReplace) {
        const dest = mode === 'out' ? joinPath('.hanhua-out', rel) : rel
        try {
          if (mode === 'inplace') await backupOnce(rel, 'binary', MARSHAL_MAX)
          await media.zipReplace(joinPath(state.root, rel), joinPath(state.root, dest), result.epubReplace.replacements)
          out.push({ file: rel, ok: true, mode, dest, backup: mode === 'inplace' ? rel + '.bak' : null, entries: result.epubReplace.replacements.length })
        } catch (e) { out.push({ file: rel, ok: false, error: 'zip: ' + msg(e) }) }
        continue
      }
      const dest = result.sidecar ? joinPath('.hanhua-out', (basenameOf(rel).replace(/\.[^.]+$/, '') || rel) + '.hanhua.txt') : (mode === 'out' ? joinPath('.hanhua-out', rel) : rel)
      const backup = rel + '.bak'
      try {
        if (mode === 'inplace' && !result.sidecar) {
          if (result.binary === true) await backupOnce(rel, 'binary', MARSHAL_MAX)
          else if (result.binary === 'legacy') await backupOnce(rel, 'binary', KRKR_MAX)
          else await backupOnce(rel, 'text', KRKR_MAX, result.text)
        }
        if (result.binary === true && result.bytes) await writeBytes(joinPath(state.root, dest), result.bytes)
        else if (result.binary === 'legacy') await writeTextLegacy(joinPath(state.root, dest), result.legacyText, result.legacyEnc)
        else if (result.text !== null && result.text !== undefined) await writeText(joinPath(state.root, dest), result.text)
        out.push({ file: rel, ok: true, mode, dest, backup: (mode === 'inplace' && !result.sidecar) ? backup : null, sidecar: !!result.sidecar })
      } catch (e) {
        out.push({ file: rel, ok: false, error: 'write: ' + msg(e) })
      }
    }
    const okCount = out.filter((o) => o.ok).length
    state.summary.exported = okCount
    return { total: out.length, ok: okCount, results: out.slice(0, 200) }
  }

  // .bak 写一次即固定：它是「汉化前的原文」回滚点。多轮导出（分批翻译/追加翻译）
  // 时若每轮都覆盖，备份会漂移成上一轮的半成品，最终丢掉原文。
  async function backupOnce(rel, kind, maxBytes, newText) {
    const backup = rel + '.bak'
    const backupTarget = await fs.resolve(joinPath(state.root, backup))
    if ((await fs.stat(backupTarget)) !== undefined) return false
    try {
      if (kind === 'binary') await writeBytes(joinPath(state.root, backup), await readBytesMax(joinPath(state.root, rel), maxBytes))
      else {
        const original = await readText(joinPath(state.root, rel))
        if (newText === undefined || original !== newText) await writeText(joinPath(state.root, backup), original)
      }
      return true
    } catch (e) { return false }
  }

  const maskConfig = (c) => Object.assign({}, c, { apiKey: c.apiKey ? (c.apiKey.slice(0, 4) + '****' + c.apiKey.slice(-4)) : '' })

  const CONFIG_STRING_FIELDS = ['apiUrl', 'apiKey', 'model', 'targetLang', 'sourceLang', 'rgssEncoding', 'krkrEncoding', 'subtitleEncoding', 'iconvPath',
    'visionModel', 'ocrEngine', 'ocrLang', 'ocrLayout', 'typesetFont', 'pythonPath', 'powershellPath', 'ffmpegPath', 'ffprobePath', 'workbenchEnginePath']
  const CONFIG_NUMBER_FIELDS = ['visionMaxTokens', 'ocrBudget', 'ocrMaxImages', 'ocrMinArea', 'ocrMaxRegions']

  async function configAction(args) {
    await loadMeta()
    if (args.action === 'get') return { config: maskConfig(config) }
    if (args.root !== undefined) { state.root = await pickRoot(args.root); config.root = state.root }
    for (const k of CONFIG_STRING_FIELDS) if (args[k] !== undefined) config[k] = args[k]
    for (const k of CONFIG_NUMBER_FIELDS) if (args[k] !== undefined) config[k] = Math.max(0, parseInt(args[k], 10) || 0)
    if (args.apiChunk !== undefined) config.apiChunk = Math.max(1, Math.min(parseInt(args.apiChunk, 10) || 40, 100))
    await persistConfig()
    return { config: maskConfig(config) }
  }

  async function glossaryAction(args) {
    await loadMeta()
    if (args.action === 'list') return { entries: glossary, total: glossary.length }
    if (args.action === 'add') {
      if (!args.source || !args.target) throw new Error('source/target 必填')
      if (glossary.some((g) => g.source === args.source && !!g.regex === !!args.regex)) throw new Error('该词条已存在')
      glossary.push({ source: args.source, target: args.target, regex: !!args.regex, note: args.note || '' })
      await persistGlossary()
      return { entries: glossary, total: glossary.length }
    }
    if (args.action === 'remove') {
      if (typeof args.index === 'number' && glossary[args.index]) glossary.splice(args.index, 1)
      else if (args.source) {
        const i = glossary.findIndex((g) => g.source === args.source)
        if (i >= 0) glossary.splice(i, 1)
        else throw new Error('未找到词条: ' + args.source)
      } else throw new Error('remove 需要 index 或 source')
      await persistGlossary()
      return { entries: glossary, total: glossary.length }
    }
    if (args.action === 'reset') { glossary = SEED_GLOSSARY.slice(); await persistGlossary(); return { entries: glossary, total: glossary.length } }
    throw new Error('未知 action: ' + args.action)
  }

  // ── 内联的子进程脚本（源在 engine/src/scripts/，由 tools/build-engine.mjs 注入） ──
  // 运行时按需写入 <项目根>/.hanhua-tmp/（内容变了才重写），再 spawn node/python/powershell。
  const SCRIPT_SOURCES = {
    "imglib.py": "#!/usr/bin/env python3\n# -*- coding: utf-8 -*-\n\"\"\"imglib.py —— 汉化引擎的图像 / PDF 处理底层能力。\n\n用法：\n    python imglib.py <in.json> <out.json>\n\n契约：\n    * 所有路径为绝对路径；无论成败都写出 out.json。\n    * 成功：{\"ok\": true, ...}    失败：{\"ok\": false, \"error\": \"...\"}\n    * 退出码 0 表示 out.json 已写出；日志一律写 stderr，不污染 out.json。\n\n支持的 op：probe / regions / crop / typeset / pdf / resize\n仅依赖：标准库 + Pillow + numpy。\n\"\"\"\n\nimport json\nimport os\nimport re\nimport struct\nimport sys\nimport traceback\nimport zlib\n\nimport numpy as np\nfrom PIL import Image, ImageDraw, ImageFont, ImageOps\n\nImage.MAX_IMAGE_PIXELS = None  # 汉化素材常见超大图，放开 Pillow 解压炸弹阈值\n\n# ---------------------------------------------------------------- 基础工具\n\n\ndef log(msg):\n    \"\"\"日志写 stderr，绝不污染 out.json。\"\"\"\n    sys.stderr.write('[imglib] %s\\n' % msg)\n    sys.stderr.flush()\n\n\ndef _fail(msg):\n    raise RuntimeError(msg)\n\n\ndef _require(cond, msg):\n    if not cond:\n        _fail(msg)\n\n\ndef _num(v, default=None, name='参数'):\n    if v is None:\n        return default\n    if isinstance(v, bool) or not isinstance(v, (int, float)):\n        _fail('%s 必须是数字，收到 %r' % (name, v))\n    return v\n\n\ndef _int(v, default=None, name='参数'):\n    n = _num(v, default, name)\n    return default if n is None else int(round(n))\n\n\ndef _box4(v, name='box'):\n    \"\"\"把 [x, y, w, h] 规整成 4 个 float；非法直接抛错。\"\"\"\n    _require(isinstance(v, (list, tuple)) and len(v) == 4,\n             '%s 必须是长度 4 的数组 [x,y,w,h]，收到 %r' % (name, v))\n    out = []\n    for i, e in enumerate(v):\n        _require(isinstance(e, (int, float)) and not isinstance(e, bool),\n                 '%s[%d] 必须是数字' % (name, i))\n        out.append(float(e))\n    return out\n\n\ndef _rgb(v, default, name='颜色'):\n    if v is None:\n        return default\n    _require(isinstance(v, (list, tuple)) and len(v) >= 3,\n             '%s 必须是 [r,g,b]' % name)\n    return tuple(int(max(0, min(255, c))) for c in v[:3])\n\n\ndef _s(v, default=''):\n    if v is None:\n        return default\n    return v if isinstance(v, str) else str(v)\n\n\ndef write_result(out_path, payload):\n    \"\"\"原子写出 out.json（UTF-8、ensure_ascii=False）。\"\"\"\n    tmp = out_path + '.tmp'\n    with open(tmp, 'w', encoding='utf-8', newline='\\n') as fh:\n        json.dump(payload, fh, ensure_ascii=False)\n        fh.write('\\n')\n    os.replace(tmp, out_path)\n\n\n# ---------------------------------------------------------------- 图像载入\n\n_IMG_CACHE = {}\n\n\ndef load_image(path):\n    \"\"\"按绝对路径载入图像（带缓存）。\"\"\"\n    _require(isinstance(path, str) and path, 'path 必须是非空字符串')\n    if path in _IMG_CACHE:\n        return _IMG_CACHE[path]\n    _require(os.path.isfile(path), '图像不存在：%s' % path)\n    try:\n        im = Image.open(path)\n        im.load()\n    except Exception as exc:\n        _fail('图像无法解码：%s（%s）' % (path, exc))\n    try:\n        im = ImageOps.exif_transpose(im)\n    except Exception:\n        pass\n    _IMG_CACHE[path] = im\n    return im\n\n\ndef to_rgba(im):\n    if im.mode == 'RGBA':\n        return im\n    if im.mode == 'P':\n        return im.convert('RGBA')\n    if im.mode in ('LA', 'PA'):\n        return im.convert('RGBA')\n    return im.convert('RGBA')\n\n\ndef save_like(im_rgba, out_path):\n    \"\"\"按输出扩展名保存；尽量还原输入模式（JPEG 不支持 alpha）。\"\"\"\n    outdir = os.path.dirname(os.path.abspath(out_path))\n    if outdir:\n        os.makedirs(outdir, exist_ok=True)\n    ext = os.path.splitext(out_path)[1].lower()\n    if ext in ('.jpg', '.jpeg'):\n        bg = Image.new('RGB', im_rgba.size, (255, 255, 255))\n        bg.paste(im_rgba, (0, 0), im_rgba)\n        bg.save(out_path, quality=95, subsampling=0)\n        return im_rgba.size\n    if ext == '.webp':\n        im_rgba.save(out_path, quality=95)\n        return im_rgba.size\n    if ext in ('.bmp',):\n        im_rgba.convert('RGB').save(out_path)\n        return im_rgba.size\n    im_rgba.save(out_path)\n    return im_rgba.size\n\n\n# ---------------------------------------------------------------- 字体\n\nFONT_DIR = r'C:\\Windows\\Fonts'\n\n# rank 越小越优先\nFONT_CANDIDATES = [\n    ('msyh', 'msyh.ttc', 0),\n    ('msyhbd', 'msyhbd.ttc', 1),\n    ('simhei', 'simhei.ttf', 2),\n    ('simsun', 'simsun.ttc', 3),\n    ('NotoSansSC-VF', 'NotoSansSC-VF.ttf', 4),\n    ('Deng', 'Deng.ttf', 5),\n    ('simkai', 'simkai.ttf', 6),\n    ('simfang', 'simfang.ttf', 7),\n    ('msjh', 'msjh.ttc', 8),\n    ('msyhl', 'msyhl.ttc', 9),\n    ('arial', 'arial.ttf', 20),\n]\n\n_CMAP_CACHE = {}\n_FONT_CACHE = {}\n_PROBE_CACHE = None\n\n\ndef _cmap_ranges_from_bytes(path, face_index=0):\n    \"\"\"直接从字体文件读 cmap 表，返回 {start, end} 区间列表。\n\n    只依赖标准库 struct：覆盖 format 4 / 12（Windows/Unicode 平台），\n    足以判断 CJK 覆盖。失败返回 None。\n    \"\"\"\n    try:\n        with open(path, 'rb') as fh:\n            data = fh.read()\n        if len(data) < 12:\n            return None\n        tag = data[:4]\n        off = 0\n        if tag == b'ttcf':\n            n = struct.unpack('>I', data[8:12])[0]\n            if n < 1 or 12 + 4 * n > len(data):\n                return None\n            face_index = min(face_index, n - 1)\n            off = struct.unpack('>I', data[12 + 4 * face_index:16 + 4 * face_index])[0]\n        if off + 12 > len(data):\n            return None\n        num_tables = struct.unpack('>H', data[off + 4:off + 6])[0]\n        cmap_off = None\n        for i in range(num_tables):\n            rec = off + 12 + 16 * i          # sfnt 表目录项：tag/checksum/offset/length\n            if rec + 16 > len(data):\n                return None\n            if data[rec:rec + 4] == b'cmap':\n                cmap_off = struct.unpack('>I', data[rec + 8:rec + 12])[0]\n                break\n        if cmap_off is None or cmap_off + 4 > len(data):\n            return None\n        n_sub = struct.unpack('>H', data[cmap_off + 2:cmap_off + 4])[0]\n        best = None\n        for i in range(n_sub):\n            rec = cmap_off + 4 + 8 * i\n            if rec + 8 > len(data):\n                break\n            plat, enc = struct.unpack('>HH', data[rec:rec + 4])\n            so = struct.unpack('>I', data[rec + 4:rec + 8])[0]\n            if plat == 3 and enc == 10:\n                score = 3\n            elif plat == 0 and enc >= 4:\n                score = 2\n            elif plat == 3 and enc == 1:\n                score = 1\n            elif plat == 0:\n                score = 1\n            elif plat == 1 and enc == 0:\n                score = 0  # Mac Roman，基本无 CJK\n            else:\n                continue\n            if best is None or score >= best[0]:\n                best = (score, so)\n        if best is None:\n            return None\n        so = cmap_off + best[1]      # 子表偏移相对 cmap 表起始\n        if so + 2 > len(data):\n            return None\n        fmt = struct.unpack('>H', data[so:so + 2])[0]\n        ranges = []\n        if fmt == 4:\n            segx2 = struct.unpack('>H', data[so + 6:so + 8])[0]\n            seg = segx2 // 2\n            ends_off = so + 14\n            starts_off = ends_off + 2 * seg + 2\n            if seg == 0 or starts_off + 2 * seg > len(data):\n                return None\n            ends = struct.unpack('>%dH' % seg, data[ends_off:ends_off + 2 * seg])\n            starts = struct.unpack('>%dH' % seg, data[starts_off:starts_off + 2 * seg])\n            for k in range(seg):\n                if starts[k] <= ends[k] and starts[k] != 0xFFFF:\n                    ranges.append((starts[k], ends[k]))\n        elif fmt == 12:\n            ngroups = struct.unpack('>I', data[so + 12:so + 16])[0]\n            base = so + 16\n            if base + 12 * ngroups > len(data):\n                return None\n            for k in range(ngroups):\n                s, e, _g = struct.unpack('>III', data[base + 12 * k:base + 12 * k + 12])\n                ranges.append((s, e))\n        elif fmt == 6:\n            first = struct.unpack('>H', data[so + 6:so + 8])[0]\n            cnt = struct.unpack('>H', data[so + 8:so + 10])[0]\n            ranges.append((first, first + cnt - 1))\n        else:\n            return None\n        return ranges\n    except Exception:\n        return None\n\n\ndef font_cmap(path):\n    \"\"\"取字体的 unicode 码点覆盖区间（TTC 取第一个 face）。失败返回 None。\"\"\"\n    if path in _CMAP_CACHE:\n        return _CMAP_CACHE[path]\n    ranges = _cmap_ranges_from_bytes(path, 0)\n    if ranges is None:\n        # 兜底：FreeType 解析失败时，用字形索引判断（index == 0 表示缺字）\n        ranges = []\n        try:\n            f = ImageFont.truetype(path, 20, index=0)\n            for cp in (0x4F60, 0x597D, 0x3042, 0x41, 0x30, 0x20):\n                idx = f.getmask(chr(cp)).getbbox()\n                if idx:\n                    ranges.append((cp, cp))\n        except Exception:\n            return None\n    _CMAP_CACHE[path] = ranges\n    return ranges\n\n\ndef _cmap_covers(ranges, cp):\n    for s, e in ranges:\n        if s <= cp <= e:\n            return True\n    return False\n\n\ndef font_has_cjk(path):\n    cmap = font_cmap(path)\n    if not cmap:\n        return False\n    return all(_cmap_covers(cmap, ord(ch)) for ch in '你好あ')\n\n\ndef pick_font(need_cjk=None, explicit=None, size=20):\n    \"\"\"挑选可用字体文件。need_cjk=None 表示按文本内容自动判定。\"\"\"\n    if explicit:\n        _require(os.path.isfile(explicit), '字体文件不存在：%s' % explicit)\n        return explicit\n    want_cjk = True if need_cjk is None else bool(need_cjk)\n\n    def usable(p):\n        return bool(p) and os.path.isfile(p) and bool(font_cmap(p))\n\n    ordered = sorted(FONT_CANDIDATES, key=lambda r: r[2])\n    if not want_cjk:\n        for name, fn, rank in sorted(FONT_CANDIDATES, key=lambda r: r[2]):\n            if name in ('msyh', 'arial'):\n                p = os.path.join(FONT_DIR, fn)\n                if usable(p):\n                    return p\n    for name, fn, rank in ordered:\n        p = os.path.join(FONT_DIR, fn)\n        if not usable(p):\n            continue\n        if not want_cjk:\n            return p\n        if font_has_cjk(p):\n            return p\n    if want_cjk:  # 兜底：扫描目录里任意 CJK 字体\n        for f in scan_font_files():\n            if f['cjk']:\n                return f['path']\n    for name, fn, rank in ordered:\n        p = os.path.join(FONT_DIR, fn)\n        if usable(p):\n            return p\n    _fail('找不到任何可用字体（%s）' % FONT_DIR)\n\n\ndef load_font(path, size):\n    key = (path, int(size))\n    if key not in _FONT_CACHE:\n        try:\n            _FONT_CACHE[key] = ImageFont.truetype(path, int(size), index=0)\n        except Exception:\n            _FONT_CACHE[key] = ImageFont.truetype(path, int(size))\n    return _FONT_CACHE[key]\n\n\ndef scan_font_files(limit=400):\n    \"\"\"扫描 C:\\\\Windows\\\\Fonts，返回 [{name,path,cjk}]。\"\"\"\n    if not os.path.isdir(FONT_DIR):\n        return []\n    names = []\n    try:\n        names = sorted(os.listdir(FONT_DIR))\n    except Exception:\n        return []\n    out = []\n    seen = set()\n    count = 0\n    for fn in names:\n        low = fn.lower()\n        if not low.endswith(('.ttf', '.ttc', '.otf')):\n            continue\n        if low.startswith('~'):\n            continue\n        path = os.path.join(FONT_DIR, fn)\n        if not os.path.isfile(path) or path in seen:\n            continue\n        seen.add(path)\n        cjk = font_has_cjk(path)\n        if count >= limit and not cjk:\n            continue\n        count += 1\n        out.append({'name': os.path.splitext(fn)[0], 'path': path, 'cjk': cjk})\n    # 常用字体排前面，其余按名称\n    rank = {os.path.splitext(f)[0].lower(): r for _, f, r in FONT_CANDIDATES}\n    out.sort(key=lambda e: (rank.get(e['name'].lower(), 100), e['name'].lower()))\n    return out\n\n\ndef report_fonts():\n    \"\"\"probe 用字体清单：优先常用字体，保证至少一个 cjk:true。\"\"\"\n    global _PROBE_CACHE\n    if _PROBE_CACHE is not None:\n        return _PROBE_CACHE\n    listed = []\n    seen = set()\n    for name, fn, rank in sorted(FONT_CANDIDATES, key=lambda r: r[2]):\n        path = os.path.join(FONT_DIR, fn)\n        if os.path.isfile(path) and font_cmap(path) is not None and path not in seen:\n            seen.add(path)\n            listed.append({'name': name, 'path': path, 'cjk': font_has_cjk(path)})\n    extra = [f for f in scan_font_files(limit=12) if f['path'] not in seen and f['cjk']]\n    listed.extend(extra[:12])\n    if not any(f['cjk'] for f in listed):\n        for f in scan_font_files(limit=400):\n            if f['cjk']:\n                listed.append(f)\n                break\n    _PROBE_CACHE = listed\n    return listed\n\n\n# ---------------------------------------------------------------- 形态学（纯 numpy 3x3）\n\ndef _dilate3(mask):\n    # padded 视图坐标偏移：m[i,j] 对应原图 (i+1-r, j+1-c)\n    p = np.pad(mask, 1, mode='constant', constant_values=False)\n    acc = np.zeros(mask.shape, dtype=bool)\n    for r in range(3):\n        for c in range(3):\n            if r == 1 and c == 1:\n                continue\n            np.logical_or(acc, p[r:r + mask.shape[0], c:c + mask.shape[1]], out=acc)\n    np.logical_or(acc, mask, out=acc)\n    return acc\n\n\ndef _erode3(mask):\n    p = np.pad(mask, 1, mode='constant', constant_values=False)\n    acc = np.ones(mask.shape, dtype=bool)\n    for r in range(3):\n        for c in range(3):\n            np.logical_and(acc, p[r:r + mask.shape[0], c:c + mask.shape[1]], out=acc)\n    return acc\n\n\ndef dilate(mask, times=1):\n    for _ in range(max(0, int(times))):\n        mask = _dilate3(mask)\n    return mask\n\n\ndef erode(mask, times=1):\n    for _ in range(max(0, int(times))):\n        mask = _erode3(mask)\n    return mask\n\n\n# ---------------------------------------------------------------- 连通域（行程 + union-find）\n\ndef connected_components(mask):\n    \"\"\"对二值化图做 8 连通标记（行程编码 + 并查集），只遍历有墨迹的行。\n\n    返回 (labels, count)；labels 为 int32，背景为 0。\n    \"\"\"\n    h, w = mask.shape\n    parent = []\n\n    def find(a):\n        root = a\n        while parent[root] != root:\n            root = parent[root]\n        while parent[a] != root:\n            parent[a], a = root, parent[a]\n        return root\n\n    def union(a, b):\n        ra, rb = find(a), find(b)\n        if ra != rb:\n            parent[rb] = ra\n\n    runs = []          # 每行 (starts, ends, ids)；无墨迹的行为 None\n    for y in range(h):\n        row = mask[y]\n        cols = np.flatnonzero(row)\n        if cols.size == 0:\n            runs.append(None)\n            continue\n        cuts = np.flatnonzero(np.diff(cols) > 1)\n        starts = cols[np.concatenate(([0], cuts + 1))]\n        ends = cols[np.concatenate((cuts, [cols.size - 1]))]\n        n = starts.size\n        ids = np.arange(len(parent), len(parent) + n, dtype=np.int64)\n        parent.extend(range(len(parent), len(parent) + n))\n        runs.append((starts, ends, ids))\n        if y == 0:\n            continue\n        prev = runs[y - 1]\n        if prev is None:\n            continue\n        ps, pe, pids = prev\n        i = j = 0\n        n_prev = ps.size\n        while i < n_prev and j < n:\n            if pe[i] < starts[j] - 1:\n                i += 1\n            elif ends[j] < ps[i] - 1:\n                j += 1\n            else:\n                union(int(pids[i]), int(ids[j]))\n                if pe[i] < ends[j]:\n                    i += 1\n                else:\n                    j += 1\n\n    roots = {}\n    labels = np.zeros((h, w), dtype=np.int32)\n    for y in range(h):\n        item = runs[y]\n        if item is None:\n            continue\n        starts, ends, ids = item\n        names = np.empty(ids.size, dtype=np.int32)\n        for k in range(ids.size):\n            r = find(int(ids[k]))\n            lab = roots.get(r)\n            if lab is None:\n                lab = len(roots) + 1\n                roots[r] = lab\n            names[k] = lab\n        row = labels[y]\n        for k in range(starts.size):\n            row[starts[k]:ends[k] + 1] = names[k]\n    return labels, len(roots)\n\n\ndef _component_stats(labels, nlab):\n    \"\"\"用 bincount 统计每个连通域的像素数与包围盒（避免逐标签扫描）。\"\"\"\n    h, w = labels.shape\n    flat = labels.reshape(-1)\n    counts = np.bincount(flat, minlength=nlab + 1)\n    ys, xs = np.divmod(np.arange(flat.size, dtype=np.int64), w)\n    nz = flat > 0\n    idx = flat[nz]\n    minx = np.full(nlab + 1, w, dtype=np.int64)\n    miny = np.full(nlab + 1, h, dtype=np.int64)\n    maxx = np.full(nlab + 1, -1, dtype=np.int64)\n    maxy = np.full(nlab + 1, -1, dtype=np.int64)\n    np.minimum.at(minx, idx, xs[nz])\n    np.minimum.at(miny, idx, ys[nz])\n    np.maximum.at(maxx, idx, xs[nz])\n    np.maximum.at(maxy, idx, ys[nz])\n    return counts, minx, miny, maxx, maxy\n\n\n# ---------------------------------------------------------------- 区域检测\n\ndef _adaptive_mask(gray, win):\n    \"\"\"局部自适应二值化：局部均值 - 偏置。返回 (mask, local_mean)。\"\"\"\n    g = gray.astype(np.float32)\n    ii = np.zeros((gray.shape[0] + 1, gray.shape[1] + 1), dtype=np.float64)\n    ii[1:, 1:] = np.cumsum(np.cumsum(g, axis=0), axis=1)\n    ys = np.arange(gray.shape[0])\n    xs = np.arange(gray.shape[1])\n    y0 = np.clip(ys - win, 0, gray.shape[0])[:, None]\n    y2 = np.clip(ys + win + 1, 0, gray.shape[0])[:, None]\n    x0 = np.clip(xs - win, 0, gray.shape[1])[None, :]\n    x2 = np.clip(xs + win + 1, 0, gray.shape[1])[None, :]\n    s = ii[y2, x2] - ii[y0, x2] - ii[y2, x0] + ii[y0, x0]\n    area = np.maximum(1, (y2 - y0) * (x2 - x0))\n    mean = (s / area).astype(np.float32)\n    return (g < mean - 6.0), mean\n\n\ndef _ink_ratio(gray, x0, y0, x1, y1, lmean):\n    \"\"\"盒内「比局部均值明显更暗」像素占比，作为墨迹密度。\"\"\"\n    h, w = gray.shape\n    x0 = max(0, min(w, int(x0)))\n    x1 = max(0, min(w, int(x1)))\n    y0 = max(0, min(h, int(y0)))\n    y1 = max(0, min(h, int(y1)))\n    if x1 <= x0 or y1 <= y0:\n        return 0.0\n    sub = gray[y0:y1, x0:x1]\n    lm = lmean[y0:y1, x0:x1]\n    return float(np.count_nonzero(sub < lm - 6.0)) / float(sub.size)\n\n\ndef _infer_kind(gray, x0, y0, x1, y1, shape):\n    \"\"\"启发式判定 kind（区域检测不依赖 OCR，只能给出粗分类）：\n    bubble = 大块且极亮（白底气泡/对话框，字少留白多）；\n    art    = 大号文字块（含描边艺术字）；\n    其余为 text。\n    \"\"\"\n    h, w = gray.shape\n    x0 = max(0, min(w - 1, int(x0))); x1 = max(x0 + 1, min(w, int(x1)))\n    y0 = max(0, min(h - 1, int(y0))); y1 = max(y0 + 1, min(h, int(y1)))\n    sub = gray[y0:y1, x0:x1]\n    if sub.size == 0:\n        return 'text'\n    bright = float(np.count_nonzero(sub > 200)) / float(sub.size)\n    bh = y1 - y0\n    if bh >= 34 and bright >= 0.75:\n        return 'bubble'\n    if bh >= 34 and bright < 0.92:\n        return 'art'\n    return 'text'\n\n\ndef detect_regions(im, hint='text', min_area=30, max_regions=60, max_dim=1600,\n                   read_order='rtl'):\n    \"\"\"检测文本区域。返回 (regions, scale, det_shape)。\"\"\"\n    ow, oh = im.size\n    scale = 1.0\n    if max_dim and max(ow, oh) > max_dim:\n        scale = float(max_dim) / float(max(ow, oh))\n    dw = max(1, int(round(ow * scale)))\n    dh = max(1, int(round(oh * scale)))\n    det = im.convert('L')\n    if (dw, dh) != (ow, oh):\n        det = det.resize((dw, dh), Image.LANCZOS)\n    gray = np.asarray(det, dtype=np.uint8)\n\n    win = 10\n    mask, lmean = _adaptive_mask(gray, win)\n\n    if hint == 'bubble':\n        mask = dilate(mask, 1)\n        mask = _erode3(mask)\n        mask = dilate(mask, 5)\n        mask = erode(mask, 4)\n        mask = dilate(mask, 4)\n    elif hint == 'art':\n        mask = dilate(mask, 1)\n        mask = erode(mask, 1)\n        mask = dilate(mask, 7)\n        mask = erode(mask, 3)\n        mask = dilate(mask, 6)\n    else:\n        mask = dilate(mask, 1)\n        mask = _erode3(mask)\n        mask = dilate(mask, 5)\n        mask = erode(mask, 2)\n        mask = dilate(mask, 5)\n\n    if not mask.any():\n        return [], scale, (dw, dh)\n\n    labels, nlab = connected_components(mask)\n    counts, minx, miny, maxx, maxy = _component_stats(labels, nlab)\n\n    min_h = 6 if hint == 'art' else 5\n    min_w = 4\n    max_w = 0.94 * dw\n    max_h = (0.62 if hint == 'art' else 0.42) * dh\n    max_aspect = 40.0\n\n    cands = []\n    for idx in range(1, nlab + 1):\n        count = int(counts[idx])\n        if count < min_area or maxx[idx] < 0:\n            continue\n        x0 = int(minx[idx]); x1 = int(maxx[idx]) + 1\n        y0 = int(miny[idx]); y1 = int(maxy[idx]) + 1\n        bw = x1 - x0\n        bh = y1 - y0\n        if bw < min_w or bh < min_h:\n            continue\n        if bw > max_w or bh > max_h:\n            continue\n        aspect = bw / float(bh)\n        if aspect > max_aspect or aspect < 1.0 / max_aspect:\n            continue\n        ink = _ink_ratio(gray, x0, y0, x1, y1, lmean)\n        if ink < 0.02:\n            continue\n        cands.append((x0, y0, x1, y1, ink))\n\n    # 合并同行的邻近连通域 → 文本行 / 文本块\n    cands.sort(key=lambda b: (b[1], b[0]))\n    merged = []\n    for b in cands:\n        x0, y0, x1, y1, ink = b\n        placed = False\n        for i, m in enumerate(merged):\n            my0, my1 = m[1], m[3]\n            ov = min(y1, my1) - max(y0, my0)\n            if ov <= 0:\n                continue\n            hmin = min(y1 - y0, my1 - my0)\n            if ov < 0.5 * hmin:\n                continue\n            gap = max(x0 - m[2], m[0] - x1)\n            if gap > 1.2 * max(hmin, 8):\n                continue\n            bw_o = m[2] - m[0]\n            bw_n = x1 - x0\n            # 断开量级差异过大的块（例如整幅标题 vs 单个气泡）\n            if max(bw_o, bw_n) > 4.0 * max(1, min(bw_o, bw_n)) and gap > 12:\n                continue\n            area_old = (m[2] - m[0]) * (m[3] - m[1])\n            area_new = (x1 - x0) * (y1 - y0)\n            if max(area_old, area_new) / float(max(1, min(area_old, area_new))) > 24:\n                continue\n            merged[i] = (min(m[0], x0), min(m[1], y0), max(m[2], x1), max(m[3], y1),\n                         (m[4] * area_old + ink * area_new) / float(area_old + area_new))\n            placed = True\n            break\n        if not placed:\n            merged.append((x0, y0, x1, y1, ink))\n\n    # 投影切分：块内出现足够宽的空白带时拆成多个区域（气泡之间、多列之间）\n    def split_axis(box, axis, depth):\n        bx0, by0, bx1, by1, _bk = box\n        if depth <= 0:\n            return [box]\n        sub = mask[by0:by1, bx0:bx1]\n        if sub.size == 0:\n            return [box]\n        if axis == 'x':\n            proj = sub.any(axis=0)\n            thresh = max(6, int(0.6 * (by1 - by0)))\n        else:\n            proj = sub.any(axis=1)\n            thresh = max(6, int(0.6 * (bx1 - bx0)))\n        n = proj.size\n        i = 0\n        pieces = []\n        while i < n:\n            if proj[i]:\n                s = i\n                while i < n and proj[i]:\n                    i += 1\n                e = i\n                if pieces and (s - pieces[-1][1]) >= thresh:\n                    pieces.append([s, e])\n                elif pieces:\n                    pieces[-1][1] = e\n                else:\n                    pieces.append([s, e])\n            else:\n                i += 1\n        if len(pieces) < 2:\n            return [box]\n        out_boxes = []\n        for s, e in pieces:\n            if axis == 'x':\n                nb = (bx0 + s, by0, bx0 + e, by1, 0.0)\n            else:\n                nb = (bx0, by0 + s, bx1, by0 + e, 0.0)\n            if (nb[2] - nb[0]) < 3 or (nb[3] - nb[1]) < 3:\n                continue\n            out_boxes.append(split_axis(nb, 'y' if axis == 'x' else 'x', depth - 1))\n        flat = [b for grp in out_boxes for b in grp]\n        return flat if flat else [box]\n\n    split_boxes = []\n    for m in merged:\n        split_boxes.extend(split_axis(m, 'x', 2))\n\n    # 切分后再补一轮重叠合并（只合并明显重叠的）\n    changed = True\n    while changed and len(split_boxes) > 1:\n        changed = False\n        out = []\n        for b in split_boxes:\n            hit = -1\n            for i, m in enumerate(out):\n                ov_y = min(b[3], m[3]) - max(b[1], m[1])\n                ov_x = min(b[2], m[2]) - max(b[0], m[0])\n                if ov_y > 0 and ov_x > 0.3 * min(b[2] - b[0], m[2] - m[0]):\n                    hit = i\n                    break\n            if hit < 0:\n                out.append(b)\n            else:\n                m = out[hit]\n                out[hit] = (min(m[0], b[0]), min(m[1], b[1]), max(m[2], b[2]),\n                            max(m[3], b[3]), max(m[4], b[4]))\n                changed = True\n        split_boxes = out\n    merged = []\n    for b in split_boxes:\n        ink = _ink_ratio(gray, b[0], b[1], b[2], b[3], lmean)\n        if ink < 0.02:\n            continue\n        bw = b[2] - b[0]\n        bh = b[3] - b[1]\n        if bw > max_w or bh > max_h:\n            continue\n        merged.append((b[0], b[1], b[2], b[3], ink))\n\n    inv = 1.0 / scale if scale else 1.0\n    regions = []\n    for x0, y0, x1, y1, ink in merged:\n        ox0 = int(round(x0 * inv)); oy0 = int(round(y0 * inv))\n        ox1 = int(round(x1 * inv)); oy1 = int(round(y1 * inv))\n        ox0 = max(0, min(ow - 1, ox0)); oy0 = max(0, min(oh - 1, oy0))\n        ox1 = max(ox0 + 1, min(ow, ox1)); oy1 = max(oy0 + 1, min(oh, oy1))\n        kind = _infer_kind(gray, x0, y0, x1, y1, (dw, dh))\n        if hint in ('bubble', 'art', 'text') and hint != 'text':\n            # hint 只是倾向，不强行覆盖启发式判定结果\n            pass\n        regions.append({'x': ox0, 'y': oy0, 'w': ox1 - ox0, 'h': oy1 - oy0,\n                        'kind': kind, 'ink': round(float(ink), 4)})\n\n    # 阅读顺序：上→下分行，行内漫画风右→左（rtl）或左→右（ltr）\n    regions.sort(key=lambda r: (r['y'], -r['x'] if read_order != 'ltr' else r['x']))\n    lines = []\n    for r in regions:\n        cy = r['y'] + r['h'] / 2.0\n        placed = False\n        for ln in lines:\n            ref = ln[0]\n            if abs(cy - (ref['y'] + ref['h'] / 2.0)) <= 0.6 * max(ref['h'], r['h']):\n                ln.append(r)\n                placed = True\n                break\n        if not placed:\n            lines.append([r])\n    lines.sort(key=lambda ln: min(r['y'] for r in ln))\n    final = []\n    for ln in lines:\n        ln.sort(key=lambda r: -r['x'] if read_order != 'ltr' else r['x'])\n        final.extend(ln)\n\n    if max_regions and len(final) > max_regions:\n        # 按面积优先保留，再恢复阅读顺序\n        keep = sorted(final, key=lambda r: -(r['w'] * r['h']))[:max_regions]\n        ids = {id(r) for r in keep}\n        final = [r for r in final if id(r) in ids]\n    return final, scale, (dw, dh)\n\n\n# ---------------------------------------------------------------- 擦除\n\ndef _region_array(im_rgba, x0, y0, x1, y1):\n    arr = np.asarray(im_rgba, dtype=np.uint8)\n    x0 = max(0, min(arr.shape[1], int(np.floor(x0))))\n    x1 = max(0, min(arr.shape[1], int(np.ceil(x1))))\n    y0 = max(0, min(arr.shape[0], int(np.floor(y0))))\n    y1 = max(0, min(arr.shape[0], int(np.ceil(y1))))\n    if x1 < x0:\n        x0, x1 = x1, x0\n    if y1 < y0:\n        y0, y1 = y1, y0\n    return arr[y0:y1, x0:x1], (x0, y0, x1, y1)\n\n\ndef rect_bounds(im, box):\n    \"\"\"把 [x,y,w,h] 裁剪到图像范围内，返回整数 (x0,y0,x1,y1)。\"\"\"\n    W, H = im.size\n    x0 = max(0, min(W, int(np.floor(box[0]))))\n    y0 = max(0, min(H, int(np.floor(box[1]))))\n    x1 = max(0, min(W, int(np.ceil(box[0] + box[2]))))\n    y1 = max(0, min(H, int(np.ceil(box[1] + box[3]))))\n    if x1 < x0:\n        x0, x1 = x1, x0\n    if y1 < y0:\n        y0, y1 = y1, y0\n    return x0, y0, x1, y1\n\n\ndef ring_color(im_rgba, box, pad=0.0, ring=4):\n    \"\"\"采样框外一圈像素，返回主色（中位数）。\"\"\"\n    arr, (x0, y0, x1, y1) = _region_array(im_rgba,\n                                          box[0] - pad - ring, box[1] - pad - ring,\n                                          box[0] + box[2] + pad + ring,\n                                          box[1] + box[3] + pad + ring)\n    h, w = arr.shape[:2]\n    if h < 1 or w < 1:\n        return None\n    rin = max(1, int(ring))\n    top = arr[:min(rin, h), :, :3].reshape(-1, 3)\n    bot = arr[max(0, h - rin):h, :, :3].reshape(-1, 3)\n    lef = arr[:, :min(rin, w), :3].reshape(-1, 3)\n    rig = arr[:, max(0, w - rin):w, :3].reshape(-1, 3)\n    px = np.concatenate([top, bot, lef, rig], axis=0)\n    if px.size == 0:\n        return None\n    px = px.astype(np.float32)\n    med = np.median(px, axis=0)\n    # 圈内可能混入被截断的墨迹，取与中位数接近的像素再求一次中位数\n    keep = np.abs(px - med.reshape(1, 3)).max(axis=1) < 60\n    if np.count_nonzero(keep) >= max(8, px.shape[0] // 20):\n        med = np.median(px[keep], axis=0)\n    return med\n\n\ndef _bg_fill_array(arr, tol=34, cell=16):\n    \"\"\"估计框内的背景色图：把框按 cell 降采样，只保留背景像素，再平滑放大回来。\n\n    这样擦除大字/渐变底时能保留底色与渐变，而不是糊成一块纯色。\n    \"\"\"\n    h, w = arr.shape[:2]\n    rgb = arr[:, :, :3].astype(np.float32)\n    med = np.median(rgb.reshape(-1, 3), axis=0)\n    ink = np.abs(rgb - med.reshape(1, 1, 3)).max(axis=2) > tol\n    cw = max(1, int(np.ceil(w / float(cell))))\n    ch = max(1, int(np.ceil(h / float(cell))))\n    coarse = np.zeros((ch, cw, 3), dtype=np.uint8)\n    has = np.zeros((ch, cw), dtype=bool)\n    for cy in range(ch):\n        for cx in range(cw):\n            blk = rgb[cy * cell:(cy + 1) * cell, cx * cell:(cx + 1) * cell]\n            m = ~ink[cy * cell:(cy + 1) * cell, cx * cell:(cx + 1) * cell]\n            if blk.size == 0:\n                continue\n            if m.any():\n                coarse[cy, cx] = np.median(blk[m], axis=0).astype(np.uint8)\n                has[cy, cx] = True\n            else:\n                coarse[cy, cx] = med.astype(np.uint8)\n                has[cy, cx] = False\n    if not has.any():\n        return None\n    # 背景格的最近邻距离（以格为单位），没有背景的格子沿用最近背景色\n    ys, xs = np.nonzero(has)\n    gy, gx = np.mgrid[0:ch, 0:cw]\n    d2 = None\n    for k in range(ys.size):\n        dd = (gy - ys[k]) ** 2 + (gx - xs[k]) ** 2\n        d2 = dd if d2 is None else np.minimum(d2, dd)\n    order = np.argsort(d2, axis=None)\n    fy, fx = np.unravel_index(order, d2.shape)\n    filled = coarse[fy, fx]           # 每个格取最近的背景格颜色\n    filled = filled.reshape(ch, cw, 3)\n    im = Image.fromarray(filled, 'RGB')\n    if (cw, ch) != (w, h):\n        im = im.resize((w, h), Image.BILINEAR)\n    return np.asarray(im, dtype=np.float32), np.sqrt(d2)\n\n\ndef erase_fill(im_rgba, box, color, tol=34, grow=1):\n    \"\"\"把框内与背景差异大的像素（原文墨迹）替换成背景色，返回改动量。\"\"\"\n    arr, (x0, y0, x1, y1) = _region_array(im_rgba, box[0], box[1],\n                                          box[0] + box[2], box[1] + box[3])\n    if arr.size == 0:\n        return 0\n    c = np.asarray(color, dtype=np.int16).reshape(1, 1, 3)\n    diff = np.abs(arr[:, :, :3].astype(np.int16) - c).max(axis=2)\n    m = diff > tol\n    if arr.shape[2] == 4:\n        m |= arr[:, :, 3] > 8\n    if grow > 0:\n        m = dilate(m, grow)\n    if not m.any():\n        return 0\n    new = arr.copy()\n    bg = _bg_fill_array(arr, tol)\n    if bg is not None:\n        fill, dist = bg\n        # 距离背景格过远（大块实心墨迹）的地方用圈外主色兜底\n        fallback = np.asarray(color, dtype=np.float32).reshape(1, 1, 3)\n        far = dist > 2.5\n        if far.any():\n            up = np.asarray(Image.fromarray(\n                (far * 255).astype(np.uint8), 'L').resize(\n                (arr.shape[1], arr.shape[0]), Image.NEAREST)) > 127\n            fill = np.where(up[:, :, None], fallback, fill)\n        # 整块背景过于均匀时，说明框附近本来就没有可用底色，退回圈外主色\n        if float(fill.reshape(-1, 3).std(axis=0).max()) < 0.5:\n            fill = np.broadcast_to(fallback, fill.shape)\n        px = np.clip(fill, 0, 255).astype(np.uint8)\n    else:\n        px = np.broadcast_to(np.asarray(color, dtype=np.uint8).reshape(1, 1, 3),\n                             (arr.shape[0], arr.shape[1], 3))\n    new[:, :, 0][m] = px[:, :, 0][m]\n    new[:, :, 1][m] = px[:, :, 1][m]\n    new[:, :, 2][m] = px[:, :, 2][m]\n    if new.shape[2] == 4:\n        new[:, :, 3][m] = 255\n    im_rgba.paste(Image.fromarray(new, 'RGBA'), (x0, y0))\n    return int(np.count_nonzero(m))\n\n\ndef rect_fill(im_rgba, box, color):\n    x0, y0, x1, y1 = rect_bounds(im_rgba, box)\n    if x1 <= x0 or y1 <= y0:\n        return\n    patch = Image.new('RGBA', (x1 - x0, y1 - y0), tuple(int(c) for c in color) + (255,))\n    im_rgba.paste(patch, (x0, y0))\n\n\ndef ink_snapshot(im_rgba, box, bg, tol=34):\n    \"\"\"统计框内与背景色差异大的像素数（用于判新旧墨迹）。\"\"\"\n    arr, _ = _region_array(im_rgba, box[0], box[1], box[0] + box[2], box[1] + box[3])\n    if arr.size == 0:\n        return 0, 0\n    c = np.asarray(bg, dtype=np.int16).reshape(1, 1, 3)\n    diff = np.abs(arr[:, :, :3].astype(np.int16) - c).max(axis=2)\n    return int(np.count_nonzero(diff > tol)), int(arr.shape[0] * arr.shape[1])\n\n\n# ---------------------------------------------------------------- 排版：断行 / 自动字号\n\n_CJK_RE = re.compile(\n    '[\\u1100-\\u11ff\\u2e80-\\u303f\\u3040-\\u30ff\\u3130-\\u318f\\u31c0-\\u31ef'\n    '\\u3400-\\u4dbf\\u4e00-\\u9fff\\ua960-\\ua97f\\uac00-\\ud7ff\\uf900-\\ufaff'\n    '\\ufe30-\\ufe4f\\uff00-\\uffef]')\n_WS_RE = re.compile(r'\\s+')\n\n\ndef _is_cjk(ch):\n    return bool(_CJK_RE.match(ch))\n\n\ndef tokens_of(text):\n    \"\"\"最小排版单元：CJK 单字成 token，拉丁按词，空白单独成 token。\"\"\"\n    toks = []\n    buf = []\n    for ch in text:\n        if ch in '\\r\\n':\n            continue\n        if _is_cjk(ch):\n            if buf:\n                toks.append(('w', ''.join(buf))); buf = []\n            toks.append(('c', ch))\n        elif ch.isspace():\n            if buf:\n                toks.append(('w', ''.join(buf))); buf = []\n            toks.append(('s', ' '))\n        elif ord(ch) < 32:\n            continue\n        else:\n            buf.append(ch)\n    if buf:\n        toks.append(('w', ''.join(buf)))\n    return toks\n\n\ndef _tw(font, s):\n    try:\n        return float(font.getlength(s))\n    except Exception:\n        return float(font.getsize(s)[0])\n\n\ndef layout_lines(text, font, max_w):\n    \"\"\"按框宽断行。返回 (行文本列表, 每行宽, 每行高)。\"\"\"\n    toks = tokens_of(text)\n    lines = []\n    cur = []\n    cur_w = 0.0\n    for kind, s in toks:\n        if kind == 's' and not cur:\n            continue  # 行首空白丢弃\n        tw = _tw(font, s)\n        if kind == 's':\n            if cur_w + tw > max_w:\n                lines.append(''.join(cur)); cur = []; cur_w = 0.0\n                continue\n            cur.append(s); cur_w += tw\n            continue\n        if cur_w + tw > max_w and cur:\n            # 拉丁词放不下时，若当前行末尾是空白则先去掉再换行\n            while cur and cur[-1] == ' ':\n                cur.pop()\n            lines.append(''.join(cur)); cur = []; cur_w = 0.0\n        cur.append(s)\n        cur_w += tw\n    if cur:\n        while cur and cur[-1] == ' ':\n            cur.pop()\n        if cur:\n            lines.append(''.join(cur))\n    if not lines:\n        lines = ['']\n    widths = [_tw(font, ln) for ln in lines]\n    _, descent = font.getmetrics()\n    bbox_h = [_glyph_h(font, ln, descent) for ln in lines]\n    return lines, widths, bbox_h\n\n\ndef _glyph_h(font, line, descent):\n    if not line:\n        return float(font.getmetrics()[0] + descent)\n    try:\n        l, t, r, b = font.getbbox(line)\n        return float(max(1, b - t))\n    except Exception:\n        a, d = font.getmetrics()\n        return float(a + d)\n\n\ndef measure_layout(text, font, max_w, max_h, line_spacing=1.15, stroke_w=0):\n    \"\"\"测量某个字号能否放进框。返回 dict。\"\"\"\n    sw = max(0.0, float(stroke_w or 0))\n    avail_w = max(1.0, max_w - sw)\n    avail_h = max(1.0, max_h - sw)\n    lines, widths, heights = layout_lines(text, font, avail_w)\n    asc, desc = font.getmetrics()\n    lead = max(1.0, float(line_spacing) * (asc + desc))\n    total = lead * (len(lines) - 1) + (heights[-1] if lines else lead) + sw\n    widest = max(widths) if widths else 0.0\n    return {\n        'lines': lines,\n        'n': len(lines),\n        'widest': widest,\n        'widths': widths,\n        'heights': heights,\n        'asc': asc,\n        'desc': desc,\n        'lead': lead,\n        'total': total,\n        'fits': bool(widest <= avail_w + 0.5 and total <= avail_h + 0.5),\n    }\n\n\ndef fit_font(text, font_path, box_w, box_h, max_size, min_size=8,\n             line_spacing=1.15, stroke_w=0):\n    \"\"\"从 max_size 递减到 min_size 找第一个放得下的字号。\n\n    都不放下时返回最小字号（min_size）的布局，调用方据此报 fits:false。\n    \"\"\"\n    top = max(int(min_size), int(max_size))\n    fallback = None\n    for size in range(top, int(min_size) - 1, -1):\n        font = load_font(font_path, size)\n        lay = measure_layout(text, font, box_w, box_h, line_spacing, stroke_w)\n        lay['size'] = size\n        lay['font'] = font\n        if lay['fits']:\n            return lay\n        if size == int(min_size):\n            fallback = lay\n    if fallback is not None:\n        return fallback\n    font = load_font(font_path, int(min_size))\n    lay = measure_layout(text, font, box_w, box_h, line_spacing, stroke_w)\n    lay['size'] = int(min_size)\n    lay['font'] = font\n    return lay\n\n\ndef draw_text_block(im_rgba, box, lay, color, stroke_color, stroke_w, align, valign):\n    \"\"\"按布局把文本画进框；返回是否全部落在框内。\"\"\"\n    x = float(box[0]); y = float(box[1]); w = float(box[2]); h = float(box[3])\n    lines = lay['lines']\n    lead = lay['lead']\n    sw = max(0.0, float(stroke_w or 0))\n    asc = lay['asc']\n    total = lay['total']\n    if valign == 'bottom':\n        first = y + h - total + sw / 2.0\n    elif valign == 'middle':\n        first = y + (h - total) / 2.0 + sw / 2.0\n    else:\n        first = y + sw / 2.0\n    layer = Image.new('RGBA', im_rgba.size, (0, 0, 0, 0))\n    dr = ImageDraw.Draw(layer)\n    fit = True\n    for i, ln in enumerate(lines):\n        if not ln:\n            continue\n        lw = lay['widths'][i]\n        if align == 'center':\n            lx = x + (w - lw) / 2.0\n        elif align == 'right':\n            lx = x + (w - lw - sw / 2.0)\n        else:\n            lx = x + sw / 2.0\n        base_y = first + i * lead\n        # 单行超宽（例如整段无断点的长词）→ fits:false\n        if lw > w + 0.5 or base_y + lay['heights'][i] > y + h + 1.0:\n            fit = False\n        dr.text((lx + sw, base_y + sw), ln, font=lay['font'], fill=tuple(color) + (255,),\n                stroke_width=int(round(sw)), stroke_fill=tuple(stroke_color) + (255,))\n    im_rgba.alpha_composite(layer)\n    return fit\n\n\n# ---------------------------------------------------------------- 各 op 实现\n\ndef op_probe(payload):\n    import PIL\n    fonts = report_fonts()\n    return {\n        'ok': True,\n        'python': '%d.%d' % (sys.version_info[0], sys.version_info[1]),\n        'pythonFull': sys.version.split()[0],\n        'pillow': getattr(PIL, '__version__', '?'),\n        'numpy': np.__version__,\n        'fonts': fonts,\n        'fontDir': FONT_DIR,\n    }\n\n\ndef op_regions(payload):\n    images = payload.get('images')\n    _require(isinstance(images, list) and images, 'images 必须是非空数组')\n    min_area = _int(payload.get('minArea'), 30, 'minArea')\n    max_regions = _int(payload.get('maxRegions'), 60, 'maxRegions') or 60\n    max_dim = _int(payload.get('maxDim'), 1600, 'maxDim') or 1600\n    read_order = _s(payload.get('readOrder'), 'rtl')\n    results = []\n    for item in images:\n        _require(isinstance(item, dict), 'images 元素必须是对象')\n        path = item.get('path')\n        im = load_image(path)\n        hint = _s(item.get('hint'), 'text')\n        _require(hint in ('text', 'bubble', 'art'), '不支持的 hint：%s' % hint)\n        regs, scale, det = detect_regions(im, hint, min_area, max_regions, max_dim,\n                                          read_order)\n        log('regions %s hint=%s det=%dx%d scale=%.3f -> %d'\n            % (path, hint, det[0], det[1], scale, len(regs)))\n        results.append({\n            'path': path,\n            'width': im.size[0],\n            'height': im.size[1],\n            'hint': hint,\n            'detectWidth': det[0],\n            'detectHeight': det[1],\n            'regions': regs,\n        })\n    return {'ok': True, 'results': results}\n\n\ndef op_crop(payload):\n    items = payload.get('items')\n    _require(isinstance(items, list) and items, 'items 必须是非空数组')\n    files = []\n    for it in items:\n        _require(isinstance(it, dict), 'items 元素必须是对象')\n        path = it.get('path')\n        box = _box4(it.get('box'))\n        _require(box[2] > 0 and box[3] > 0, '空框（w/h 必须 > 0）：%r' % (box,))\n        out = it.get('out')\n        _require(isinstance(out, str) and out, 'out 必须是非空字符串')\n        im = load_image(path)\n        W, H = im.size\n        x0 = max(0, int(np.floor(box[0])))\n        y0 = max(0, int(np.floor(box[1])))\n        x1 = min(W, int(np.ceil(box[0] + box[2])))\n        y1 = min(H, int(np.ceil(box[1] + box[3])))\n        _require(x1 > x0 and y1 > y0, '框与图像无交集：%r 图像 %dx%d' % (box, W, H))\n        crop = im.crop((x0, y0, x1, y1))\n        scale = it.get('scale')\n        if scale is not None:\n            s = _num(scale, 1.0, 'scale')\n            _require(s > 0, 'scale 必须 > 0')\n            nw = max(1, int(round(crop.size[0] * s)))\n            nh = max(1, int(round(crop.size[1] * s)))\n            crop = crop.resize((nw, nh), Image.LANCZOS)\n        odir = os.path.dirname(os.path.abspath(out))\n        if odir:\n            os.makedirs(odir, exist_ok=True)\n        crop.save(out)\n        files.append({'out': out, 'w': crop.size[0], 'h': crop.size[1],\n                      'source': {'x': x0, 'y': y0, 'w': x1 - x0, 'h': y1 - y0}})\n    return {'ok': True, 'files': files}\n\n\ndef _is_latin_only(text):\n    for ch in text:\n        if ord(ch) > 0x250 or _is_cjk(ch):\n            return False\n    return True\n\n\ndef op_typeset(payload):\n    items = payload.get('items')\n    _require(isinstance(items, list) and items, 'items 必须是非空数组')\n    files = []\n    for it in items:\n        _require(isinstance(it, dict), 'items 元素必须是对象')\n        path = it.get('path')\n        out = it.get('out')\n        _require(isinstance(out, str) and out, 'out 必须是非空字符串')\n        _require(os.path.isfile(path or ''), '图像不存在：%s' % path)\n        ops = it.get('ops')\n        _require(isinstance(ops, list) and ops, 'ops 必须是非空数组')\n\n        src = load_image(path)\n        src_mode = src.mode\n        im = to_rgba(src).copy()\n        W, H = im.size\n        report = []\n        for k, o in enumerate(ops):\n            _require(isinstance(o, dict), 'ops[%d] 必须是对象' % k)\n            box = _box4(o.get('box'), 'ops[%d].box' % k)\n            text = _s(o.get('text'), '')\n            style = o.get('style') or {}\n            _require(isinstance(style, dict), 'ops[%d].style 必须是对象' % k)\n            if not text:\n                report.append({'box': box, 'fontSize': 0, 'lines': 0, 'fits': True,\n                               'skipped': 'empty text'})\n                continue\n            cx0, cy0, cx1, cy1 = rect_bounds(im, box)\n            _require(cx1 > cx0 and cy1 > cy0, 'ops[%d] 的框与图像无交集' % k)\n            x, y = float(cx0), float(cy0)\n            w, h = float(cx1 - cx0), float(cy1 - cy0)\n\n            align = _s(style.get('align'), 'left')\n            valign = _s(style.get('valign'), 'top')\n            _require(align in ('left', 'center', 'right'), '不支持的 align：%s' % align)\n            _require(valign in ('top', 'middle', 'bottom'), '不支持的 valign：%s' % valign)\n            color = _rgb(style.get('color'), (0, 0, 0), 'color')\n            stroke_color = _rgb(style.get('stroke'), (255, 255, 255), 'stroke')\n            stroke_w = max(0.0, _num(style.get('strokeWidth'), 0, 'strokeWidth'))\n            line_spacing = _num(style.get('lineSpacing'), 1.15, 'lineSpacing')\n            _require(line_spacing > 0, 'lineSpacing 必须 > 0')\n            pad = max(0.0, _num(style.get('padding'), 2, 'padding'))\n            erase = _s(style.get('erase'), 'auto')\n            _require(erase in ('auto', 'rect', 'none'), '不支持的 erase：%s' % erase)\n            erase_color = _rgb(style.get('eraseColor'), (255, 255, 255), 'eraseColor')\n            font_size_req = style.get('fontSize')\n            max_font = _int(style.get('maxFontSize'), None, 'maxFontSize')\n\n            box2 = [x, y, w, h]\n            ring = max(2, min(6, int(round(min(w, h) * 0.06))))\n            bg = ring_color(im, box2, pad, ring)\n            if bg is None:\n                bg = np.array(erase_color, dtype=np.float64)\n            fill_color = erase_color if erase == 'rect' else tuple(int(c) for c in bg)\n            old_ink, box_px = ink_snapshot(im, box2, fill_color)\n\n            erased = 0\n            if erase == 'rect':\n                rect_fill(im, box2, fill_color)\n                erased = box_px\n            elif erase == 'auto':\n                erased = erase_fill(im, box2, fill_color, 34, 1)\n            new_ink0, _ = ink_snapshot(im, box2, fill_color)\n\n            need_cjk = not _is_latin_only(text)\n            font_path = pick_font(need_cjk=need_cjk, explicit=style.get('fontPath'))\n            avail_w = max(1.0, w - pad * 2 - stroke_w)\n            avail_h = max(1.0, h - pad * 2 - stroke_w)\n            if font_size_req is not None:\n                size_req = max(1, _int(font_size_req, 0, 'fontSize'))\n                font = load_font(font_path, size_req)\n                lay = measure_layout(text, font, avail_w, avail_h, line_spacing, stroke_w)\n                lay['size'] = size_req\n                lay['font'] = font\n                top = size_req\n            else:\n                top = int(max(1, min(max_font or int(h - pad * 2), int(h - pad * 2))))\n                lay = fit_font(text, font_path, avail_w, avail_h, top, 8,\n                               line_spacing, stroke_w)\n\n            fits = bool(lay.get('fits'))\n            if fits is None:\n                fits = False\n            inner = [x + pad, y + pad, max(1.0, w - pad * 2), max(1.0, h - pad * 2)]\n            drawn = draw_text_block(im, inner, lay, color, stroke_color, stroke_w,\n                                    align, valign)\n            new_ink, _ = ink_snapshot(im, box2, fill_color)\n            report.append({\n                'box': [x, y, w, h],\n                'fontSize': int(lay.get('size', 0)),\n                'lines': int(lay.get('n', 0)),\n                'fits': bool(fits and drawn),\n                'font': font_path,\n                'eraseColor': [int(c) for c in fill_color],\n                'erasedPixels': int(erased),\n                'inkBefore': int(old_ink),\n                'inkAfterErase': int(new_ink0),\n                'inkFinal': int(new_ink),\n                'lineWidths': [round(float(v), 1) for v in lay.get('widths', [])],\n            })\n            log('typeset %s box=%s size=%d lines=%d fits=%s'\n                % (os.path.basename(out), [round(v) for v in box2],\n                   report[-1]['fontSize'], report[-1]['lines'], report[-1]['fits']))\n\n        odir = os.path.dirname(os.path.abspath(out))\n        if odir:\n            os.makedirs(odir, exist_ok=True)\n        ext = os.path.splitext(out)[1].lower()\n        save_im = im\n        if ext in ('.jpg', '.jpeg'):\n            pass                      # save_like 会自动合成白底并去 alpha\n        elif ext in ('.png', '.webp', '.bmp'):\n            if src_mode in ('L', 'LA'):\n                save_im = im.convert('LA' if src_mode == 'LA' else 'L')\n            elif src_mode == 'RGB':\n                save_im = im.convert('RGB')\n            # P 模式保持 RGBA：PNG 原生支持 alpha，量化回 P 反而丢透明度\n        save_like(save_im, out)\n        files.append({'out': out, 'w': im.size[0], 'h': im.size[1], 'ops': report})\n    return {'ok': True, 'files': files}\n\n\ndef op_resize(payload):\n    items = payload.get('items')\n    _require(isinstance(items, list) and items, 'items 必须是非空数组')\n    files = []\n    for it in items:\n        _require(isinstance(it, dict), 'items 元素必须是对象')\n        path = it.get('path')\n        out = it.get('out')\n        _require(isinstance(out, str) and out, 'out 必须是非空字符串')\n        max_dim = _int(it.get('maxDim'), 1600, 'maxDim')\n        _require(max_dim and max_dim > 0, 'maxDim 必须 > 0')\n        im = load_image(path)\n        W, H = im.size\n        longest = max(W, H)\n        if longest <= max_dim:\n            new = im.copy()\n        else:\n            s = float(max_dim) / float(longest)\n            new = im.resize((max(1, int(round(W * s))), max(1, int(round(H * s)))),\n                            Image.LANCZOS)\n        odir = os.path.dirname(os.path.abspath(out))\n        if odir:\n            os.makedirs(odir, exist_ok=True)\n        new.save(out)\n        files.append({'out': out, 'w': new.size[0], 'h': new.size[1],\n                      'srcWidth': W, 'srcHeight': H, 'maxDim': max_dim})\n    return {'ok': True, 'files': files}\n\n\n# ---------------------------------------------------------------- PDF\n\n_OBJ_RE = re.compile(rb'(?m)(?<![0-9])(\\d{1,10})\\s+(\\d{1,5})\\s+obj\\b')\n_REF_RE = re.compile(rb'^\\s*(\\d+)\\s+(\\d+)\\s+R\\b')\n_NAME_RE = re.compile(rb'/([^\\s/\\[\\]<>(){}%]+)')\n\n\ndef scan_pdf_objects(data):\n    \"\"\"扫描所有间接对象：{num: {'raw': bytes}}。\"\"\"\n    objs = {}\n    for m in _OBJ_RE.finditer(data):\n        num = int(m.group(1))\n        end = data.find(b'endobj', m.end())\n        raw = data[m.end():end if end >= 0 else len(data)]\n        objs[num] = raw\n    return objs\n\n\ndef obj_stream_bytes(raw):\n    \"\"\"取对象里的流字节；无流返回 None。\"\"\"\n    i = raw.find(b'stream')\n    if i < 0:\n        return None\n    dic = raw[:i]\n    j = i + len(b'stream')\n    if raw[j:j + 2] == b'\\r\\n':\n        j += 2\n    elif raw[j:j + 1] in (b'\\n', b'\\r'):\n        j += 1\n    m = re.search(rb'/Length\\s+(\\d+)(?!\\s+\\d+\\s+R)', dic)\n    n = int(m.group(1)) if m else None\n    k = raw.find(b'endstream', j)\n    if n is not None and 0 <= n <= (k - j if k >= 0 else len(raw) - j):\n        return raw[j:j + n]\n    if k >= 0:\n        out = raw[j:k]\n        if out.endswith(b'\\r\\n'):\n            out = out[:-2]\n        elif out.endswith(b'\\n') or out.endswith(b'\\r'):\n            out = out[:-1]\n        return out\n    return raw[j:]\n\n\ndef parse_filters(dic):\n    m = re.search(rb'/Filter\\s*(\\[[^\\]]*\\]|/\\w+)', dic)\n    if not m:\n        return []\n    return [x.decode('latin1') for x in _NAME_RE.findall(m.group(1))]\n\n\ndef _a85_ascii85(data):\n    s = bytes(c for c in data if not chr(c).isspace())\n    if s.startswith(b'<~'):\n        s = s[2:]\n    if s.endswith(b'~>'):\n        s = s[:-2]\n    out = bytearray()\n    acc = 0\n    n = 0\n    for c in s:\n        if c == 0x7a and n == 0:  # 'z'\n            out.extend(b'\\x00\\x00\\x00\\x00')\n            continue\n        if not (0x21 <= c <= 0x75):\n            continue\n        acc = acc * 85 + (c - 33)\n        n += 1\n        if n == 5:\n            out.extend(acc.to_bytes(4, 'big'))\n            acc = 0\n            n = 0\n    if n:\n        for _ in range(5 - n):\n            acc = acc * 85 + 84\n        out.extend(acc.to_bytes(4, 'big')[:n - 1])\n    return bytes(out)\n\n\ndef decode_stream(data, filters):\n    \"\"\"按 Filter 链解码；失败返回 (None, 错误说明)。\"\"\"\n    out = data\n    for f in filters:\n        f = f.lstrip('/')\n        try:\n            if f in ('FlateDecode', 'Fl'):\n                try:\n                    out = zlib.decompress(out)\n                except zlib.error:\n                    out = zlib.decompressobj().decompress(out)\n            elif f in ('ASCIIHexDecode', 'AHx'):\n                s = re.sub(rb'\\s+', b'', out).rstrip(b'>')\n                if len(s) % 2:\n                    s += b'0'\n                out = bytes.fromhex(s.decode('latin1'))\n            elif f in ('ASCII85Decode', 'A85'):\n                out = _a85_ascii85(out)\n            elif f in ('LZWDecode', 'CCITTFaxDecode', 'JPXDecode', 'DCTDecode',\n                       'JBIG2Decode', 'RunLengthDecode', 'Crypt'):\n                return None, '不支持的 Filter：%s' % f\n            else:\n                return None, '未知 Filter：%s' % f\n        except Exception as exc:\n            return None, 'Filter %s 解码失败：%s' % (f, exc)\n    return out, None\n\n\ndef _parse_pdf_value(buf, i):\n    \"\"\"从 i 开始解析一个 PDF 对象/值，返回 (value, next_i)。\"\"\"\n    n = len(buf)\n    while i < n and buf[i:i + 1] in b' \\t\\r\\n\\x00':\n        i += 1\n    if i >= n:\n        return None, i\n    c = buf[i:i + 1]\n    if c == b'<':\n        if buf[i:i + 2] == b'<<':\n            dic = {}\n            i += 2\n            while i < n:\n                while i < n and buf[i:i + 1] in b' \\t\\r\\n\\x00':\n                    i += 1\n                if buf[i:i + 2] == b'>>':\n                    return dic, i + 2\n                if buf[i:i + 1] == b'/':\n                    m = _NAME_RE.match(buf, i)\n                    if not m:\n                        i += 1\n                        continue\n                    key = m.group(1).decode('latin1')\n                    i = m.end()\n                    val, i = _parse_pdf_value(buf, i)\n                    dic.setdefault(key, val)\n                    continue\n                # 非法键：跳过一词\n                j = i\n                while j < n and buf[j:j + 1] not in b' \\t\\r\\n':\n                    j += 1\n                i = j if j > i else i + 1\n            return dic, i\n        j = buf.find(b'>', i)\n        if j < 0:\n            return b'', n\n        return bytes.fromhex(_hex_clean(buf[i + 1:j])), j + 1\n    if c == b'(':\n        depth = 0\n        j = i\n        while j < n:\n            ch = buf[j:j + 1]\n            if ch == b'\\\\':\n                j += 2\n                continue\n            if ch == b'(':\n                depth += 1\n            elif ch == b')':\n                depth -= 1\n                if depth == 0:\n                    j += 1\n                    break\n            j += 1\n        return _decode_pdf_literal(buf[i + 1:j - 1]), j\n    if c == b'[':\n        arr = []\n        i += 1\n        while i < n:\n            while i < n and buf[i:i + 1] in b' \\t\\r\\n':\n                i += 1\n            if buf[i:i + 1] == b']':\n                return arr, i + 1\n            if i >= n:\n                break\n            v, i = _parse_pdf_value(buf, i)\n            arr.append(v)\n        return arr, i\n    if c == b'/':\n        m = _NAME_RE.match(buf, i)\n        if m:\n            return '/' + m.group(1).decode('latin1'), m.end()\n        return None, i + 1\n    if c.isdigit() or c in b'+-.':\n        m = re.match(rb'[+-]?\\d*\\.?\\d+', buf[i:i + 40])\n        if m:\n            text = m.group(0)\n            i2 = i + m.end()\n            rm = _REF_RE.match(buf, i2)\n            if rm:\n                return (int(rm.group(1)), int(rm.group(2))), rm.end()\n            try:\n                return (float(text) if b'.' in text else int(text)), i2\n            except ValueError:\n                return None, i2\n        return None, i + 1\n    if buf[i:i + 4] == b'true':\n        return True, i + 4\n    if buf[i:i + 5] == b'false':\n        return False, i + 5\n    if buf[i:i + 4] == b'null':\n        return None, i + 4\n    j = i\n    while j < n and buf[j:j + 1] not in b' \\t\\r\\n/[]<>()':\n        j += 1\n    return buf[i:j].decode('latin1'), (j if j > i else i + 1)\n\n\ndef _hex_clean(b):\n    s = re.sub(rb'[^0-9a-fA-F]', b'', b)\n    if len(s) % 2:\n        s += b'0'\n    return s.decode('latin1')\n\n\ndef _decode_pdf_literal(b):\n    out = bytearray()\n    i = 0\n    n = len(b)\n    while i < n:\n        c = b[i]\n        if c != 0x5C:\n            out.append(c)\n            i += 1\n            continue\n        i += 1\n        if i >= n:\n            break\n        e = b[i:i + 1]\n        if e == b'n':\n            out.append(10); i += 1\n        elif e == b'r':\n            out.append(13); i += 1\n        elif e == b't':\n            out.append(9); i += 1\n        elif e == b'b':\n            out.append(8); i += 1\n        elif e == b'f':\n            out.append(12); i += 1\n        elif e in (b'(', b')', b'\\\\'):\n            out.append(e[0]); i += 1\n        elif e == b'\\n':\n            i += 1\n        elif e == b'\\r':\n            i += 1\n            if b[i:i + 1] == b'\\n':\n                i += 1\n        elif e.isdigit():\n            j = i\n            while j < n and j < i + 3 and b[j:j + 1].isdigit():\n                j += 1\n            out.append(int(b[i:j], 8) & 0xFF)\n            i = j\n        else:\n            out.append(e[0]); i += 1\n    return bytes(out)\n\n\ndef parse_to_unicode_cmap(stream_bytes):\n    \"\"\"解析简单 CMap 的 beginbfchar / beginbfrange（含 codespace 宽度）。\"\"\"\n    if not stream_bytes:\n        return None\n    txt = stream_bytes.decode('latin1', 'replace')\n    if 'beginbfchar' not in txt and 'beginbfrange' not in txt:\n        return None\n    lengths = set()\n    for m in re.finditer(r'begincodespacerange(.*?)endcodespacerange', txt, re.S):\n        for h in re.findall(r'<([0-9A-Fa-f]+)>', m.group(1)):\n            lengths.add(len(h) // 2)\n    cmap = {}\n    for m in re.finditer(r'beginbfchar(.*?)endbfchar', txt, re.S):\n        for src, dst in re.findall(r'<([0-9A-Fa-f]+)>\\s*<([0-9A-Fa-f]*)>', m.group(1)):\n            code = int(src, 16)\n            cmap[code] = _utf16be_hex(dst)\n    for m in re.finditer(r'beginbfrange(.*?)endbfrange', txt, re.S):\n        body = m.group(1)\n        for lo, hi, dst in re.findall(\n                r'<([0-9A-Fa-f]+)>\\s*<([0-9A-Fa-f]+)>\\s*<([0-9A-Fa-f]+)>', body):\n            a, b = int(lo, 16), int(hi, 16)\n            base = _utf16be_hex(dst)\n            if len(base) != 1:\n                for k in range(a, min(b, a + 4096) + 1):\n                    cmap[k] = base\n                continue\n            for off, k in enumerate(range(a, min(b, a + 4096) + 1)):\n                cmap[k] = chr(ord(base) + off)\n        for lo, hi, arr in re.findall(\n                r'<([0-9A-Fa-f]+)>\\s*<([0-9A-Fa-f]+)>\\s*\\[(.*?)\\]', body, re.S):\n            a = int(lo, 16)\n            items = re.findall(r'<([0-9A-Fa-f]*)>', arr)\n            for off, h in enumerate(items):\n                cmap[a + off] = _utf16be_hex(h)\n    widths = sorted(lengths) or [1, 2]\n    return {'map': cmap, 'widths': widths}\n\n\ndef _utf16be_hex(h):\n    if not h:\n        return ''\n    if len(h) % 2:\n        h += '0'\n    raw = bytes.fromhex(h)\n    try:\n        return raw.decode('utf-16-be')\n    except Exception:\n        return raw.decode('latin1')\n\n\ndef decode_pdf_string(raw, cmap):\n    \"\"\"把字符串字节按 CMap 解码；失败降级 latin1。\"\"\"\n    if not raw:\n        return ''\n    if cmap and cmap['map']:\n        m = cmap['map']\n        widths = cmap['widths']\n        out = []\n        i = 0\n        n = len(raw)\n        while i < n:\n            hit = False\n            for wd in widths:\n                if wd > 1 and i + wd <= n:\n                    code = int.from_bytes(raw[i:i + wd], 'big')\n                    if code in m:\n                        out.append(m[code])\n                        i += wd\n                        hit = True\n                        break\n            if hit:\n                continue\n            code = raw[i]\n            if code in m:\n                out.append(m[code])\n            else:\n                out.append(bytes([code]).decode('latin1'))\n            i += 1\n        return ''.join(out)\n    return raw.decode('latin1')\n\n\n_CONTENT_TOKEN_RE = re.compile(\n    rb'(\\[(?:[^\\[\\]\\\\]|\\\\.)*\\]|\\((?:[^()\\\\]|\\\\.)*\\)|<[0-9A-Fa-f\\s]*>|[-+]?\\d*\\.?\\d+|/[^\\s/\\[\\]<>(){}]+|[A-Za-z\\'\"*]+)',\n    re.S)\n_SHOW_OPS = (b'Tj', b'TJ', b\"'\", b'\"')\n_NL_OPS = (b'Td', b'TD', b'T*', b'BT', b'ET')\n\n\ndef extract_text_from_content(content, cmap):\n    \"\"\"从内容流抽取 Tj/TJ/'/\" 字符串（含换行提示）。\"\"\"\n    parts = []\n    pending = []\n    last_adjust = 0.0\n    for m in _CONTENT_TOKEN_RE.finditer(content):\n        tok = m.group(1)\n        if tok.startswith(b'('):\n            pending.append(_decode_pdf_literal(tok[1:-1]))\n        elif tok.startswith(b'<') and not tok.startswith(b'<<'):\n            h = _hex_clean(tok[1:-1])\n            pending.append(bytes.fromhex(h) if h else b'')\n        elif tok.startswith(b'['):\n            inner = _CONTENT_TOKEN_RE.findall(tok[1:-1])\n            for it in inner:\n                if it.startswith(b'('):\n                    pending.append(_decode_pdf_literal(it[1:-1]))\n                elif it.startswith(b'<') and len(it) > 2:\n                    h = _hex_clean(it[1:-1])\n                    if h:\n                        pending.append(bytes.fromhex(h))\n                else:\n                    try:\n                        last_adjust = float(it)\n                    except ValueError:\n                        pass\n                    if last_adjust < -180 and pending:\n                        pending.append(b' ')\n            last_adjust = 0.0\n        elif tok in _SHOW_OPS:\n            if pending:\n                parts.append(decode_pdf_string(b''.join(pending), cmap))\n                pending = []\n        elif tok in _NL_OPS:\n            if pending:\n                parts.append(decode_pdf_string(b''.join(pending), cmap))\n                pending = []\n            if parts and not parts[-1].endswith('\\n'):\n                parts.append('\\n')\n    if pending:\n        parts.append(decode_pdf_string(b''.join(pending), cmap))\n    text = ''.join(parts)\n    text = re.sub(r'[ \\t]+\\n', '\\n', text)\n    text = re.sub(r'\\n{3,}', '\\n\\n', text)\n    return text.strip('\\n')\n\n\ndef _looks_like_text(s):\n    if not s:\n        return False\n    good = 0\n    for ch in s:\n        o = ord(ch)\n        if ch.isprintable() and (o >= 0x20):\n            good += 1\n        if 0x4e00 <= o <= 0x9fff or 0x3040 <= o <= 0x30ff or 0xac00 <= o <= 0xd7af:\n            good += 4\n    return good >= max(3, len(s) * 0.4)\n\n\ndef op_pdf(payload):\n    f = payload.get('file')\n    _require(isinstance(f, str) and f, 'file 必须是非空字符串')\n    _require(os.path.isfile(f), 'PDF 不存在：%s' % f)\n    with open(f, 'rb') as fh:\n        data = fh.read()\n    _require(data[:5] == b'%PDF-',\n             '不是 PDF 文件（缺少 %%PDF- 头）：%s' % f)\n    out_dir = payload.get('outDir') or (os.path.splitext(f)[0] + '.pdfimg')\n    os.makedirs(out_dir, exist_ok=True)\n    want_text = payload.get('wantText', True)\n    want_images = payload.get('wantImages', True)\n\n    objs = scan_pdf_objects(data)\n    log('pdf %s: %d 间接对象' % (os.path.basename(f), len(objs)))\n\n    # 页数：/Type /Page（非 /Pages）\n    pages = 0\n    for num, raw in objs.items():\n        head = raw[:raw.find(b'stream')] if b'stream' in raw else raw\n        if re.search(rb'/Type\\s*/Page(?![s])', head):\n            pages += 1\n    if pages == 0:\n        m = re.search(rb'/Count\\s+(\\d+)', data)\n        pages = int(m.group(1)) if m else 1\n\n    # 字体 ToUnicode → 合并的字符映射\n    cmaps = []\n    for num, raw in objs.items():\n        head = raw[:raw.find(b'stream')] if b'stream' in raw else raw\n        if not re.search(rb'/Type\\s*/Font', head):\n            continue\n        m = re.search(rb'/ToUnicode\\s+(\\d+)\\s+\\d+\\s+R', head)\n        if not m:\n            continue\n        tref = int(m.group(1))\n        if tref not in objs:\n            continue\n        sb = obj_stream_bytes(objs[tref])\n        if sb is None:\n            continue\n        dec, _err = decode_stream(sb, parse_filters(objs[tref]))\n        if dec is None:\n            continue\n        cm = parse_to_unicode_cmap(dec)\n        if cm:\n            cmaps.append(cm)\n    merged = {}\n    widths = set()\n    for cm in cmaps:\n        for k, v in cm['map'].items():\n            merged.setdefault(k, v)\n        widths.update(cm['widths'])\n    cmap = {'map': merged, 'widths': sorted(widths) or [1, 2]} if merged else None\n\n    # 文本抽取\n    text_parts = []\n    streams_with_text = 0\n    if want_text:\n        for num, raw in objs.items():\n            if b'stream' not in raw:\n                continue\n            head = raw[:raw.find(b'stream')]\n            if re.search(rb'/Subtype\\s*/Image|/Type\\s*/(XObject|Font|Metadata|ObjStm|XRef|EmbeddedFile|Filespec)', head):\n                continue\n            if b'/Image' in head and b'/Subtype' in head:\n                continue\n            sb = obj_stream_bytes(raw)\n            if sb is None:\n                continue\n            dec, err = decode_stream(sb, parse_filters(head))\n            if dec is None:\n                continue\n            if b'\\x00' in dec[:2000]:\n                continue\n            if not re.search(rb'\\b(Tj|TJ)\\b|\\'|\"', dec):\n                continue\n            piece = extract_text_from_content(dec, cmap)\n            if piece.strip():\n                streams_with_text += 1\n                text_parts.append(piece)\n    text = '\\f'.join(p for p in text_parts)\n    has_text = bool(text.strip()) and _looks_like_text(text)\n    if text_parts and not has_text:\n        log('pdf: 文本层解码结果疑似乱码，标记 hasText=false')\n    if not has_text:\n        text = text if text.strip() else ''\n\n    # 图片抽取\n    images = []\n    skipped = []\n    if want_images:\n        idx = 0\n        cs_map = {\n            'DeviceRGB': ('RGB', 3), 'DeviceGray': ('L', 1), 'CalRGB': ('RGB', 3),\n            'CalGray': ('L', 1), 'DeviceCMYK': ('CMYK', 4), '/DeviceRGB': ('RGB', 3),\n            '/DeviceGray': ('L', 1), '/DeviceCMYK': ('CMYK', 4),\n        }\n        for num in sorted(objs):\n            raw = objs[num]\n            if b'stream' not in raw:\n                continue\n            head = raw[:raw.find(b'stream')]\n            if not re.search(rb'/Subtype\\s*/Image', head):\n                continue\n            try:\n                val, _ = _parse_pdf_value(head, 0)\n            except Exception:\n                val = {}\n            if not isinstance(val, dict):\n                val = {}\n            dic = val\n            sb = obj_stream_bytes(raw)\n            if sb is None:\n                skipped.append({'page': 1, 'reason': '流读取失败', 'obj': num})\n                continue\n            w = int(dic.get('Width') or 0) if isinstance(dic.get('Width'), (int, float)) else 0\n            h = int(dic.get('Height') or 0) if isinstance(dic.get('Height'), (int, float)) else 0\n            bpc = int(dic.get('BitsPerComponent') or 8) if isinstance(dic.get('BitsPerComponent'), (int, float)) else 8\n            cs = dic.get('ColorSpace')\n            csname = cs if isinstance(cs, str) else (cs[0] if isinstance(cs, list) and cs and isinstance(cs[0], str) else None)\n            filters = parse_filters(head)\n            name = 'p1-img%d' % idx\n            page = pages if pages else 1\n            if filters == ['DCTDecode'] or filters == ['/DCTDecode']:\n                path = os.path.join(out_dir, name + '.jpg')\n                with open(path, 'wb') as fh:\n                    fh.write(sb)\n                try:\n                    with Image.open(path) as t:\n                        t.load()\n                        tw, th = t.size\n                except Exception as exc:\n                    skipped.append({'page': page, 'obj': num,\n                                    'reason': 'DCTDecode 数据无效：%s' % exc})\n                    try:\n                        os.remove(path)\n                    except OSError:\n                        pass\n                    continue\n                images.append({'page': page, 'name': name + '.jpg', 'path': path,\n                               'w': tw, 'h': th, 'filter': 'DCTDecode'})\n                idx += 1\n                continue\n            if any(f.lstrip('/') in ('JPXDecode', 'CCITTFaxDecode', 'JBIG2Decode')\n                   for f in filters):\n                skipped.append({'page': page, 'obj': num,\n                                'reason': '不支持的 Filter：%s' % ','.join(filters)})\n                continue\n            dec, err = decode_stream(sb, filters)\n            if dec is None:\n                skipped.append({'page': page, 'obj': num, 'reason': err or '解码失败'})\n                continue\n            if not w or not h:\n                skipped.append({'page': page, 'obj': num, 'reason': '缺少 Width/Height'})\n                continue\n            mode, ncomp = cs_map.get(csname or '', (None, 0))\n            if mode is None or bpc != 8:\n                skipped.append({'page': page, 'obj': num,\n                                'reason': '不支持的 ColorSpace/BPC：%s/%s' % (csname, bpc)})\n                continue\n            need = w * h * ncomp\n            if len(dec) < need:\n                skipped.append({'page': page, 'obj': num,\n                                'reason': '像素数据不足（%d < %d）' % (len(dec), need)})\n                continue\n            arr = np.frombuffer(dec[:need], dtype=np.uint8).reshape(h, w, ncomp)\n            if ncomp == 1:\n                img = Image.fromarray(arr[:, :, 0], 'L')\n            elif ncomp == 3:\n                img = Image.fromarray(arr, 'RGB')\n            else:\n                img = Image.fromarray(arr, 'CMYK').convert('RGB')\n            path = os.path.join(out_dir, name + '.png')\n            img.save(path)\n            images.append({'page': page, 'name': name + '.png', 'path': path,\n                           'w': w, 'h': h, 'filter': ','.join(filters) or 'none'})\n            idx += 1\n\n    if skipped:\n        log('pdf: %d 个图像对象被跳过' % len(skipped))\n    return {\n        'ok': True,\n        'pages': int(pages),\n        'hasText': bool(has_text),\n        'text': text if has_text else '',\n        'rawText': text if not has_text else '',\n        'images': images,\n        'skipped': skipped,\n        'objects': len(objs),\n        'fontsMapped': len(cmaps),\n        'cmapEntries': len(merged),\n    }\n\n\n# ---------------------------------------------------------------- 入口\n\nOPS = {\n    'probe': op_probe,\n    'regions': op_regions,\n    'crop': op_crop,\n    'typeset': op_typeset,\n    'pdf': op_pdf,\n    'resize': op_resize,\n}\n\n\ndef run(in_path, out_path):\n    if not os.path.isfile(in_path):\n        return {'ok': False, 'error': '输入文件不存在：%s' % in_path}\n    try:\n        with open(in_path, 'r', encoding='utf-8') as fh:\n            payload = json.load(fh)\n    except Exception as exc:\n        return {'ok': False, 'error': '输入 JSON 解析失败：%s' % exc}\n    if not isinstance(payload, dict):\n        return {'ok': False, 'error': '输入 JSON 必须是对象'}\n    op = payload.get('op')\n    if op not in OPS:\n        return {'ok': False, 'error': '未知 op：%r（支持 %s）'\n                % (op, '/'.join(sorted(OPS)))}\n    try:\n        res = OPS[op](payload)\n        res.setdefault('ok', True)\n        res.setdefault('op', op)\n        return res\n    except Exception as exc:\n        log('op=%s 失败：%s\\n%s' % (op, exc, traceback.format_exc()))\n        return {'ok': False, 'error': '%s' % exc, 'op': op}\n\n\ndef main(argv):\n    if len(argv) < 3:\n        sys.stderr.write('用法：python imglib.py <in.json> <out.json>\\n')\n        return 2\n    in_path, out_path = argv[1], argv[2]\n    try:\n        result = run(in_path, out_path)\n    except Exception as exc:  # 兜底：连 run 都炸了也必须写出 out.json\n        result = {'ok': False, 'error': '内部错误：%s' % exc}\n        log(traceback.format_exc())\n    try:\n        d = os.path.dirname(os.path.abspath(out_path))\n        if d:\n            os.makedirs(d, exist_ok=True)\n        write_result(out_path, result)\n    except Exception as exc:\n        sys.stderr.write('[imglib] 无法写出 out.json：%s\\n' % exc)\n        return 1\n    log('%s -> ok=%s' % (result.get('op', '?'), result.get('ok')))\n    return 0\n\n\nif __name__ == '__main__':\n    sys.exit(main(sys.argv))\n",
    "mediakit.js": "/**\n * mediakit —— 汉化引擎的零依赖底层能力（漫画 CBZ/ZIP、EPUB、PDF 容器、在线翻译/视觉 OCR 的 HTTP 通道）。\n *\n * 契约：`node mediakit.js <in.json> <out.json>`\n *   - 入参/出参都是 UTF-8 JSON，入参里的路径一律是绝对路径；\n *   - 无论业务成败都写出 out.json：成功 `{ok:true,...}`，失败 `{ok:false,error:\"<消息>\"}`；\n *   - 退出码 0 = out.json 已写出（业务失败也是 0），只有 out.json 本身写不出去才非 0；\n *   - 日志一律写 stderr，绝不污染 out.json。\n *\n * 为什么做成 CLI 而不是模块：引擎（host.js）跑在内核插件沙箱里，不能 require 第三方包，\n * 也不该把 ZIP 二进制解析塞进被内核校验的插件源码。把重活交给子进程里这个零依赖脚本，\n * 边界清楚、可单独测试。\n *\n * 模块形态：本文件所在目录及其上层都没有 package.json，因此按 CommonJS 加载。\n * 只使用 node: 内置模块，禁止任何第三方依赖。\n */\n'use strict'\n\nconst fs = require('node:fs')\nconst path = require('node:path')\nconst zlib = require('node:zlib')\nconst crypto = require('node:crypto')\nconst http = require('node:http')\nconst https = require('node:https')\n\n// 单条目上限：ZIP 里的一个条目解压后超过它就报错，避免 zip 炸弹式的一次性内存占用。\nconst MAX_ENTRY_BYTES = 512 * 1024 * 1024\n// http-json 最多攒这么多字符再解析（返回给调用方的 text 另外截断到 200000）。\nconst MAX_BODY_CHARS = 8 * 1024 * 1024\nconst TEXT_LIMIT = 200000\nconst EMPTY = Buffer.alloc(0)\nconst UTF8_STRICT = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })\n\nconst SIG_LOCAL = 0x04034b50\nconst SIG_CENTRAL = 0x02014b50\nconst SIG_EOCD = 0x06054b50\nconst SIG_ZIP64_EOCD = 0x06064b50\nconst SIG_ZIP64_LOCATOR = 0x07064b50\nconst U16_MAX = 0xffff\nconst U32_MAX = 0xffffffff\n\nconst msgOf = (e) => ((e && e.message) ? String(e.message) : String(e))\n/** 业务错误：只把 message 写进 out.json，不往 stderr 打堆栈（调用方看得懂就够了）。 */\nconst fail = (msg) => {\n  const e = new Error(msg)\n  e.expected = true\n  return e\n}\nconst logWarn = (msg) => process.stderr.write(`[mediakit] ${msg}\\n`)\n\n// ---------------------------------------------------------------- CRC32 / 时间\n\n// 查表法 CRC32（多项式 0xEDB88320），ZIP 条目校验用；自行实现以免依赖。\nconst CRC_TABLE = (() => {\n  const table = new Uint32Array(256)\n  for (let n = 0; n < 256; n++) {\n    let c = n\n    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)\n    table[n] = c >>> 0\n  }\n  return table\n})()\n\n/** 可增量：crc32(chunk, crc32(prevChunk)) —— 流式校验时用。 */\nfunction crc32 (buf, prev = 0) {\n  let c = (prev ^ 0xffffffff) >>> 0\n  for (let i = 0; i < buf.length; i++) c = (CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)) >>> 0\n  return (c ^ 0xffffffff) >>> 0\n}\n\n/** DOS 时间戳（本地时区，与常见打包器一致）。 */\nfunction dosDateTime (d = new Date()) {\n  const year = Math.max(1980, Math.min(2107, d.getFullYear()))\n  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2) & 0x1f)\n  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()\n  return { time: time & 0xffff, date: date & 0xffff }\n}\n\n// ---------------------------------------------------------------- 低层 IO\n\nfunction readRange (fd, pos, len) {\n  const buf = Buffer.allocUnsafe(len)\n  let got = 0\n  while (got < len) {\n    const n = fs.readSync(fd, buf, got, len - got, pos + got)\n    if (n <= 0) throw fail(`读取失败：文件在偏移 ${pos + got} 处意外结束`)\n    got += n\n  }\n  return buf\n}\n\nfunction writeAll (fd, buf) {\n  let off = 0\n  while (off < buf.length) {\n    const n = fs.writeSync(fd, buf, off, buf.length - off)\n    if (n <= 0) throw fail('写入失败：磁盘未接收数据')\n    off += n\n  }\n}\n\n/** 分块读文件算 sha256：避免为几十 MB 的包一次性分配整块内存。 */\nfunction sha256File (file) {\n  const fd = fs.openSync(file, 'r')\n  try {\n    const hash = crypto.createHash('sha256')\n    const buf = Buffer.allocUnsafe(1024 * 1024)\n    for (;;) {\n      const n = fs.readSync(fd, buf, 0, buf.length, null)\n      if (n <= 0) break\n      hash.update(buf.subarray(0, n))\n    }\n    return hash.digest('hex')\n  } finally {\n    fs.closeSync(fd)\n  }\n}\n\nfunction readFileCapped (file, what) {\n  let st\n  try {\n    st = fs.statSync(file)\n  } catch (e) {\n    throw fail(`${what} 不可读：${file} — ${msgOf(e)}`)\n  }\n  if (!st.isFile()) throw fail(`${what} 不是普通文件：${file}`)\n  if (st.size > MAX_ENTRY_BYTES) throw fail(`${what} 过大（${st.size} 字节 > ${MAX_ENTRY_BYTES}）：${file}`)\n  return fs.readFileSync(file)\n}\n\nconst requireAbsPath = (value, field) => {\n  if (typeof value !== 'string' || value === '') throw fail(`缺少必填字段 ${field}（需绝对路径字符串）`)\n  if (!path.isAbsolute(value)) throw fail(`${field} 必须是绝对路径：${value}`)\n  return value\n}\n\n// ---------------------------------------------------------------- ZIP 条目名\n\n/** 读取侧：bit 11 置位按 UTF-8；否则先试严格 UTF-8，非法才回落 latin1（老打包器的 CP437 近似）。 */\nfunction decodeZipName (raw, flags) {\n  if (flags & 0x0800) return raw.toString('utf8')\n  try {\n    return UTF8_STRICT.decode(raw)\n  } catch {\n    return raw.toString('latin1')\n  }\n}\n\n/** 写入侧：非 ASCII 名字按 UTF-8 存并置 bit 11，中文名才能被各家工具正确识别。 */\nfunction encodeZipName (name) {\n  const buf = Buffer.from(name, 'utf8')\n  let ascii = true\n  for (const b of buf) if (b >= 0x80) { ascii = false; break }\n  return { buf, utf8: !ascii }\n}\n\n/**\n * 写入侧条目名校验：统一分隔符为 `/`，并拒绝会写出危险条目名（绝对路径、`..`、`:`、NUL）的名字。\n * 这与解压侧防护对称：本工具产出的包，自己也能安全解开。\n */\nfunction normalizeWriteName (raw) {\n  if (typeof raw !== 'string' || raw === '') throw fail('条目名不能为空')\n  const name = raw.replace(/\\\\/g, '/')\n  if (name.includes('\\0')) throw fail('条目名含 NUL 字节，已拒绝')\n  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) throw fail(`条目名是绝对路径，已拒绝：${raw}`)\n  if (name.includes(':')) throw fail(`条目名含 \":\"，已拒绝：${raw}`)\n  for (const seg of name.split('/')) if (seg === '..') throw fail(`条目名含 \"..\"，已拒绝：${raw}`)\n  return name\n}\n\n/**\n * 解压侧路径防护：把条目名归一化成 outDir 内的相对路径。\n * 拒绝 `..`、绝对路径、盘符、`:`、NUL —— 这些正是 zip-slip 逃逸目录的手段。\n */\nfunction safeRelativeName (raw) {\n  const name = String(raw).replace(/\\\\/g, '/')\n  if (name.includes('\\0')) throw fail(`条目名含 NUL 字节，已拒绝：${raw}`)\n  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) throw fail(`条目名是绝对路径，已拒绝：${raw}`)\n  const parts = []\n  for (const seg of name.split('/')) {\n    if (seg === '' || seg === '.') continue\n    if (seg === '..') throw fail(`条目名含 \"..\"（目录穿越），已拒绝：${raw}`)\n    if (seg.includes(':')) throw fail(`条目名含 \":\"，已拒绝：${raw}`)\n    parts.push(seg)\n  }\n  if (parts.length === 0) throw fail(`条目名为空或仅是目录，已拒绝：${raw}`)\n  return parts.join('/')\n}\n\n/** 双保险：拼出来的绝对路径必须仍在 outDir 内。 */\nfunction assertInside (root, target) {\n  const rel = path.relative(root, target)\n  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {\n    throw fail(`目标路径越出解压目录，已拒绝：${target}`)\n  }\n}\n\n// ---------------------------------------------------------------- ZIP 读\n\nclass ZipReader {\n  constructor (file) {\n    this.file = file\n    this.fd = fs.openSync(file, 'r')\n    this.size = fs.fstatSync(this.fd).size\n    try {\n      this.entries = []\n      this._readIndex()\n    } catch (e) {\n      this.close()\n      throw e\n    }\n  }\n\n  close () {\n    if (this.fd !== -1) {\n      try { fs.closeSync(this.fd) } catch { /* 已关闭 */ }\n      this.fd = -1\n    }\n  }\n\n  _read (pos, len) {\n    if (len < 0 || pos < 0 || pos + len > this.size) {\n      throw fail(`ZIP 结构异常：越界读取 offset=${pos} len=${len} fileSize=${this.size}`)\n    }\n    return readRange(this.fd, pos, len)\n  }\n\n  /** EOCD →（必要时 zip64 EOCD）→ 中央目录。刻意不读 local header 的 size 字段。 */\n  _readIndex () {\n    const tailLen = Math.min(this.size, 22 + U16_MAX)\n    const tailStart = this.size - tailLen\n    const tail = this._read(tailStart, tailLen)\n\n    let at = -1\n    for (let i = tailLen - 22; i >= 0; i--) {\n      if (tail.readUInt32LE(i) !== SIG_EOCD) continue\n      if (i + 22 + tail.readUInt16LE(i + 20) === tailLen) { at = i; break }\n      if (at === -1) at = i // 注释长度对不上（尾部有杂字节）也先记下最后一个候选\n    }\n    if (at === -1) throw fail('不是有效的 ZIP：未找到 EOCD 记录')\n\n    const eocdPos = tailStart + at\n    const diskEntries = tail.readUInt16LE(at + 8)\n    const totalEntries = tail.readUInt16LE(at + 10)\n    let cdSize = tail.readUInt32LE(at + 12)\n    let cdOffset = tail.readUInt32LE(at + 16)\n    let count = totalEntries\n\n    const needZip64 = totalEntries === U16_MAX || diskEntries === U16_MAX ||\n      cdSize === U32_MAX || cdOffset === U32_MAX\n    if (needZip64) {\n      const z = this._readZip64(eocdPos)\n      if (totalEntries === U16_MAX) count = z.totalEntries\n      if (cdSize === U32_MAX) cdSize = z.cdSize\n      if (cdOffset === U32_MAX) cdOffset = z.cdOffset\n    }\n    if (cdOffset + cdSize > this.size) throw fail('ZIP 结构异常：中央目录越界')\n\n    const cd = this._read(cdOffset, cdSize)\n    this.entries = parseCentralDirectory(cd, count)\n  }\n\n  _readZip64 (eocdPos) {\n    if (eocdPos < 20) throw fail('ZIP64：EOCD 前缺少 zip64 定位器')\n    const loc = this._read(eocdPos - 20, 20)\n    if (loc.readUInt32LE(0) !== SIG_ZIP64_LOCATOR) throw fail('ZIP64：定位器签名不符')\n    const rec = this._read(Number(loc.readBigUInt64LE(8)), 56)\n    if (rec.readUInt32LE(0) !== SIG_ZIP64_EOCD) throw fail('ZIP64：EOCD 记录签名不符')\n    return {\n      totalEntries: Number(rec.readBigUInt64LE(32)),\n      cdSize: Number(rec.readBigUInt64LE(40)),\n      cdOffset: Number(rec.readBigUInt64LE(48))\n    }\n  }\n\n  /** 条目压缩数据的起始偏移：数据起点只信 local header 的 nameLen/extraLen（长度可靠），\n   *  size 一律用中央目录的值——有 data descriptor（bit 3）时 local header 的 size 字段可能是 0。 */\n  dataOffsetOf (entry) {\n    const lh = this._read(entry.localHeaderOffset, 30)\n    if (lh.readUInt32LE(0) !== SIG_LOCAL) throw fail(`本地头签名不符：${entry.name}`)\n    return entry.localHeaderOffset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28)\n  }\n\n  /** 只取压缩后的原始字节（zip-replace 原样搬运未改动条目时用，保证字节级不变）。 */\n  readRaw (entry) {\n    if (entry.compSize > MAX_ENTRY_BYTES) {\n      throw fail(`条目过大（压缩后 ${entry.compSize} 字节 > ${MAX_ENTRY_BYTES}）：${entry.name}`)\n    }\n    return this._read(this.dataOffsetOf(entry), entry.compSize)\n  }\n\n  readEntryBuffer (entry) {\n    if (entry.method !== 0 && entry.method !== 8) {\n      throw fail(`不支持的压缩方法 ${entry.method}（只支持 0=store / 8=deflate）：${entry.name}`)\n    }\n    if (entry.uncompSize > MAX_ENTRY_BYTES) {\n      throw fail(`条目解压后过大（${entry.uncompSize} 字节 > ${MAX_ENTRY_BYTES}）：${entry.name}`)\n    }\n    const raw = this.readRaw(entry)\n    let out\n    if (entry.method === 0) {\n      if (raw.length !== entry.uncompSize) {\n        throw fail(`store 条目长度不符：${entry.name} 期望 ${entry.uncompSize} 实际 ${raw.length}`)\n      }\n      out = raw\n    } else {\n      try {\n        out = zlib.inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES })\n      } catch (e) {\n        throw fail(`解压失败（deflate）：${entry.name} — ${msgOf(e)}`)\n      }\n      if (out.length !== entry.uncompSize) {\n        throw fail(`deflate 条目长度不符：${entry.name} 期望 ${entry.uncompSize} 实际 ${out.length}`)\n      }\n    }\n    if (crc32(out) !== entry.crc) throw fail(`CRC 校验失败：${entry.name}`)\n    return out\n  }\n}\n\nfunction parseCentralDirectory (cd, count) {\n  const entries = []\n  let p = 0\n  for (let i = 0; i < count; i++) {\n    if (p + 46 > cd.length) throw fail(`中央目录损坏：第 ${i} 个条目头被截断`)\n    if (cd.readUInt32LE(p) !== SIG_CENTRAL) throw fail(`中央目录损坏：第 ${i} 个条目签名不符`)\n\n    const versionMadeBy = cd.readUInt16LE(p + 4)\n    const versionNeeded = cd.readUInt16LE(p + 6)\n    const flags = cd.readUInt16LE(p + 8)\n    const method = cd.readUInt16LE(p + 10)\n    const time = cd.readUInt16LE(p + 12)\n    const date = cd.readUInt16LE(p + 14)\n    const crc = cd.readUInt32LE(p + 16)\n    let compSize = cd.readUInt32LE(p + 20)\n    let uncompSize = cd.readUInt32LE(p + 24)\n    const nameLen = cd.readUInt16LE(p + 28)\n    const extraLen = cd.readUInt16LE(p + 30)\n    const commentLen = cd.readUInt16LE(p + 32)\n    let diskStart = cd.readUInt16LE(p + 34)\n    const intAttr = cd.readUInt16LE(p + 36)\n    const extAttr = cd.readUInt32LE(p + 38)\n    let localOffset = cd.readUInt32LE(p + 42)\n    const nameAt = p + 46\n    const rawName = cd.subarray(nameAt, nameAt + nameLen)\n    const extraAt = nameAt + nameLen\n    const extra = cd.subarray(extraAt, extraAt + extraLen)\n    const comment = cd.subarray(extraAt + extraLen, extraAt + extraLen + commentLen)\n    p = extraAt + extraLen + commentLen\n\n    // zip64 扩展字段 0x0001：按 uncomp / comp / offset / disk 的固定顺序补齐被置满的字段\n    let ep = 0\n    while (ep + 4 <= extra.length) {\n      const id = extra.readUInt16LE(ep)\n      const len = extra.readUInt16LE(ep + 2)\n      if (ep + 4 + len > extra.length) break\n      if (id === 0x0001) {\n        let q = ep + 4\n        if (uncompSize === U32_MAX) { uncompSize = Number(extra.readBigUInt64LE(q)); q += 8 }\n        if (compSize === U32_MAX) { compSize = Number(extra.readBigUInt64LE(q)); q += 8 }\n        if (localOffset === U32_MAX) { localOffset = Number(extra.readBigUInt64LE(q)); q += 8 }\n        if (diskStart === U16_MAX) { diskStart = extra.readUInt32LE(q); q += 4 }\n      }\n      ep += 4 + len\n    }\n\n    const name = decodeZipName(rawName, flags)\n    if (flags & 0x0001) throw fail(`ZIP 条目已加密（不支持解密）：${name}`)\n    if (diskStart !== 0) throw fail(`ZIP 是分卷压缩包（不支持）：${name}`)\n\n    entries.push({\n      index: i, name, rawName, flags, method, time, date, crc,\n      compSize, uncompSize, localHeaderOffset: localOffset,\n      versionMadeBy, versionNeeded, intAttr, extAttr, comment\n    })\n  }\n  return entries\n}\n\n// ---------------------------------------------------------------- ZIP 写\n\nfunction compressByMethod (content, method) {\n  if (method === 0) return content\n  if (method === 8) return zlib.deflateRawSync(content, { level: 6 })\n  throw fail(`不支持的压缩方法 ${method}（只支持 0=store / 8=deflate）`)\n}\n\n/** 条目名的原始字节：新条目用 UTF-8 编码结果，从包里读出来的条目沿用原字节（保持名字编码不失真）。 */\nconst nameBytesOf = (e) => e.nameBuf || e.rawName || EMPTY\n\n/** 条目压缩数据的来源：要么在内存里（新内容），要么是源包里的字节区间（原样搬运，省内存）。 */\nconst dataLengthOf = (e) => (e.copyFrom ? e.copyFrom.length : e.data.length)\n\n/** 写入前的 zip64 预算检查：宁可明确报错，也不写出坏包。 */\nfunction assertWritableZip32 (entries) {\n  if (entries.length > U16_MAX) {\n    throw fail(`条目数 ${entries.length} 超过 65535，需要 zip64（当前实现不支持写出 zip64）`)\n  }\n  let end = 0\n  let cdSize = 0\n  for (const e of entries) {\n    if (e.compSize > U32_MAX || e.uncompSize > U32_MAX) {\n      throw fail(`条目 ${e.name} 超过 4GB，需要 zip64（当前实现不支持写出 zip64）`)\n    }\n    end += 30 + nameBytesOf(e).length + dataLengthOf(e)\n    cdSize += 46 + nameBytesOf(e).length + e.comment.length\n  }\n  if (end + cdSize + 22 > U32_MAX) {\n    throw fail('归档总大小超过 4GB，需要 zip64（当前实现不支持写出 zip64）')\n  }\n}\n\n/** 分块搬运源包里的字节区间：修一个大 CBZ 时不必把整包读进内存。 */\nfunction copyRange (srcFd, srcPos, length, dstFd) {\n  const buf = Buffer.allocUnsafe(Math.min(length, 1024 * 1024) || 1)\n  let done = 0\n  while (done < length) {\n    const want = Math.min(buf.length, length - done)\n    const n = fs.readSync(srcFd, buf, 0, want, srcPos + done)\n    if (n <= 0) throw fail(`读取源 ZIP 失败：偏移 ${srcPos + done} 处意外结束`)\n    writeAll(dstFd, buf.subarray(0, n))\n    done += n\n  }\n}\n\n/**\n * 顺序写 ZIP 到临时文件：local header + data 逐条落盘，最后中央目录 + EOCD。\n * entries 数组顺序即输出顺序（EPUB 要求 mimetype 是第一条且 store）。\n * 只写临时文件、不负责改名：zip-replace 需要先关掉源句柄（outFile 可能等于源文件）再改名。\n */\nfunction writeZipTmp (outFile, entries) {\n  assertWritableZip32(entries)\n  fs.mkdirSync(path.dirname(outFile), { recursive: true })\n  const tmp = `${outFile}.mediakit-${process.pid}.tmp`\n  const fd = fs.openSync(tmp, 'w')\n  let offset = 0\n  const placed = []\n  try {\n    for (const e of entries) {\n      const flags = e.flags & ~0x0008 // 我们自己写真实 size，不用 data descriptor\n      const nameBuf = nameBytesOf(e)\n      const local = Buffer.alloc(30)\n      local.writeUInt32LE(SIG_LOCAL, 0)\n      local.writeUInt16LE(e.versionNeeded || 20, 4)\n      local.writeUInt16LE(flags, 6)\n      local.writeUInt16LE(e.method, 8)\n      local.writeUInt16LE(e.time, 10)\n      local.writeUInt16LE(e.date, 12)\n      local.writeUInt32LE(e.crc >>> 0, 14)\n      local.writeUInt32LE(e.compSize, 18)\n      local.writeUInt32LE(e.uncompSize, 22)\n      local.writeUInt16LE(nameBuf.length, 26)\n      local.writeUInt16LE(0, 28)\n      writeAll(fd, local)\n      writeAll(fd, nameBuf)\n      if (e.copyFrom) copyRange(e.copyFrom.fd, e.copyFrom.pos, e.copyFrom.length, fd)\n      else writeAll(fd, e.data)\n      placed.push({ e, flags, nameBuf, offset })\n      offset += 30 + nameBuf.length + dataLengthOf(e)\n    }\n\n    const cdStart = offset\n    for (const { e, flags, nameBuf, offset: localOffset } of placed) {\n      const cd = Buffer.alloc(46)\n      cd.writeUInt32LE(SIG_CENTRAL, 0)\n      cd.writeUInt16LE(e.versionMadeBy || 20, 4)\n      cd.writeUInt16LE(e.versionNeeded || 20, 6)\n      cd.writeUInt16LE(flags, 8)\n      cd.writeUInt16LE(e.method, 10)\n      cd.writeUInt16LE(e.time, 12)\n      cd.writeUInt16LE(e.date, 14)\n      cd.writeUInt32LE(e.crc >>> 0, 16)\n      cd.writeUInt32LE(e.compSize, 20)\n      cd.writeUInt32LE(e.uncompSize, 24)\n      cd.writeUInt16LE(nameBuf.length, 28)\n      cd.writeUInt16LE(0, 30)\n      cd.writeUInt16LE(e.comment.length, 32)\n      cd.writeUInt16LE(0, 34)\n      cd.writeUInt16LE(e.intAttr || 0, 36)\n      cd.writeUInt32LE(e.extAttr >>> 0, 38)\n      cd.writeUInt32LE(localOffset, 42)\n      writeAll(fd, cd)\n      writeAll(fd, nameBuf)\n      writeAll(fd, e.comment)\n      offset += cd.length + nameBuf.length + e.comment.length\n    }\n    const cdSize = offset - cdStart\n\n    const eocd = Buffer.alloc(22)\n    eocd.writeUInt32LE(SIG_EOCD, 0)\n    eocd.writeUInt16LE(0, 4)\n    eocd.writeUInt16LE(0, 6)\n    eocd.writeUInt16LE(entries.length, 8)\n    eocd.writeUInt16LE(entries.length, 10)\n    eocd.writeUInt32LE(cdSize, 12)\n    eocd.writeUInt32LE(cdStart, 16)\n    eocd.writeUInt16LE(0, 20)\n    writeAll(fd, eocd)\n    offset += eocd.length\n  } catch (e) {\n    try { fs.closeSync(fd) } catch { /* 已关 */ }\n    try { fs.unlinkSync(tmp) } catch { /* 没写成 */ }\n    throw e\n  }\n  fs.closeSync(fd)\n  return { tmp, size: offset, count: entries.length }\n}\n\n/** 写完临时文件再改名：中途失败不会留下半个坏包。 */\nfunction writeZipFile (outFile, entries) {\n  const r = writeZipTmp(outFile, entries)\n  fs.renameSync(r.tmp, outFile)\n  return r\n}\n\n/** 新条目（zip-write / zip-replace 的 add）——自带元信息，字节按 UTF-8 名 + 可选 deflate。 */\nfunction makeNewEntry (name, content, compress) {\n  const { buf: nameBuf, utf8 } = encodeZipName(name)\n  const method = compress ? 8 : 0\n  const data = compressByMethod(content, method)\n  const { time, date } = dosDateTime()\n  return {\n    name, nameBuf, flags: utf8 ? 0x0800 : 0, method, time, date,\n    crc: crc32(content), compSize: data.length, uncompSize: content.length, data,\n    versionMadeBy: 20, versionNeeded: 20, intAttr: 0, extAttr: 0, comment: EMPTY\n  }\n}\n\nfunction contentOf (spec, what) {\n  if (spec.fromFile != null) return readFileCapped(String(spec.fromFile), what)\n  if (spec.base64 != null) return Buffer.from(String(spec.base64), 'base64')\n  return EMPTY\n}\n\n// ---------------------------------------------------------------- op 实现\n\nfunction opHash (req) {\n  if (!Array.isArray(req.files)) throw fail('files 必须是数组')\n  const hashes = {}\n  for (const file of req.files) {\n    const key = String(file)\n    try {\n      hashes[key] = sha256File(key)\n    } catch (e) {\n      logWarn(`hash 跳过 ${key}：${msgOf(e)}`)\n      hashes[key] = null\n    }\n  }\n  return { hashes }\n}\n\nfunction opZipList (req) {\n  const file = requireAbsPath(req.file, 'file')\n  const zr = new ZipReader(file)\n  try {\n    return {\n      entries: zr.entries.map((e) => ({\n        name: e.name,\n        size: e.uncompSize,\n        compressedSize: e.compSize,\n        method: e.method,\n        crc32: e.crc,\n        index: e.index\n      })),\n      count: zr.entries.length\n    }\n  } finally {\n    zr.close()\n  }\n}\n\nfunction opZipRead (req) {\n  const file = requireAbsPath(req.file, 'file')\n  const name = String(req.name)\n  const zr = new ZipReader(file)\n  try {\n    const entry = zr.entries.find((e) => e.name === name)\n    if (!entry) throw fail(`ZIP 中不存在条目：${name}`)\n    const data = zr.readEntryBuffer(entry)\n    return { base64: data.toString('base64'), size: data.length }\n  } finally {\n    zr.close()\n  }\n}\n\nfunction opZipExtract (req) {\n  const file = requireAbsPath(req.file, 'file')\n  const outDir = requireAbsPath(req.outDir, 'outDir')\n  const wanted = Array.isArray(req.names) ? new Set(req.names.map(String)) : null\n  const zr = new ZipReader(file)\n  try {\n    // 先整体校验再落盘：坏包里有一条穿越条目时，一个文件都不写出去。\n    const plans = []\n    for (const e of zr.entries) {\n      if (e.name.endsWith('/')) continue // 目录条目：写文件时自然建目录\n      if (wanted && !wanted.has(e.name)) continue\n      const rel = safeRelativeName(e.name)\n      const target = path.join(outDir, rel)\n      assertInside(path.resolve(outDir), path.resolve(target))\n      plans.push({ e, target })\n    }\n    const files = []\n    for (const { e, target } of plans) {\n      const data = zr.readEntryBuffer(e)\n      fs.mkdirSync(path.dirname(target), { recursive: true })\n      fs.writeFileSync(target, data)\n      files.push({ name: e.name, path: target, size: data.length })\n    }\n    return { files }\n  } finally {\n    zr.close()\n  }\n}\n\nfunction opZipWrite (req) {\n  const file = requireAbsPath(req.file, 'file')\n  if (!Array.isArray(req.entries)) throw fail('entries 必须是数组')\n  const entries = req.entries.map((it) => {\n    if (!it || typeof it !== 'object') throw fail('entries 的元素必须是对象')\n    const name = normalizeWriteName(it.name)\n    return makeNewEntry(name, contentOf(it, 'entry'), it.compress !== false)\n  })\n  const r = writeZipFile(file, entries)\n  return { size: r.size, count: r.count }\n}\n\nfunction opZipReplace (req) {\n  const file = requireAbsPath(req.file, 'file')\n  const outFile = requireAbsPath(req.outFile, 'outFile')\n  const replacements = req.replacements == null ? [] : req.replacements\n  const add = req.add == null ? [] : req.add\n  const remove = req.remove == null ? [] : req.remove\n  if (!Array.isArray(replacements) || !Array.isArray(add) || !Array.isArray(remove)) {\n    throw fail('replacements/add/remove 必须是数组')\n  }\n\n  const zr = new ZipReader(file)\n  let entries\n  let replaced = 0\n  let removed = 0\n  try {\n    const byName = new Map(zr.entries.map((e) => [e.name, e]))\n    const repl = new Map()\n    for (const r of replacements) {\n      if (!r || typeof r !== 'object') throw fail('replacements 的元素必须是对象')\n      const name = String(r.name)\n      if (!byName.has(name)) throw fail(`替换目标不存在于 ZIP 中：${name}`)\n      repl.set(name, r)\n    }\n    const removeSet = new Set(remove.map(String))\n\n    entries = []\n    for (const e of zr.entries) {\n      if (removeSet.has(e.name)) { removed++; continue }\n      const r = repl.get(e.name)\n      if (!r) {\n        // 未改动条目：原地引用源包里的压缩字节区间，CRC/时间/名字字节全按原样搬运，\n        // 只有 local header 偏移会变（写入时逐块搬运，不把整包读进内存）。\n        entries.push({ ...e, copyFrom: { fd: zr.fd, pos: zr.dataOffsetOf(e), length: e.compSize } })\n        continue\n      }\n      // 被替换条目：保持原压缩方法（原来 deflate 仍 deflate，原来 store 仍 store），元信息沿用原条目。\n      const content = contentOf(r, 'replacement')\n      const data = compressByMethod(content, e.method)\n      entries.push({ ...e, data, crc: crc32(content), compSize: data.length, uncompSize: content.length })\n      replaced++\n    }\n  } catch (e) {\n    zr.close()\n    throw e\n  }\n\n  const addNames = new Set()\n  for (const a of add) {\n    if (!a || typeof a !== 'object') throw fail('add 的元素必须是对象')\n    const name = normalizeWriteName(a.name)\n    if (addNames.has(name)) throw fail(`add 中有重复条目名：${name}`)\n    addNames.add(name)\n    if (byNameHas(entries, name)) logWarn(`add 的条目名与已有条目重名（将出现重复条目）：${name}`)\n    entries.push(makeNewEntry(name, contentOf(a, 'add'), a.compress !== false))\n  }\n\n  let written\n  try {\n    written = writeZipTmp(outFile, entries) // 这一步还在从源包读字节，源句柄必须留着\n  } catch (e) {\n    zr.close()\n    throw e\n  }\n  zr.close() // 关掉源句柄再改名：outFile 可能等于 file，Windows 下改名要确保句柄已释放\n  fs.renameSync(written.tmp, outFile)\n  return { size: written.size, replaced, added: add.length, removed }\n}\n\nconst byNameHas = (entries, name) => entries.some((e) => e.name === name)\n\nfunction opProbe () {\n  // 如实探测能力，而不是硬编码 true。\n  let zlibOk = false\n  try {\n    const probe = Buffer.from('mediakit probe 中文', 'utf8')\n    zlibOk = zlib.inflateRawSync(zlib.deflateRawSync(probe)).equals(probe)\n  } catch { zlibOk = false }\n  return {\n    node: process.version,\n    zlib: zlibOk,\n    fetch: typeof globalThis.fetch === 'function',\n    zip64Read: true,\n    zip64Write: false\n  }\n}\n\n// ---------------------------------------------------------------- HTTP\n\nfunction httpJsonFallback (url, method, headers, body, timeoutMs) {\n  return new Promise((resolve, reject) => {\n    let u\n    try { u = new URL(url) } catch (e) { reject(fail(`url 非法：${url}`)); return }\n    const mod = u.protocol === 'https:' ? https : (u.protocol === 'http:' ? http : null)\n    if (!mod) { reject(fail(`不支持的协议：${u.protocol}`)); return }\n    const req = mod.request(u, { method, headers }, (res) => {\n      const chunks = []\n      let len = 0\n      res.setEncoding('utf8')\n      res.on('data', (c) => {\n        if (len < MAX_BODY_CHARS) { chunks.push(c); len += c.length }\n      })\n      res.on('end', () => resolve({ status: res.statusCode || 0, text: chunks.join('') }))\n      res.on('error', reject)\n    })\n    if (timeoutMs > 0) req.setTimeout(timeoutMs, () => req.destroy(new Error(`请求超时（${timeoutMs}ms）`)))\n    req.on('error', reject)\n    if (body !== undefined) req.write(body)\n    req.end()\n  })\n}\n\nasync function httpRequest (url, method, headers, body, timeoutMs) {\n  if (typeof globalThis.fetch === 'function') {\n    const init = { method, headers, redirect: 'follow' }\n    if (body !== undefined) init.body = body\n    if (timeoutMs > 0) init.signal = AbortSignal.timeout(timeoutMs)\n    try {\n      const res = await fetch(url, init)\n      const text = await res.text()\n      return { status: res.status, text }\n    } catch (e) {\n      const cause = e && e.cause && e.cause.message ? `（${e.cause.message}）` : ''\n      if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw fail(`请求超时（${timeoutMs}ms）：${url}`)\n      throw fail(`网络请求失败：${msgOf(e)}${cause} — ${url}`)\n    }\n  }\n  logWarn('当前 Node 没有全局 fetch，改用 http/https 内置模块')\n  return httpJsonFallback(url, method, headers, body, timeoutMs)\n}\n\nasync function opHttpJson (req) {\n  const url = String(req.url || '')\n  if (!/^https?:\\/\\//i.test(url)) throw fail(`url 必须是 http(s) 绝对地址：${url || '(缺失)'}`)\n  const headers = {}\n  if (req.headers != null) {\n    if (typeof req.headers !== 'object' || Array.isArray(req.headers)) throw fail('headers 必须是对象')\n    for (const [k, v] of Object.entries(req.headers)) headers[k] = String(v)\n  }\n  const hasHeader = (n) => Object.keys(headers).some((k) => k.toLowerCase() === n)\n  const method = String(req.method || (req.body === undefined && req.bodyBase64 === undefined ? 'GET' : 'POST')).toUpperCase()\n\n  let body\n  if (req.bodyBase64 !== undefined) {\n    body = Buffer.from(String(req.bodyBase64), 'base64') // 扩展：OCR 直接上传二进制（调用方自己设 Content-Type）\n  } else if (req.body !== undefined && req.body !== null) {\n    if (typeof req.body === 'string') body = req.body\n    else {\n      body = JSON.stringify(req.body)\n      if (!hasHeader('content-type')) headers['Content-Type'] = 'application/json'\n    }\n  }\n  if (body !== undefined && (method === 'GET' || method === 'HEAD')) {\n    throw fail(`${method} 请求不能带 body`)\n  }\n\n  // 默认 150s：调用方（media.js httpJson）在不传 timeoutMs 时给的宽限是 180s，\n  // 这里必须更早收手，才能把「超时」当成一次干净的 ok:false 返回，而不是被外面掐死。\n  const timeoutMs = Number.isFinite(req.timeoutMs) && req.timeoutMs > 0 ? Number(req.timeoutMs) : 150000\n  const started = Date.now()\n  const res = await httpRequest(url, method, headers, body, timeoutMs)\n  const ms = Date.now() - started\n  const out = { status: res.status, text: res.text.slice(0, TEXT_LIMIT), ms }\n  try {\n    out.json = JSON.parse(res.text)\n  } catch {\n    // 响应不是 JSON：留给调用方看 text/status，4xx/5xx 不算本工具的失败\n  }\n  return out\n}\n\n// ---------------------------------------------------------------- 调度\n\nasync function runOp (req) {\n  if (!req || typeof req !== 'object' || Array.isArray(req)) throw fail('入参必须是 JSON 对象')\n  switch (String(req.op || '')) {\n    case 'hash': return opHash(req)\n    case 'zip-list': return opZipList(req)\n    case 'zip-read': return opZipRead(req)\n    case 'zip-extract': return opZipExtract(req)\n    case 'zip-write': return opZipWrite(req)\n    case 'zip-replace': return opZipReplace(req)\n    case 'http-json': return opHttpJson(req)\n    case 'probe': return opProbe()\n    default: throw fail(`未知的 op：${String(req.op || '(缺失)')}`)\n  }\n}\n\nconst stripBom = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s)\n\nasync function main () {\n  const [inPath, outPath] = process.argv.slice(2)\n  if (!inPath || !outPath) {\n    process.stderr.write('用法：node mediakit.js <in.json> <out.json>\\n')\n    return 2\n  }\n\n  let out\n  try {\n    const req = JSON.parse(stripBom(fs.readFileSync(inPath, 'utf8')))\n    out = Object.assign({ ok: true }, await runOp(req))\n  } catch (e) {\n    process.stderr.write(`[mediakit] ${msgOf(e)}\\n`)\n    if (e && e.stack && !e.expected) process.stderr.write(`${e.stack}\\n`)\n    out = { ok: false, error: msgOf(e) }\n  }\n\n  try {\n    fs.mkdirSync(path.dirname(outPath), { recursive: true })\n    fs.writeFileSync(outPath, JSON.stringify(out), 'utf8')\n    return 0\n  } catch (e) {\n    process.stderr.write(`[mediakit] 无法写出 ${outPath}：${msgOf(e)}\\n`)\n    return 1\n  }\n}\n\n// 同目录下若被当作 ESM 加载也不会走到这里（那是另一个进程形态）；本文件按 CLI 使用。\nmain().then(\n  (code) => { process.exitCode = code },\n  (e) => {\n    process.stderr.write(`[mediakit] 崩溃：${msgOf(e)}\\n${(e && e.stack) || ''}\\n`)\n    process.exitCode = 1\n  }\n)\n",
    "runprobe.js": "/**\n * runprobe —— 在子进程里执行一个外部可执行文件并把 stdout/stderr 落到**普通文件**。\n *\n * 为什么需要它：DSH 沙箱下用管道捕获子进程输出会 EPERM（named pipe 不可用），\n * 而 skill/能力探测（ffmpeg -version、python -c、tesseract --version）需要读出文本。\n * 这里在 node 子进程内部用 spawnSync + **文件描述符**重定向（不是管道），\n * 因此两层沙箱都能用。\n *\n * 契约：node runprobe.js <in.json> <stdout.txt> <meta.json>\n *   in.json: { \"exe\": \"<绝对路径或 PATH 里的名字>\", \"args\": [...], \"timeoutMs\": n }\n *   stdout.txt: 子进程的 stdout + stderr（合并，截断到 200000 字符）\n *   meta.json: { ok: true, code, error }\n */\n'use strict'\n\nconst fs = require('node:fs')\nconst cp = require('node:child_process')\n\nconst OUT_LIMIT = 200000\n\nfunction main () {\n  const inPath = process.argv[2]\n  const stdoutPath = process.argv[3]\n  const metaPath = process.argv[4]\n  const meta = { ok: true, code: -1, error: null }\n  try {\n    const req = JSON.parse(fs.readFileSync(inPath, 'utf8'))\n    const timeoutMs = Number(req.timeoutMs) > 0 ? Number(req.timeoutMs) : 60000\n    let fd = null\n    try {\n      fd = fs.openSync(stdoutPath, 'w')\n      const res = cp.spawnSync(req.exe, Array.isArray(req.args) ? req.args : [], {\n        stdio: ['ignore', fd, fd],\n        timeout: timeoutMs,\n        windowsHide: true,\n      })\n      meta.code = res.status === null ? -1 : res.status\n      if (res.error) meta.error = String(res.error.message || res.error)\n    } finally {\n      if (fd !== null) { try { fs.closeSync(fd) } catch (e) {} }\n      // 超大输出截断，避免把 100MB 的日志搬回 host\n      try {\n        const st = fs.statSync(stdoutPath)\n        if (st.size > OUT_LIMIT) {\n          const fh = fs.openSync(stdoutPath, 'r')\n          const buf = Buffer.alloc(OUT_LIMIT)\n          fs.readSync(fh, buf, 0, OUT_LIMIT, 0)\n          fs.closeSync(fh)\n          fs.writeFileSync(stdoutPath, buf)\n        }\n      } catch (e) {}\n    }\n  } catch (e) {\n    meta.ok = false\n    meta.error = String((e && e.message) || e)\n  }\n  fs.writeFileSync(metaPath, JSON.stringify(meta), 'utf8')\n}\n\nmain()\n",
    "winocr.ps1": "﻿<#\n  winocr.ps1 —— Windows 内置 OCR（Windows.Media.Ocr / WinRT）桥接脚本\n  ------------------------------------------------------------------\n  用途：在零安装、零 token 的前提下对图片做中文/英文 OCR，是漫画与图片艺术字\n        汉化的本地快路径。\n\n  调用契约（必须使用 Windows PowerShell 5.1，pwsh 未安装）：\n    powershell.exe -NoProfile -ExecutionPolicy Bypass -File winocr.ps1 -In <in.json> -Out <out.json>\n\n  in.json (UTF-8)：\n    { \"images\": [ { \"path\": \"C:\\\\...\\\\p1.png\", \"lang\": \"zh-Hans-CN\" } ],\n      \"langs\": [\"zh-Hans-CN\",\"en-US\"], \"maxDim\": 4000 }\n\n  out.json (UTF-8, 无 BOM)：\n    { \"ok\": true, \"availableLangs\": [...], \"maxImageDimension\": 10000,\n      \"results\": [ { \"path\": ..., \"ok\": true, \"lang\": ..., \"width\": ..., \"height\": ...,\n                     \"text\": ..., \"lines\": [ { \"text\": ..., \"words\": [ {text,x,y,w,h} ] } ] } ] }\n\n  每条结果额外带两个诊断字段（不影响上面的契约字段）：\n    * langRequested：本条命中的语言标签；走用户配置语言兜底时为 \"<user-profile>\"。\n    * scale：本条实际缩放系数（1 表示未缩放）；words 的 x/y/w/h 一律是【原图坐标】。\n\n  约定：\n    * out.json 始终写出（成功/失败都写）；退出码 0 表示 out.json 已写出。\n    * 单张图失败不影响其它图片，整体仍 ok:true。\n    * 顶层严重失败（入参解析失败 / 无任何 OCR 引擎）→ { \"ok\": false, \"error\": \"...\" }。\n    * 批量：一次进程内处理所有图片，不每张图重启 PowerShell。\n\n  注意：本文件必须保存为 UTF-8 with BOM。PowerShell 5.1 读取无 BOM 的 .ps1 时\n        会按系统 ANSI 代码页解码，导致中文注释/字符串乱码甚至语法错误。\n#>\nparam(\n  [string]$In,\n  [string]$Out\n)\n\n$ErrorActionPreference = 'Stop'\n$ProgressPreference = 'SilentlyContinue'\n$WarningPreference = 'SilentlyContinue'\n$VerbosePreference = 'SilentlyContinue'\n# 屏蔽 WinRT/类型加载可能产生的控制台噪声（进度条、警告等一律不进 out.json）\n$null = [Console]::OutputEncoding\n\n$script:OutPath = $Out\n\n# ---------------------------------------------------------------------------\n# 输出：始终以无 BOM 的 UTF-8 写出 out.json\n# ---------------------------------------------------------------------------\nfunction Write-OutJson {\n  param([hashtable]$Payload)\n  if ([string]::IsNullOrWhiteSpace($script:OutPath)) { return $false }\n  try {\n    $full = [System.IO.Path]::GetFullPath($script:OutPath)\n    $dir = [System.IO.Path]::GetDirectoryName($full)\n    if ($dir -and -not [System.IO.Directory]::Exists($dir)) {\n      $null = [System.IO.Directory]::CreateDirectory($dir)\n    }\n    # PS 5.1 的 ConvertTo-Json 默认不转义非 ASCII，中文原样输出\n    $json = $Payload | ConvertTo-Json -Depth 16 -Compress\n    $enc = New-Object System.Text.UTF8Encoding($false)   # $false = 不写 BOM\n    [System.IO.File]::WriteAllText($full, $json, $enc)\n    return $true\n  } catch {\n    # 兜底：至少尝试用 Set-Content（PS5.1 会带 BOM，但 JSON 仍合法）\n    try { $Payload | ConvertTo-Json -Depth 16 -Compress | Set-Content -LiteralPath $script:OutPath -Encoding UTF8; return $true } catch { return $false }\n  }\n}\n\nfunction Exit-WithFatal {\n  param([string]$Message)\n  $null = Write-OutJson @{ ok = $false; error = $Message }\n  exit 0\n}\n\n# ---------------------------------------------------------------------------\n# WinRT 异步 → .NET Task 的 Await 辅助（原型同款写法，增强异常解包）\n# ---------------------------------------------------------------------------\n$script:AsTaskGeneric = $null\n\nfunction Initialize-WinRt {\n  Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null\n  $script:AsTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {\n    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'\n  })[0]\n  if (-not $script:AsTaskGeneric) { throw '找不到 AsTask(IAsyncOperation<T>) 泛型方法，无法桥接 WinRT 异步调用' }\n\n  # 预加载本脚本用到的 WinRT 类型（ContentType=WindowsRuntime）\n  $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]\n  $null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime]\n  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType=WindowsRuntime]\n  $null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics, ContentType=WindowsRuntime]\n  $null = [Windows.Graphics.Imaging.BitmapTransform, Windows.Graphics, ContentType=WindowsRuntime]\n  $null = [Windows.Graphics.Imaging.BitmapPixelFormat, Windows.Graphics, ContentType=WindowsRuntime]\n  $null = [Windows.Graphics.Imaging.BitmapAlphaMode, Windows.Graphics, ContentType=WindowsRuntime]\n  $null = [Windows.Graphics.Imaging.BitmapInterpolationMode, Windows.Graphics, ContentType=WindowsRuntime]\n  $null = [Windows.Graphics.Imaging.ExifOrientationMode, Windows.Graphics, ContentType=WindowsRuntime]\n  $null = [Windows.Graphics.Imaging.ColorManagementMode, Windows.Graphics, ContentType=WindowsRuntime]\n  $null = [Windows.Globalization.Language, Windows.Globalization, ContentType=WindowsRuntime]\n  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]\n}\n\nfunction Await {\n  param($WinRtTask, [Type]$ResultType)\n  $asTask = $script:AsTaskGeneric.MakeGenericMethod($ResultType)\n  $netTask = $asTask.Invoke($null, @($WinRtTask))\n  try {\n    $netTask.Wait(-1) | Out-Null\n  } catch {\n    # Wait() 会把真实异常包进 AggregateException，PowerShell 又包了一层\n    # MethodInvocationException，这里逐层解包，保证错误信息可读（例如\"文件损坏\"）\n    $ex = $_.Exception\n    while ($ex.InnerException -and (\n        $ex -is [System.AggregateException] -or\n        $ex -is [System.Management.Automation.MethodInvocationException] -or\n        $ex -is [System.Reflection.TargetInvocationException])) {\n      $ex = $ex.InnerException\n    }\n    throw $ex\n  }\n  return $netTask.Result\n}\n\n# ---------------------------------------------------------------------------\n# 语言 / 引擎\n# ---------------------------------------------------------------------------\n$script:EngineCache = @{}\n\n# 用一个 BCP-47 标签构造 OcrEngine；不可用（本机无该语言识别器）时返回 $null。\n#\n# 关于 en-US 的踩坑结论（已实测）：New-Object 与 [Language]::new() 都能正确构造出\n# tag='en-US' 的 Language，TryCreateFromLanguage 也确实返回 en-US 引擎。\n# 之前观察到“传 en-US 却得到 zh-Hans-CN”，真因是 Language 构造那一步抛异常后被\n# catch 吞掉，代码继续走到 TryCreateFromUserProfileLanguages()（本机用户配置语言为\n# zh-Hans-CN），于是报告成了 zh-Hans-CN。因此这里绝不吞异常后静默回退：\n# 构造失败会走静态 new() 重试，两者都失败才算“该语言不可用”，并且由调用方明确\n# 决定是否使用用户配置语言兜底。\nfunction New-OcrEngineForTag {\n  param([string]$Tag)\n  if ([string]::IsNullOrWhiteSpace($Tag)) { return $null }\n  $tag = $Tag.Trim()\n  $language = $null\n  try { $language = New-Object Windows.Globalization.Language $tag } catch { $language = $null }\n  if (-not $language) {\n    try { $language = [Windows.Globalization.Language]::new($tag) } catch { $language = $null }\n  }\n  if (-not $language) { return $null }\n  try { return [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language) } catch { return $null }\n}\n\nfunction Get-OcrEngineForTag {\n  param([string]$Tag)\n  if ([string]::IsNullOrWhiteSpace($Tag)) { return $null }\n  $key = $Tag.Trim()\n  if ($script:EngineCache.ContainsKey($key)) { return $script:EngineCache[$key] }\n  $engine = New-OcrEngineForTag $key\n  $script:EngineCache[$key] = $engine\n  return $engine\n}\n\nfunction Get-UserProfileEngine {\n  if (-not $script:EngineCache.ContainsKey('__user_profile__')) {\n    $e = $null\n    try { $e = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() } catch { $e = $null }\n    $script:EngineCache['__user_profile__'] = $e\n  }\n  return $script:EngineCache['__user_profile__']\n}\n\n# ---------------------------------------------------------------------------\n# 工具\n# ---------------------------------------------------------------------------\nfunction Clamp-Int {\n  param([double]$Value, [int]$Min, [int]$Max)\n  $v = [int][Math]::Round($Value)\n  if ($v -lt $Min) { return $Min }\n  if ($v -gt $Max) { return $Max }\n  return $v\n}\n\nfunction New-BitmapTransform {\n  param([int]$Width, [int]$Height)\n  $t = $null\n  try { $t = New-Object Windows.Graphics.Imaging.BitmapTransform } catch { $t = $null }\n  if (-not $t) { $t = [Windows.Graphics.Imaging.BitmapTransform]::new() }\n  $t.ScaledWidth = [uint32]$Width\n  $t.ScaledHeight = [uint32]$Height\n  try { $t.InterpolationMode = [Windows.Graphics.Imaging.BitmapInterpolationMode]::Fant } catch { }\n  return $t\n}\n\n# ---------------------------------------------------------------------------\n# 单图 OCR\n# ---------------------------------------------------------------------------\nfunction Invoke-OcrOnImage {\n  param(\n    [string]$ImagePath,\n    [string[]]$LangChain,\n    [int]$MaxDim,\n    [int]$HardLimit\n  )\n\n  $displayPath = $ImagePath\n  $requested = if ($LangChain -and $LangChain.Count -gt 0) { $LangChain[0] } else { '' }\n\n  if ([string]::IsNullOrWhiteSpace($ImagePath)) {\n    return @{ path = $displayPath; ok = $false; langRequested = $requested; error = '图像路径为空' }\n  }\n\n  $fullPath = $ImagePath\n  try { $fullPath = [System.IO.Path]::GetFullPath($ImagePath) } catch { }\n  if (-not [System.IO.File]::Exists($fullPath)) {\n    return @{ path = $displayPath; ok = $false; langRequested = $requested; error = \"图像文件不存在或不可读: $ImagePath\" }\n  }\n\n  # 候选引擎链：images[i].lang → langs[]（已去重），逐个尝试\n  $candidates = @()\n  foreach ($tag in $LangChain) {\n    if ([string]::IsNullOrWhiteSpace($tag)) { continue }\n    $engine = Get-OcrEngineForTag $tag\n    if ($engine) { $candidates += @{ tag = $tag.Trim(); engine = $engine } }\n  }\n\n  $stream = $null\n  $bitmap = $null\n  try {\n    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($fullPath)) ([Windows.Storage.StorageFile])\n    $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])\n    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])\n\n    $origW = [int]$decoder.PixelWidth\n    $origH = [int]$decoder.PixelHeight\n\n    # 有效上限 = min(maxDim, OcrEngine.MaxImageDimension)，保证不超过硬上限\n    $cap = $MaxDim\n    if ($cap -le 0) { $cap = 4000 }\n    if ($HardLimit -gt 0 -and $cap -gt $HardLimit) { $cap = $HardLimit }\n\n    $longest = [Math]::Max($origW, $origH)\n    $scale = 1.0\n    if ($longest -gt $cap -and $longest -gt 0) { $scale = [double]$cap / [double]$longest }\n    $targetW = [int][Math]::Max(1, [Math]::Round($origW * $scale))\n    $targetH = [int][Math]::Max(1, [Math]::Round($origH * $scale))\n\n    # 解码为 Bgra8/Premultiplied（RecognizeAsync 对像素格式敏感；\n    # 非 Bgra8 一律 SoftwareBitmap.Convert）\n    if ($scale -lt 1.0) {\n      $transform = New-BitmapTransform -Width $targetW -Height $targetH\n      try {\n        $bitmap = Await ($decoder.GetSoftwareBitmapAsync(\n          [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,\n          [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied,\n          $transform,\n          [Windows.Graphics.Imaging.ExifOrientationMode]::IgnoreExifOrientation,\n          [Windows.Graphics.Imaging.ColorManagementMode]::DoNotColorManage)) ([Windows.Graphics.Imaging.SoftwareBitmap])\n      } catch {\n        # 个别解码器不支持 5 参重载时退回默认解码（后面统一做像素格式转换）\n        $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])\n      }\n    } else {\n      try {\n        $bitmap = Await ($decoder.GetSoftwareBitmapAsync(\n          [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,\n          [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied)) ([Windows.Graphics.Imaging.SoftwareBitmap])\n      } catch {\n        $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])\n      }\n    }\n\n    if ($bitmap.BitmapPixelFormat -ne [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8) {\n      $converted = [Windows.Graphics.Imaging.SoftwareBitmap]::Convert(\n        $bitmap,\n        [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,\n        [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied)\n      $bitmap.Dispose()\n      $bitmap = $converted\n    }\n\n    # 逐候选语言识别\n    $ocrResult = $null\n    $usedTag = $null\n    $usedEngine = $null\n    $attemptErrors = @()\n    foreach ($cand in $candidates) {\n      try {\n        $ocrResult = Await ($cand.engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])\n        $usedTag = $cand.tag\n        $usedEngine = $cand.engine\n        break\n      } catch {\n        $attemptErrors += (\"{0}: {1}\" -f $cand.tag, $_.Exception.Message)\n        $ocrResult = $null\n      }\n    }\n\n    # 全部候选失败 → 用户配置语言兜底\n    if (-not $ocrResult) {\n      $fallback = Get-UserProfileEngine\n      if ($fallback) {\n        try {\n          $ocrResult = Await ($fallback.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])\n          $usedTag = '<user-profile>'\n          $usedEngine = $fallback\n        } catch {\n          $attemptErrors += (\"<user-profile>: {0}\" -f $_.Exception.Message)\n          $ocrResult = $null\n        }\n      }\n    }\n\n    if (-not $ocrResult) {\n      $msg = if ($attemptErrors.Count -gt 0) { '所有候选语言均识别失败 -> ' + ($attemptErrors -join ' | ') } else { '没有可用于该图像的 OCR 引擎（请求语言均不可用）' }\n      return @{ path = $displayPath; ok = $false; langRequested = $requested; width = $origW; height = $origH; error = $msg }\n    }\n\n    # 坐标换算回原图：识别在缩放图上进行，除以 scale 即得原图坐标\n    $inv = if ($scale -gt 0) { 1.0 / $scale } else { 1.0 }\n    $lines = @()\n    foreach ($line in $ocrResult.Lines) {\n      $words = @()\n      foreach ($word in $line.Words) {\n        $rect = $word.BoundingRect\n        $x = Clamp-Int ($rect.X * $inv) 0 $origW\n        $y = Clamp-Int ($rect.Y * $inv) 0 $origH\n        $w = Clamp-Int ($rect.Width * $inv) 0 ($origW - $x)\n        $h = Clamp-Int ($rect.Height * $inv) 0 ($origH - $y)\n        $words += @{ text = $word.Text; x = $x; y = $y; w = $w; h = $h }\n      }\n      $lines += @{ text = $line.Text; words = $words }\n    }\n\n    $text = ($lines | ForEach-Object { $_.text }) -join \"`n\"\n\n    return @{\n      path          = $displayPath\n      ok            = $true\n      lang          = $usedEngine.RecognizerLanguage.LanguageTag   # 实际使用的识别语言\n      langRequested = $usedTag\n      width         = $origW\n      height        = $origH\n      scale         = [Math]::Round($scale, 6)\n      text          = $text\n      lines         = $lines\n    }\n  } catch {\n    return @{ path = $displayPath; ok = $false; langRequested = $requested; error = ('图像处理失败: ' + $_.Exception.Message) }\n  } finally {\n    if ($bitmap) { try { $bitmap.Dispose() } catch { } }\n    if ($stream) { try { $stream.Dispose() } catch { } }\n  }\n}\n\n# ---------------------------------------------------------------------------\n# 主流程\n# ---------------------------------------------------------------------------\n$script:AvailableLangs = @()\n$script:MaxImageDim = 0\n\ntry {\n  Initialize-WinRt\n} catch {\n  Exit-WithFatal ('WinRT 初始化失败（本机可能不支持 Windows.Media.Ocr）: ' + $_.Exception.Message)\n}\n\ntry {\n  $script:AvailableLangs = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag })\n} catch {\n  $script:AvailableLangs = @()\n}\ntry { $script:MaxImageDim = [int][Windows.Media.Ocr.OcrEngine]::MaxImageDimension } catch { $script:MaxImageDim = 0 }\n\nif ([string]::IsNullOrWhiteSpace($In)) { Exit-WithFatal '缺少 -In 入参（输入 JSON 路径）' }\nif ([string]::IsNullOrWhiteSpace($Out)) { exit 1 }\n\n# ---- 解析入参 ----\n$inputObject = $null\ntry {\n  $inFull = [System.IO.Path]::GetFullPath($In)\n  if (-not [System.IO.File]::Exists($inFull)) { Exit-WithFatal \"入参文件不存在: $In\" }\n  $rawText = [System.IO.File]::ReadAllText($inFull, (New-Object System.Text.UTF8Encoding($false)))\n  if ($rawText.Length -gt 0 -and $rawText[0] -eq [char]0xFEFF) { $rawText = $rawText.Substring(1) }\n  $inputObject = $rawText | ConvertFrom-Json\n} catch {\n  Exit-WithFatal ('解析入参 JSON 失败: ' + $_.Exception.Message)\n}\n\n$images = @()\nif ($inputObject -and $inputObject.PSObject.Properties['images'] -and $inputObject.images) {\n  $images = @($inputObject.images)\n}\nif ($images.Count -eq 0) { Exit-WithFatal '入参 JSON 中没有 images 数组或数组为空' }\n\n# ---- 语言回退链 ----\n$globalLangs = @()\nif ($inputObject.PSObject.Properties['langs'] -and $inputObject.langs) { $globalLangs = @($inputObject.langs | ForEach-Object { \"$_\" }) }\n\n# ---- 缩放上限 ----\n$maxDim = 4000\nif ($inputObject.PSObject.Properties['maxDim'] -and $null -ne $inputObject.maxDim) {\n  try { $maxDim = [int]$inputObject.maxDim } catch { $maxDim = 4000 }\n}\nif ($maxDim -le 0) { $maxDim = 4000 }\n\n# ---- 顶层：本机是否根本没有 OCR 引擎 ----\n$userProfileEngine = Get-UserProfileEngine\nif ($script:AvailableLangs.Count -eq 0 -and -not $userProfileEngine) {\n  Exit-WithFatal '本机没有任何可用的 Windows OCR 识别语言（AvailableRecognizerLanguages 为空且用户配置语言不可用）'\n}\n\n# ---- 批量处理（单进程内循环，避免每张图重启 PowerShell） ----\n$results = @()\nforeach ($img in $images) {\n  $imgPath = ''\n  $imgLang = ''\n  if ($img -is [string]) {\n    $imgPath = \"$img\"\n  } else {\n    if ($img.PSObject.Properties['path'] -and $null -ne $img.path) { $imgPath = \"$($img.path)\" }\n    if ($img.PSObject.Properties['lang'] -and $null -ne $img.lang) { $imgLang = \"$($img.lang)\" }\n  }\n\n  # 回退链：本图 lang → 全局 langs（按顺序、去重）\n  $chain = New-Object System.Collections.ArrayList\n  foreach ($t in @($imgLang) + @($globalLangs)) {\n    if ([string]::IsNullOrWhiteSpace($t)) { continue }\n    $tt = \"$t\".Trim()\n    if (-not $chain.Contains($tt)) { $null = $chain.Add($tt) }\n  }\n\n  $results += (Invoke-OcrOnImage -ImagePath $imgPath -LangChain @($chain) -MaxDim $maxDim -HardLimit $script:MaxImageDim)\n}\n\n# ---- 汇总输出 ----\n$ok = Write-OutJson @{\n  ok                = $true\n  availableLangs    = @($script:AvailableLangs)\n  maxImageDimension = $script:MaxImageDim\n  results           = @($results)\n}\nif (-not $ok) { exit 1 }\nexit 0\n",
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 汉化引擎 · 工具规格表（canonical tools）
  //
  // 两个信封共用这一份定义：
  //   · 静态插件（preset/plugins/hanhua/index.js）→ ctx.tools.register
  //   · 动态包（engine/host.js）→ harness.defineTool（仅作为契约参考，不注册到全局表）
  // run(args, exec) 返回可 JSON 化的结果；信封负责包 withExec / JSON.stringify。
  // ═══════════════════════════════════════════════════════════════════════════

  // 模型侧提示词里的工具指南（systemPrompt 片段）。分行书写，运行时 join('\n')。
  const GUIDE_LINES = [
    '汉化引擎工具指南（hanhua_*）：',
    '- 支持的汉化载体：① 游戏文本（RPG Maker MV/MZ 的 JSON、RGSS 家族 XP/VX/VX Ace/mkxp-z 的 .rxdata/.rvdata/.rvdata2 Ruby Marshal、krkr/KAG 的 .ks/.tjs/.scn、Ren\'Py，以及通用 JSON/CSV/PO/INI/YAML/TXT）；② 视频字幕（.srt/.vtt/.ass/.ssa/.lrc/.sub/.smi，以及 ffmpeg 可抽取的内嵌字幕轨）；③ 电子书（.epub 全量往返、.html/.xhtml、.pdf 文本层与内嵌图片、.txt）；④ 漫画与图片（.cbz/.zip 图包、图片目录、单图，以及游戏里的图片艺术字）。',
    '- 图文类载体（漫画页 / 图片艺术字 / 扫描件 / 游戏 UI 图）先走 hanhua_ocr：本地 Windows OCR 免费且不耗 token，识别不了（日文假名、描边艺术字）才升级到多模态模型，结果按图像哈希缓存，重复运行零成本。',
    '- 标准流程：hanhua_scan 扫描 → hanhua_parse 提取文本（errors 字段列出失败文件）→ hanhua_glossary 维护术语词典（人名/地名/道具名必须统一）→ hanhua_translate 翻译 → hanhua_qa 质检 → hanhua_export 写回。',
    '- 图文载体流程：hanhua_ocr（识别出带坐标的文本条目）→ hanhua_translate → hanhua_export：漫画页/T 图会擦除原文并按框自动排版译文回写图片；字幕与 EPUB 按原文件结构回写。',
    '- 视频字幕：hanhua_media action=subs-extract 从视频抽出字幕轨，翻译后用 action=subs-mux 回封（需要本机有 ffmpeg/ffprobe；没有时直接翻译外挂字幕文件）。',
    '- 词典/术语表优先级最高（完全匹配 > 子串最长优先 > 正则替换），词典未覆盖的文本才会调用在线翻译 API（需先 hanhua_config 配置 apiUrl/apiKey）。',
    '- 导出：mode=inplace 就地替换并自动生成 <file>.bak 备份（推荐）；mode=out 输出到 .hanhua-out/ 镜像目录；RGSS Marshal、krkr、EPUB/CBZ 按原格式原编码回写（ZIP 重打包保留条目顺序与压缩方式）。',
    '- 编码：XP/VX/Ace 游戏多为 GBK/Shift-JIS 字符串，如乱码请用 hanhua_config 设置 rgssEncoding（gbk/shift_jis）；krkr 文本同理设置 krkrEncoding；GBK/Shift-JIS 写回依赖 iconv-lite（桌面版安装会把它放在插件 node_modules 下，无需配置）。',
    '- 铁律：绝不破坏占位符（%s %d {0} \\N[1] \\V[5] \\C[2] <color=...> 等）、ASS 覆写标签（{\\an8} 等）、换行与 JSON/Marshal/EPUB 结构；翻译后用 hanhua_qa 复查。',
    '- 省 token：翻译自动跳过无字母/高中日韩占比条目、按原文+语境去重、按 apiChunk 分批；OCR 本地优先＋哈希缓存＋同图去重；所有工具只返回紧凑预览（≤20 条）与统计。用 hanhua_usage 查看省了多少（缓存命中、本地 OCR 命中、去重条数、API token 用量）。',
    '- 浏览器面板「汉化工作台」：0.1.6-alpha.2 起 cordis 工具已退役，需用 hanhua_workbench action=install 自装动态包，然后到 Cordis 面板点「批准」，面板出现在 设置 →「汉化工作台」；定义随进程存在，重启后重新 install。排错用 action=status。',
  ]

  const TOOL_SPECS = [
    {
      name: 'hanhua_scan',
      description: '扫描汉化项目目录，列出全部可汉化的资源文件：游戏文本（JSON/CSV/TSV/PO/TXT/INI/YAML/RenPy、RPG Maker MV/MZ、RPG Maker XP/VX/VX Ace/mkxp-z 的 .rxdata/.rvdata/.rvdata2、krkr/KAG 的 .ks/.tjs/.scn）、视频字幕（.srt/.vtt/.ass/.ssa/.lrc/.sub/.smi）、电子书（.epub/.pdf/.html/.xhtml）、漫画与图片（.cbz/.zip/.png/.jpg/.webp 等）。返回按类别统计的文件清单，供 hanhua_parse / hanhua_ocr 使用。',
      properties: {
        root: { type: 'string', description: '项目根目录，绝对路径或相对当前根目录；缺省用上次配置' },
        kinds: { type: 'array', items: { type: 'string', enum: ['game', 'subtitle', 'ebook', 'image'] }, description: '只扫描指定类别（缺省全部）' },
        limit: { type: 'number', description: '最多返回文件条数，默认 200，上限 2000' },
      },
      required: [],
      run: async (args) => scanRoot(args && args.root, args || {}),
    },
    {
      name: 'hanhua_parse',
      description: '解析扫描到的文本资源，提取全部可翻译字符串：RPG Maker MV/MZ 事件、RGSS 家族地图事件/数据库/System 术语/公共事件、krkr/KAG 文本（自动识别 UTF-16LE/UTF-8/Shift-JIS/GBK）、视频字幕（SRT/VTT/ASS/SSA/LRC，保留时间轴与 ASS 样式）、电子书 EPUB（OPF 脊柱顺序遍历 XHTML 文本节点）。失败的文件会列在 errors 中。返回 perFile（每文件条目数）与最多 20 条紧凑预览，节省上下文 token。',
      properties: {
        files: { type: 'array', items: { type: 'string' }, description: '只解析指定文件（相对路径列表）；缺省解析上次扫描结果' },
        root: { type: 'string', description: '项目根目录覆盖' },
      },
      required: [],
      run: async (args) => parseFiles((args && args.files) || null, args && args.root),
    },
    {
      name: 'hanhua_ocr',
      description: 'OCR 组件：从图片里识别文本（漫画页气泡、图片艺术字、游戏 UI 图、扫描件），产出带坐标与置信线索的文本条目，可直接进入 hanhua_translate/hanhua_export 流程。引擎链 auto：Windows 内置 OCR（本地、免费、零 token，支持中文/英文）→ 多模态视觉模型（识别日文假名、描边艺术字等本地引擎搞不定的内容，按图批量调用）→ tesseract（若本机装了）。省 token：按图像内容哈希缓存、相同图像去重、只对「有文字的区域」调用视觉模型、可用 budget 限制本次最多看几张图。',
      properties: {
        files: { type: 'array', items: { type: 'string' }, description: '要 OCR 的图片/漫画页（相对路径）；缺省用上次 hanhua_scan 的图片类结果' },
        root: { type: 'string', description: '项目根目录覆盖' },
        engine: { type: 'string', enum: ['auto', 'windows', 'vision', 'tesseract', 'none'], description: 'OCR 引擎：auto（默认，本地优先）／windows／vision（多模态模型）／tesseract' },
        lang: { type: 'string', description: '语言提示，如 zh-Hans-CN / ja-JP / en-US；缺省 auto（按需回退）' },
        layout: { type: 'string', enum: ['auto', 'manga', 'art', 'auto-detect'], description: '区域检测模式：manga（气泡，默认）/ art（描边艺术字，放宽尺寸）/ auto' },
        maxImages: { type: 'number', description: '本次最多处理的图片数（默认 40）；超出部分留到下次调用，便于分批控制成本' },
        budget: { type: 'number', description: '本次最多调用视觉模型的图片数（默认 8，0 表示只用本地引擎）；本地 OCR 不消耗 token，不受此限' },
        force: { type: 'boolean', description: '忽略 OCR 缓存，强制重新识别' },
      },
      required: [],
      run: async (args, exec) => ocrAction(args || {}, exec),
    },
    {
      name: 'hanhua_translate',
      description: '翻译已解析条目（含 OCR 出来的图文条目）：先查词典/术语表与翻译缓存；词典未覆盖的文本批量调用在线翻译 API（需先 hanhua_config 配置 apiUrl/apiKey）。为节省 token：自动跳过无需翻译的条目（无字母或已含大量中日韩字符）、按原文+语境去重复用译文、按 apiChunk 分批并带语境标签压缩提示词。limit 是每批条数（默认 500，上限 20000）：默认只处理尚未翻译的条目，因此反复调用会一批批推进到全部条目，译文累计保存，最后一次性 hanhua_export。返回值含 progress{processed,pendingBefore,remaining,translatedTotal,entryTotal} 与 usage（本轮 API token 开销）。',
      properties: {
        ids: { type: 'array', items: { type: 'string' }, description: '只翻译指定条目 id（会覆盖这些 id 的旧译文）' },
        limit: { type: 'number', description: '每批最多处理条目数，默认 500，上限 20000' },
        offset: { type: 'number', description: '在待处理队列中跳过前 N 条（一般不需要）' },
        forceApi: { type: 'boolean', description: '跳过词典与缓存，全部走在线 API' },
      },
      required: [],
      run: async (args) => translateEntries(args || {}),
    },
    {
      name: 'hanhua_qa',
      description: '对当前译文做质检：占位符（%s/{0}/\\N[1]/<tag> 等）、字幕时间轴与 ASS 覆写标签、换行数、首尾空格、长度比例、漏译检测，返回问题清单。',
      properties: { ids: { type: 'array', items: { type: 'string' }, description: '只检查指定条目 id' } },
      required: [],
      run: async (args) => qaAction(args || {}),
    },
    {
      name: 'hanhua_glossary',
      description: '管理汉化词典/术语表（action: list/add/remove/reset）。词典优先级最高：完全匹配 > 子串最长优先 > 正则替换，之后才是在线 API。',
      properties: {
        action: { type: 'string', enum: ['list', 'add', 'remove', 'reset'] },
        source: { type: 'string', description: '原文或正则（regex=true 时）' },
        target: { type: 'string', description: '译文' },
        regex: { type: 'boolean', description: 'source 是否按正则解释' },
        note: { type: 'string' },
        index: { type: 'number', description: 'remove 用的列表下标' },
      },
      required: ['action'],
      run: async (args) => glossaryAction(args || {}),
    },
    {
      name: 'hanhua_export',
      description: '把译文写回原载体。文本/字幕/EPUB 就地替换或输出镜像目录；RGSS Marshal、krkr、EPUB/CBZ（ZIP）按原编码原格式回写；漫画页与图片艺术字会把译文擦除原文后按框自动排版回写到图片。mode=inplace 自动备份 <file>.bak（默认且推荐）；mode=out 输出到 .hanhua-out/ 镜像目录。',
      properties: {
        mode: { type: 'string', enum: ['inplace', 'out'], description: 'inplace（默认）或 out' },
        files: { type: 'array', items: { type: 'string' }, description: '只导出指定文件' },
        typeset: { type: 'boolean', description: '图片类条目是否排版回写（默认 true；false 时只输出译文清单 JSON/TXT）' },
        fontPath: { type: 'string', description: '排版用字体文件绝对路径；缺省自动挑可用的中文字体' },
      },
      required: [],
      run: async (args) => exportEntries(args || {}),
    },
    {
      name: 'hanhua_media',
      description: '媒体级操作（不影响 hanhua_* 主流程的文本条目）：action=subs-extract 从视频抽出内嵌字幕轨（ffmpeg/ffprobe）→ .srt；action=subs-mux 把译好的字幕回封进视频；action=subs-list 列出视频里的字幕轨；action=epub-unpack / epub-pack 解包/打包 EPUB（保留条目顺序与 mimetype）；action=probe 报告本机可用的外部能力（ffmpeg/ffprobe/tesseract/python/Pillow/Windows OCR）与建议。',
      properties: {
        action: { type: 'string', enum: ['subs-list', 'subs-extract', 'subs-mux', 'epub-unpack', 'epub-pack', 'comic-pack', 'probe'], description: '要执行的媒体操作' },
        file: { type: 'string', description: '输入文件（视频 / EPUB / 漫画包）' },
        out: { type: 'string', description: '输出文件或目录（相对项目根）' },
        stream: { type: 'number', description: '字幕轨序号（缺省第一轨）' },
      },
      required: ['action'],
      run: async (args) => mediaAction(args || {}),
    },
    {
      name: 'hanhua_usage',
      description: '查看 token/成本账本：本轮与累计的翻译 API 调用数、prompt/completion token、OCR 调用数、以及省下来的量（缓存命中、同图去重、本地 OCR 命中、智能跳过）。用于确认「省 token」是否真的生效。action=reset 可清零。',
      properties: { action: { type: 'string', enum: ['get', 'reset'], description: 'get（默认）或 reset' } },
      required: [],
      run: async (args) => usageAction(args || {}),
    },
    {
      name: 'hanhua_config',
      description: '读取/修改汉化引擎配置：root（项目根目录）、apiUrl（OpenAI 兼容 chat/completions 接口地址）、apiKey、model（翻译模型）、visionModel（图文 OCR 用的多模态模型，如 glm-4v-flash）、targetLang、sourceLang、rgssEncoding（XP/VX/Ace 字符串编码，默认 auto）、krkrEncoding（krkr 文本编码，默认 auto）、iconvPath（iconv-lite 绝对路径）、apiChunk（API 每批条数，默认 40，越大越省提示词开销）、ocrEngine（auto/windows/vision/tesseract）、ocrLang、ocrBudget、typesetFont（排版字体）。get 会遮蔽 apiKey。',
      properties: {
        action: { type: 'string', enum: ['get', 'set'] },
        root: { type: 'string' }, apiUrl: { type: 'string' }, apiKey: { type: 'string' },
        model: { type: 'string' }, visionModel: { type: 'string' },
        targetLang: { type: 'string' }, sourceLang: { type: 'string' },
        rgssEncoding: { type: 'string' }, krkrEncoding: { type: 'string' },
        iconvPath: { type: 'string' }, apiChunk: { type: 'number', description: 'API 每批条数（默认 40，范围 1-100）' },
        ocrEngine: { type: 'string', description: 'auto / windows / vision / tesseract / none' },
        ocrLang: { type: 'string', description: 'OCR 语言提示，如 auto / zh-Hans-CN / ja-JP' },
        ocrBudget: { type: 'number', description: '单次 hanhua_ocr 最多调用视觉模型的图片数（默认 8）' },
        typesetFont: { type: 'string', description: '漫画/艺术字排版字体绝对路径' },
        ffmpegPath: { type: 'string', description: 'ffmpeg 可执行文件路径（缺省自动探测）' },
      },
      required: ['action'],
      run: async (args) => configAction(args || {}),
    },
  ]

  // ═══════════════════════════════════════════════════════════════════════════
  // 汉化引擎 · 工作台 RPC（canonical rpc）
  //
  // 动态包（engine/host.js）用 harness.handle 注册这些名字；浏览器面板
  // （engine/client.js）通过 host.call('workbench.*') 调用。静态插件不直接注册它们，
  // 它只负责把动态包装起来（hanhua_workbench action=install）。
  // 约定：handler 返回可 JSON 化的值；错误直接抛，由 runner 转成 RPC 错误。
  // ═══════════════════════════════════════════════════════════════════════════

  const WORKBENCH_RPC = {
    'workbench.state': async () => ({
      summary: state.summary, root: state.root,
      entries: state.entries.length, translated: state.translated.length,
      busy: state.busy, lastError: state.lastError,
    }),
    'workbench.config.get': async () => { await loadMeta(); return maskConfig(config) },
    'workbench.config.set': async (args) => { const r = await configAction(Object.assign({ action: 'set' }, args || {})); return r.config },
    'workbench.glossary.list': async () => { await loadMeta(); return glossary.slice(0, 500) },
    'workbench.glossary.add': async (args) => { await glossaryAction(Object.assign({ action: 'add' }, args || {})); return glossary.slice(0, 500) },
    'workbench.glossary.remove': async (args) => { await glossaryAction(Object.assign({ action: 'remove' }, args || {})); return glossary.slice(0, 500) },
    'workbench.scan': async (args) => { const r = await scanRoot(args && args.root, args || {}); return { root: r.root, total: r.total, files: r.files.slice(0, 200), kinds: r.kinds } },
    'workbench.parse': async (args) => { const r = await parseFiles((args && args.files) || null, args && args.root); return { total: r.total, truncated: r.truncated, perFile: r.perFile, preview: r.entries.slice(0, 20), errors: (r.errors || []).slice(0, 20) } },
    'workbench.ocr': async (args, exec) => { const r = await ocrAction(args || {}, exec); return { summary: r.summary, images: (r.images || []).slice(0, 50), preview: (r.preview || []).slice(0, 20) } },
    'workbench.translate': async (args) => {
      const r = await translateEntries(args || {})
      return {
        summary: r.summary,
        usage: r.usage,
        preview: state.translated.filter((x) => x.method !== 'passthrough' && x.method !== 'skip').slice(0, 20).map((x) => ({ source: x.source, target: x.target, method: x.method, warnings: x.warnings.length })),
      }
    },
    'workbench.export': async (args) => exportEntries(args || {}),
    'workbench.usage': async () => usageAction({ action: 'get' }),
    'workbench.media.probe': async () => mediaAction({ action: 'probe' }),
    'workbench.pipeline': async (args) => {
      const steps = {}
      try { steps.scan = await scanRoot(args && args.root, args || {}) } catch (e) { return { ok: false, error: 'scan: ' + msg(e) } }
      try { steps.parse = await parseFiles(null) } catch (e) { return { ok: false, error: 'parse: ' + msg(e) } }
      try { steps.ocr = await ocrAction({}, null) } catch (e) { steps.ocr = { ok: false, error: msg(e) } }
      try { steps.translate = await translateEntries({}) } catch (e) { return { ok: false, error: 'translate: ' + msg(e) } }
      try { steps.export = await exportEntries({}) } catch (e) { return { ok: false, error: 'export: ' + msg(e) } }
      return { ok: true, steps }
    },
  }

  // ---------- 「汉化工作台」自装（常驻设置页；0.1.6 起没有模型动态装载工具了） ----------
  // 背景：0.1.6-alpha.2 退役了 cordis_define/cordis_run/cordis_stop/cordis_undefine，
  // tool.view.cordis 的渲染位随 cordis_run 卡片一起消失；但动态插件机制本体仍在
  // （host 服务 dynamicCordisRunner 公开 define/run/stop/undefine，见 cordis-host-runner）。
  // 因此由本插件在 host 平面自装：host 半 = 同级 engine/host.js，client 半 = 同级 engine/client.js；
  // client 半只注册常驻的 settings.section（设置页「汉化工作台」）。
  // 铁律：不把 dynamicCordisRunner 写进 export const inject —— inject 里缺服务会让整个插件停用，
  // 7 个 hanhua_* 工具会一起消失；这里只在工具被调用时用 ctx.get 检查，缺失即早退。
  const WORKBENCH_SERVICE = 'dynamicCordisRunner'
  const WORKBENCH_NAME = '汉化工作台'
  const WORKBENCH_PURPOSE = '设置页工作台面板'
  const WORKBENCH_ID_PREFIX = 'hanhu'   // define 要求 /^[a-z]{3,6}$/
  const WORKBENCH_RUN_WAIT_MS = 3000    // run 可能挂起等用户批准：不能无限 await
  const WORKBENCH_ENGINE_FILES = { host: 'host.js', client: 'client.js' }

  // file:///D:/a/index.js → D:/a/（同时处理盘符、UNC \\server\share 与 %20 转义）
  const fileUrlToPath = (u) => {
    let s = String(u)
    if (!s.startsWith('file:')) return s
    s = s.slice('file:'.length)
    if (s.startsWith('//')) {
      s = s.slice(2)
      const i = s.indexOf('/')
      const host = i < 0 ? s : s.slice(0, i)
      const rest = i < 0 ? '' : s.slice(i)
      s = (host === '' || host === 'localhost') ? rest : '//' + host + rest
    }
    s = s.replace(/^\/([A-Za-z]:)/, '$1')
    try { return decodeURIComponent(s) } catch (e) { return s }
  }

  // 本文件所在目录（安装后即 <预设根>/plugins/hanhua/）
  const pluginDir = (() => {
    try { return fileUrlToPath(new URL('./', import.meta.url).href) } catch (e) { return '' }
  })()
  // 引擎主体（core.js）里的 iconv 候选清单靠它找到「插件自带」的 node_modules：
  // 桌面版内核打包在 app.asar 里，子进程 require 不到其中的模块，所以必须自带并显式指路。
  pluginDirOverride = pluginDir

  // 引擎源码目录：默认同级 engine/（预设自包含）；可用 .hanhua-config.json 的 workbenchEnginePath 覆盖
  const workbenchEngineDir = () => {
    const override = (config && typeof config.workbenchEnginePath === 'string') ? config.workbenchEnginePath.trim() : ''
    if (override) return override
    return pluginDir ? joinPath(pluginDir, 'engine') : 'engine'
  }
  const byteLengthOf = (s) => { try { return Buffer.byteLength(String(s), 'utf8') } catch (e) { return String(s).length } }

  // 读引擎源码：优先走注入的 fs 服务；失败退到 node:fs（预设插件运行在 host 进程里，绝对路径可读）
  const readEngineText = async (p) => {
    try { return await readText(p) } catch (first) {
      try {
        const fsp = await import('node:fs/promises')
        return await fsp.readFile(p, 'utf8')
      } catch (second) { throw new Error(msg(first)) }
    }
  }
  const probeEngineFile = async (p) => {
    try {
      const info = await fs.stat(await fs.resolve(p))
      if (info && info.type) return { path: p, exists: true, type: info.type, bytes: typeof info.size === 'number' ? info.size : null }
    } catch (e) { /* 落到 node 兜底 */ }
    try {
      const fsp = await import('node:fs/promises')
      const st = await fsp.stat(p)
      return { path: p, exists: true, type: st.isDirectory() ? 'directory' : 'file', bytes: typeof st.size === 'number' ? st.size : null }
    } catch (e) { return { path: p, exists: false, error: msg(e) } }
  }

  const WORKBENCH_NO_SERVICE = '当前内核没有 dynamicCordisRunner 服务，无法装载「汉化工作台」动态包：'
    + '请确认 web composition 挂载了 @deepseek-ai/dsh-cordis-host-runner（0.1.6-alpha.2 里它属于可选插入行），'
    + '且当前会话跑在带浏览器 UI 的 dsh web 下。静态 hanhua_* 工具不受影响，可照常使用。'

  const workbenchRunner = () => {
    let runner = null
    try { runner = svc(WORKBENCH_SERVICE) } catch (e) { runner = null }
    if (runner && typeof runner.define === 'function' && typeof runner.run === 'function' && typeof runner.stop === 'function') return runner
    return null
  }

  // Agent.id 即 SessionId（define 的 sessionId 与 run/stop 的所有者都是它）。
  // 优先本轮工具调用的 exec.agent；没有就退到 agents.currentInitiator()。
  const agentOfExec = (exec) => {
    try {
      const a = (exec || lastExec) && (exec || lastExec).agent
      if (a && typeof a.id === 'string' && a.id) return a
    } catch (err) { /* ignore */ }
    try {
      const agents = svc('agents')
      const current = agents && typeof agents.currentInitiator === 'function' ? agents.currentInitiator() : null
      if (current && typeof current.id === 'string' && current.id) return current
    } catch (err) { /* ignore */ }
    return null
  }

  const isWorkbenchRow = (row) => {
    if (!row) return false
    if (String(row.pluginId || '').startsWith(WORKBENCH_ID_PREFIX + '-')) return true
    return Array.isArray(row.packages) && row.packages.some((p) => p && p.name === WORKBENCH_NAME)
  }
  // 本会话里已有的「汉化工作台」定义（snapshot 按 sessionId 过滤；进程重启后不会有旧记录）
  const workbenchRows = (runner, agent) => {
    let rows = []
    try { rows = runner.snapshot(agent) } catch (e) { rows = [] }
    return (Array.isArray(rows) ? rows : []).filter(isWorkbenchRow)
  }
  // 可复用的版本：currentPackageId 优先，否则最后一个已定义版本 —— 两者都能用 mode:'run' 启动
  // （mode:'update' 只在换版本时才需要，这里刻意不用，避免每次 install 都堆一个新版本）。
  const workbenchReuseTarget = (rows) => {
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const row = rows[i]
      const packages = Array.isArray(row.packages) ? row.packages : []
      const packageId = row.currentPackageId || (packages.length ? packages[packages.length - 1].packageId : null)
      if (packageId) return { pluginId: row.pluginId, packageId }
    }
    return null
  }

  // run 在有 client 半时会 emit cordis/request-run 后等用户批准（host runner README：无超时）。
  // 这里 race 兜住：超时就返回「等待批准」，并把 promise 的 then/catch 接住，绝不产生 unhandled rejection。
  const awaitWithTimeout = (promise, ms) => {
    if (typeof setTimeout !== 'function') return promise.then((value) => ({ value }), (error) => ({ error }))
    return new Promise((resolve) => {
      let settled = false
      const timer = setTimeout(() => { if (!settled) { settled = true; resolve({ timedOut: true }) } }, ms)
      const finish = (out) => { if (!settled) { settled = true; clearTimeout(timer); resolve(out) } }
      promise.then((value) => finish({ value }), (error) => finish({ error }))
      if (timer && typeof timer.unref === 'function') timer.unref()
    })
  }
  // 只挑标量：run 的响应里可能有 fiber 之类的循环引用对象，不能整体 JSON 化
  const runStatusOf = (run) => {
    if (!run || typeof run !== 'object') return null
    return {
      ok: run.ok !== false,
      status: run.status || null,
      reason: run.reason || null,
      message: run.message || null,
      pluginRunId: run.pluginRunId || null,
      packageId: run.packageId || null,
    }
  }

  async function workbenchStatus() {
    await loadMeta()
    const dir = workbenchEngineDir()
    const override = !!(config && typeof config.workbenchEnginePath === 'string' && config.workbenchEnginePath.trim())
    const host = await probeEngineFile(joinPath(dir, WORKBENCH_ENGINE_FILES.host))
    const client = await probeEngineFile(joinPath(dir, WORKBENCH_ENGINE_FILES.client))
    const runner = workbenchRunner()
    const agent = agentOfExec(null)
    const hints = []
    if (!runner) hints.push(WORKBENCH_NO_SERVICE)
    for (const probe of [host, client]) if (!probe.exists) hints.push('引擎源码缺失：' + probe.path + (probe.error ? '（' + probe.error + '）' : ''))
    const status = {
      action: 'status',
      service: { name: WORKBENCH_SERVICE, available: !!runner },
      engine: {
        dir,
        pathSource: override ? 'workbenchEnginePath（.hanhua-config.json 覆盖）' : '插件同级 engine/（由 import.meta.url 推导）',
        pluginDir: pluginDir || null,
        host,
        client,
      },
      sessionId: agent ? agent.id : null,
      definitions: [],
      workbench: [],
      ready: false,
      hints,
    }
    if (runner) {
      if (!agent) hints.push('取不到当前 Agent/会话（exec.agent 与 agents.currentInitiator 都没有），无法查询本会话的动态定义。')
      else {
        let allRows = []
        try { allRows = runner.snapshot(agent) || [] } catch (e) { status.snapshotError = msg(e) }
        status.definitions = (Array.isArray(allRows) ? allRows : []).map((row) => ({
          pluginId: row.pluginId,
          currentPackageId: row.currentPackageId || null,
          nextPackageId: row.nextPackageId || null,
          packages: (Array.isArray(row.packages) ? row.packages : []).map((p) => ({
            packageId: p.packageId, name: p.name, hasHostHalf: !!p.hasHostHalf, hasClientHalf: !!p.hasClientHalf,
          })),
          // activeRun.fiber 是 Cordis Fiber（循环引用），只挑标量字段
          activeRun: row.activeRun ? {
            pluginRunId: row.activeRun.pluginRunId,
            packageId: row.activeRun.packageId,
            handlers: Array.isArray(row.activeRun.handlers) ? row.activeRun.handlers.slice(0, 40) : [],
            renderFailure: row.activeRun.renderFailure
              ? { slot: row.activeRun.renderFailure.slot || null, message: row.activeRun.renderFailure.message || null }
              : null,
          } : null,
          latestRun: row.latestRun ? {
            status: row.latestRun.status || null,
            mode: row.latestRun.mode || null,
            requiresApproval: !!row.latestRun.requiresApproval,
            error: (row.latestRun.error && row.latestRun.error.message) ? row.latestRun.error.message : null,
          } : null,
        }))
        status.workbench = status.definitions.filter((d) => isWorkbenchRow(d))
        status.ready = status.workbench.some((d) => !!d.currentPackageId) && host.exists && client.exists
        if (!status.definitions.length) hints.push('本会话还没有任何动态定义：执行 hanhua_workbench action=install 装载「汉化工作台」。')
        else if (!status.workbench.length) hints.push('本会话有动态定义，但没有「汉化工作台」：执行 action=install 装载。')
        else if (!status.ready) hints.push('已有「汉化工作台」定义，但当前没有成功运行的版本：执行 action=install 重新装载，并按提示到 Cordis 面板批准。')
        else hints.push('就绪：设置页里应能看到「汉化工作台」；若看不到，请刷新浏览器页面后重新 install。')
      }
    }
    return status
  }

  async function workbenchInstall(exec) {
    await loadMeta()
    const runner = workbenchRunner()
    if (!runner) throw new Error(WORKBENCH_NO_SERVICE)
    const agent = agentOfExec(exec)
    if (!agent) {
      throw new Error('装载「汉化工作台」需要当前会话的 Agent（SessionId）：'
        + "请通过工具调用（exec.agent）触发，或确认 agents.currentInitiator() 可用。")
    }
    const dir = workbenchEngineDir()
    const hostPath = joinPath(dir, WORKBENCH_ENGINE_FILES.host)
    const clientPath = joinPath(dir, WORKBENCH_ENGINE_FILES.client)
    let hostCode, clientCode
    try { hostCode = await readEngineText(hostPath) } catch (e) {
      throw new Error('读不到 host 半 ' + hostPath + '：' + msg(e) + '。请确认 preset/plugins/hanhua/engine/ 已随预设一起安装（或设置 workbenchEnginePath）。')
    }
    try { clientCode = await readEngineText(clientPath) } catch (e) {
      throw new Error('读不到 client 半 ' + clientPath + '：' + msg(e) + '。请确认 preset/plugins/hanhua/engine/ 已随预设一起安装（或设置 workbenchEnginePath）。')
    }

    // 同一会话已有工作台定义时复用（浏览器刷新后重新 run 即可；反复 install 不会堆出一串 hanhu-N）
    const reuse = workbenchReuseTarget(workbenchRows(runner, agent))
    let receipt = null
    let pluginId, packageId
    if (reuse) {
      pluginId = reuse.pluginId
      packageId = reuse.packageId
    } else {
      // define 会 precheck 两半源码（语法不过就抛错，不会留下半成品定义）
      receipt = runner.define({
        sessionId: agent.id,
        plugin: { kind: 'new', idPrefix: WORKBENCH_ID_PREFIX },
        name: WORKBENCH_NAME,
        purpose: WORKBENCH_PURPOSE,
        code: { host: hostCode, client: clientCode },
      })
      pluginId = receipt.pluginId
      packageId = receipt.packageId
    }

    const outcome = await awaitWithTimeout(
      Promise.resolve().then(() => runner.run(agent, pluginId, packageId, 'run')),
      WORKBENCH_RUN_WAIT_MS,
    )
    const run = outcome.timedOut ? null : (outcome.value || null)
    const runError = outcome.error ? msg(outcome.error) : null
    const state = runStatusOf(run)
    const awaiting = !!outcome.timedOut || (!!state && state.status === 'awaiting-approval')
    const pendingAlready = !!state && state.reason === 'transition-in-flight'
    const ok = !runError && !pendingAlready && (!!outcome.timedOut || (!!state && state.ok))
    const hints = []
    if (runError) hints.push('runner.run 抛错：' + runError)
    if (awaiting) hints.push('定义已创建并发出装载请求，正在等待批准：请在浏览器里打开 Cordis 面板点「批准」，随后 设置 →「汉化工作台」出现面板。')
    if (pendingAlready) hints.push('该定义已有一个待批准的装载请求：直接到 Cordis 面板点「批准」即可，无需重复 install。')
    if (ok && !awaiting) hints.push('宿主半已在 host 平面启动；若浏览器半还没加载，请在 Cordis 面板批准，或刷新页面后重新 install。')
    hints.push('定义是进程内状态：DSH 重启后需要重新执行 install。')
    return {
      action: 'install',
      ok,
      reused: !!reuse,
      pluginId,
      packageId,
      receipt,
      run: state,
      timedOut: !!outcome.timedOut,
      engine: {
        dir,
        host: { path: hostPath, bytes: byteLengthOf(hostCode) },
        client: { path: clientPath, bytes: byteLengthOf(clientCode) },
      },
      hints,
    }
  }

  async function workbenchStop(exec) {
    await loadMeta()
    const runner = workbenchRunner()
    if (!runner) throw new Error(WORKBENCH_NO_SERVICE)
    const agent = agentOfExec(exec)
    if (!agent) throw new Error('停止「汉化工作台」需要当前会话的 Agent（SessionId）。')
    const rows = workbenchRows(runner, agent)
    if (!rows.length) {
      return { action: 'stop', ok: true, stopped: [], message: '本会话没有「汉化工作台」动态定义（定义只在进程内存在，重启后本来就没有）。' }
    }
    const stopped = []
    for (const row of rows) {
      let result
      try { result = await runner.stop(agent, row.pluginId) } catch (e) { result = { ok: false, reason: 'error', message: msg(e) } }
      stopped.push({ pluginId: row.pluginId, ok: !!(result && result.ok), reason: (result && result.reason) || null, message: (result && result.message) || null })
    }
    return {
      action: 'stop',
      ok: stopped.every((s) => s.ok),
      stopped,
      message: 'stop 停掉运行中的实例，定义仍留在进程内；浏览器面板会随 cordis/dynamic-retract 卸载。',
    }
  }

  async function workbenchAction(args, exec) {
    const action = String((args && args.action) || 'status')
    if (action === 'status') return workbenchStatus()
    if (action === 'install') return workbenchInstall(exec)
    if (action === 'stop') return workbenchStop(exec)
    throw new Error('未知 action: ' + action + '（可用：status / install / stop）')
  }

  // ---------- 工具注册（静态注册，走 ctx.tools） ----------
  // 工具清单在 tools.js 的 TOOL_SPECS（两个信封共用同一份定义，避免再出现两半漂移）。
  // execute 的第二参数固定是 exec（工具调用上下文），需要它的工具（如 hanhua_workbench）才用。
  const out = () => ({ schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] })
  const registerTool = (spec) => ctx.effect(() => ctx.tools.register({
    name: spec.name,
    description: spec.description,
    parameters: { type: 'object', properties: spec.properties || {}, required: spec.required || [], additionalProperties: false },
    output: out(),
    execute: async (args, exec) => JSON.stringify(await withExec(exec, () => spec.run(args || {}, exec))),
  }))

  for (const spec of TOOL_SPECS) registerTool(spec)

  registerTool({
    name: 'hanhua_workbench',
    description: '装载/查看/停止「汉化工作台」浏览器面板（常驻 设置 →「汉化工作台」）。0.1.6-alpha.2 起 cordis_define/cordis_run 等模型工具已退役，本工具由预设插件在 host 平面直接调用 dynamicCordisRunner 自装动态包：action=install 读取同级 engine/{host.js,client.js} 并 define+run（首次需到 Cordis 面板点「批准」）；action=status 查看服务是否可用、引擎源码路径与字节数、本会话已有定义与运行状态；action=stop 停止运行中的实例。定义是进程内状态，DSH 重启后需重新 install。详见 docs/WORKBENCH-0.1.6.md。',
    properties: { action: { type: 'string', enum: ['status', 'install', 'stop'], description: 'status（默认）查看状态；install 装载/重新装载面板；stop 停止运行中的实例' } },
    required: [],
    run: async (args, exec) => workbenchAction(args || {}, exec),
  })

  // ---------- 提示片段：汉化工作流指南 ----------
  // order 说明：0.1.6-alpha.2 起 systemPrompt 改用统一编号的档位表
  // （SECTION_ORDERS：persona 0 / plan 500 / 工具指南 1000–3100 / TOOLS_SDK 5000 /
  //  persona 后缀 10200）。旧版的「工具指南 100–199」约定已失效：order:115 会掉到
  //  persona 之后、全部第一方工具指南之前。这里落在 MCP_SERVERS(3100) 与
  //  TOOLS_SDK(5000) 之间，紧跟既有工具指南、且在 SDK 段之前。
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'tool:hanhua',
    order: 3200,
    text: GUIDE_LINES.join('\n'),
  }))
}
