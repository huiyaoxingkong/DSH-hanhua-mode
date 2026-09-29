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
  // ── v2.1：图片字体（用图片代替字体的游戏文本）关联 ──
  imageFontGrouping: 'auto',    // auto / filename / none
  imageFontMinParts: 2,         // 少于这么多碎片不成组
  imageFontPhraseGap: 2.5,      // 同一行内：间隙 > 该值 × 行高 才断开成另一个词组
  imageFontGap: 6,              // 拼接时碎片之间的像素间距
  imageFontMaxParts: 8,         // 单组成员上限（超过就认为是一串独立图标，不关联）
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
  // 「图片字体」探测：如果同目录里有一串编号小图（name_0..name_n），那多半是把字体做成了图片。
  // 直接用分组器判断（与 OCR 阶段同一套规则，不会出现两套口径）。
  let imageFont = null
  if (kinds.image >= 6 && String(config.imageFontGrouping || 'auto') !== 'none') {
    const probes = files.filter((f) => f.kind === 'image').map((f) => ({ id: f.rel, file: f.rel, page: null, pageEntry: null, box: [0, 0, 1, 1], text: '', kind: 'image', ink: 0 }))
    try {
      const g = groupImageFonts(probes, { mode: String(config.imageFontGrouping || 'auto'), minParts: Math.max(2, Number(config.imageFontMinParts) || 2) })
      const seq = (g.groups || []).filter((x) => x.kind === 'sequence')
      if (seq.length) {
        imageFont = { suspected: true, groups: seq.length, sample: seq.slice(0, 3).map((x) => x.members.map((m) => m.file)) }
      }
    } catch (e) {}
  }
  const limit = Math.max(1, Math.min(Number(opts.limit) || 200, 2000))
  return { root, total: files.length, kinds, imageFont, files: files.slice(0, limit), truncated: files.length > limit }
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
    if (kind === 'imagefont') return '图片字体标签'
    if (kind === 'art') return '图片艺术字'
    if (kind === 'bubble') return '漫画气泡'
    return '图片文字'
  }
  return '文本'
}

// 图片字体标签的「同屏上下文」：同一目录/同一页的其它标签。
// 作用是把一屏 UI 的其它词条一并交给模型 —— 菜单项之间风格要一致（New Game/Options/Quit 该译成一套），
// 这是「翻译后语义通顺」的关键手段之一，且不额外增加请求次数（只是提示词里多一行）。
function siblingLabelsOf(entry, all) {
  if (!entry || (entry.loc && entry.loc.kind) !== 'imagefont') return []
  const dirOf = (p) => String(p || '').replace(/[\\/][^\\/]*$/, '')
  const near = (x) => x !== entry && x.format === 'image' && x.loc && x.loc.kind === 'imagefont' &&
    (dirOf(x.file) === dirOf(entry.file) || (x.loc.page !== undefined && x.loc.page === entry.loc.page && x.file === entry.file))
  const out = []
  for (const x of all) {
    if (!near(x)) continue
    const s = String(x.source || '').trim()
    if (s && out.indexOf(s) < 0) out.push(s)
    if (out.length >= 12) break
  }
  return out
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
  const hasImageFont = items.some((e) => e.loc && e.loc.kind === 'imagefont')
  const siblings = hasImageFont ? siblingLabelsOf(items.find((e) => e.loc && e.loc.kind === 'imagefont'), state.entries) : []
  const lines = [
    'Game / manga / subtitle localization. Translate each [context, text] pair into ' + config.targetLang + ' (from ' + config.sourceLang + ').',
    'Match the context style: names/menu short, dialogue natural, descriptions complete, subtitles concise (one line ≈ one line).',
    hasImageFont
      ? 'Pairs tagged 图片字体标签 are UI labels assembled from image fragments. Translate them as ONE fluent phrase (never word-by-word), keep the same wording style across a whole menu screen, and stay short enough to fit the original sprite run.'
      : '',
    siblings.length ? ('Other labels on the same screen (for consistent wording): ' + JSON.stringify(siblings.slice(0, 10))) : '',
    'Keep every placeholder exactly as-is (%s %d {0} \\N[1] \\V[1] <tag> and ⟦1⟧-style tokens).',
    'Output ONLY a JSON array of ' + items.length + ' strings, same order.',
  ].filter(Boolean)
  const prompt = lines.join('\n') + '\n' + JSON.stringify(pairs)
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

function qaCheck(source, target, method, entry) {
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
  // ── 图片字体（多碎片拼成的 UI 标签）专项检查：语义通顺与能否放下
  if (entry && entry.loc && entry.loc.kind === 'imagefont') {
    const parts = entry.loc.parts || []
    const box = entry.loc.box || [0, 0, 0, 0]
    if (parts.length < 2) w.push('图片字体分组只有 ' + parts.length + ' 个碎片（可能未正确关联）')
    const signal = (String(source).match(/[A-Za-z\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]/g) || []).length
    if (parts.length >= 3 && signal <= 1) w.push('拼接识别结果过短（' + signal + ' 个有效字符 / ' + parts.length + ' 个碎片），碎片可能没关联完整')
    const naive = entry.loc.naiveSource
    if (naive && !quiet && String(target).trim() === String(naive).trim() && String(naive).trim() !== String(source).trim()) w.push('译文像是碎片拼接（未按整体语义翻译）')
    if (!quiet && box[2] > 0 && box[3] > 0 && target) {
      const cjk = (String(target).match(/[\u2e80-\u9fff\uff00-\uffef\uac00-\ud7af]/g) || []).length
      const other = String(target).replace(/[\u2e80-\u9fff\uff00-\uffef\uac00-\ud7af]/g, '').length
      const estWidth = cjk * box[3] + other * box[3] * 0.55
      if (estWidth > box[2] * 1.35) w.push('译文可能超出原框（预计需要 ' + Math.round(estWidth) + 'px，原框 ' + box[2] + 'px，排版会自动缩小字号）')
    }
  }
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
  const byId = new Map(state.entries.map((e) => [e.id, e]))
  for (const r of pool) {
    const w = qaCheck(r.source, r.target, r.method, byId.get(r.id))
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
  const entryByIdQa = new Map(state.entries.map((e) => [e.id, e]))
  for (const r of results) {
    r.warnings = qaCheck(r.source, r.target, r.method, entryByIdQa.get(r.id))
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
  // 图片字体：一个语义单元可能横跨多张小图（每个碎片一个文件）。译文只画在锚点碎片那一张，
  // 其余碎片必须被**擦空**（否则旧字形会留在界面上）。这里把非锚点碎片变成各文件的擦除任务。
  let eraseTaskCount = 0
  for (const r of results) {
    const e = entryById[r.id]
    if (!e || !e.loc || e.loc.kind !== 'imagefont' || !Array.isArray(e.loc.parts)) continue
    if (r.target === r.source) continue
    for (const p of e.loc.parts) {
      if (!p || !p.file || p.file === r.file) continue
      ;(byFile[p.file] = byFile[p.file] || []).push({ id: r.id + '@erase', file: p.file, source: r.source, target: '', method: 'erase', __erase: true, __box: p.box, __groupId: e.loc.groupId, __from: r.file })
      eraseTaskCount++
    }
  }
  const out = []
  for (const rel of Object.keys(byFile)) {
    const rs = byFile[rel]
    const srcPath = joinPath(state.root, rel)
    const ext = extOf(rel)
    const base = basenameOf(rel)
    const firstReal = rs.find((x) => !x.__erase)
    const firstEntry = firstReal ? entryById[firstReal.id] : null
    const fmt = firstEntry ? firstEntry.format : (rs[0] && rs[0].__erase ? 'image' : '')
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
  'visionModel', 'ocrEngine', 'ocrLang', 'ocrLayout', 'typesetFont', 'pythonPath', 'powershellPath', 'ffmpegPath', 'ffprobePath', 'workbenchEnginePath', 'imageFontGrouping']
const CONFIG_NUMBER_FIELDS = ['visionMaxTokens', 'ocrBudget', 'ocrMaxImages', 'ocrMinArea', 'ocrMaxRegions', 'imageFontMinParts', 'imageFontPhraseGap', 'imageFontGap', 'imageFontMaxParts']

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

