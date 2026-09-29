// ═══════════════════════════════════════════════════════════════════════════
// 「汉化模式」引擎构建器：把 engine/src/ 下的规范源码生成两个信封产物
//
//   engine/src/{subtitle,ebook,core,media,ocr,tools,rpc}.js + scripts/* + *-tail.js
//     ├─→ engine/host.js                  （动态包：汉化工作台 host 半）
//     └─→ preset/plugins/hanhua/index.js  （静态插件：预设里的 hanhua_* 工具）
//
// 用法：
//   node tools/build-engine.mjs            写盘
//   node tools/build-engine.mjs --check    只校验（退出码 1 = 产物与源码不一致）
//
// 为什么要生成：历史上这两个文件是手抄的两份 1700 行引擎，已经漂移过
// （iconvPath 默认值、resolveRoot、parseFiles 的 errors、Marshal 读取修复各有一半）。
// 现在只维护一份规范源码，产物由本脚本生成，--check 进自检。
// ═══════════════════════════════════════════════════════════════════════════
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join, resolve as pathResolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = pathResolve(HERE, '..')
const SRC = join(REPO, 'engine', 'src')
const CHECK = process.argv.includes('--check')

const readOrNull = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null)
const mustRead = (p) => {
  const t = readOrNull(p)
  if (t === null) throw new Error('缺少规范源码: ' + p)
  return t
}

// 规范源码里 `export ` 前缀只是为了让 tests/ 能直接 import 单文件；注入信封时剥掉。
const stripExports = (text) => text
  .replace(/^export (const|let|var|function|class|async function) /gm, '$1 ')
  // 聚合导出（export { a, b }，单行或多行）整块删掉，声明本身留在原地
  .replace(/^export \{[^}]*\}\s*$/gm, '')
const trimEnd = (t) => t.replace(/\s+$/, '')

// ── 1) 纯函数库（先注入；不含服务访问，可独立单测）
const libParts = []
for (const f of ['subtitle.js', 'ebook.js']) {
  const t = readOrNull(join(SRC, f))
  if (t === null) continue
  libParts.push(trimEnd(stripExports(t)))
}

// ── 2) 引擎主体
const core = trimEnd(mustRead(join(SRC, 'core.js')))

// ── 3) 媒体/OCR 子系统（用到 ctx 服务）
const subParts = []
for (const f of ['media.js', 'ocr.js']) {
  const t = readOrNull(join(SRC, f))
  if (t === null) continue
  subParts.push(trimEnd(stripExports(t)))
}

// ── 4) 脚本资源：内联成常量，运行时落到 <root>/.hanhua-tmp/ 再执行
//    （动态包跑在 vm 里、静态插件跑在 host 进程里，都没有稳定的相对路径可用。）
const scriptsDir = join(SRC, 'scripts')
const assetNames = existsSync(scriptsDir)
  ? readdirSync(scriptsDir).filter((n) => /\.(js|py|ps1|mjs)$/.test(n)).sort()
  : []
const assets = '// ── 内联的子进程脚本（源在 engine/src/scripts/，由 tools/build-engine.mjs 注入） ──\n'
  + '// 运行时按需写入 <项目根>/.hanhua-tmp/（内容变了才重写），再 spawn node/python/powershell。\n'
  + 'const SCRIPT_SOURCES = {\n'
  + assetNames.map((n) => '  ' + JSON.stringify(n) + ': ' + JSON.stringify(readFileSync(join(scriptsDir, n), 'utf8')) + ',').join('\n')
  + '\n}\n'

// ── 5) 工具表 / RPC / 信封尾部
const tools = trimEnd(stripExports(mustRead(join(SRC, 'tools.js'))))
const rpc = trimEnd(stripExports(mustRead(join(SRC, 'rpc.js'))))
const staticTail = trimEnd(mustRead(join(SRC, 'static-tail.js')))
const dynamicTail = trimEnd(mustRead(join(SRC, 'dynamic-tail.js')))

const HEADER = (kind, note) => `// ═══════════════════════════════════════════════════════════════════════════
// 汉化引擎 · ${kind}
//
// ⚠ 本文件由 tools/build-engine.mjs 从 engine/src/ 生成，请勿直接编辑：
//    改功能 → 改 engine/src/ 下的规范源码 → 跑 node tools/build-engine.mjs
//    校验一致性 → node tools/build-engine.mjs --check
//
// ${note}
// ═══════════════════════════════════════════════════════════════════════════
`

const indent = (text, n) => {
  const pad = ' '.repeat(n)
  return text.split('\n').map((l) => (l.trim() === '' ? '' : pad + l)).join('\n')
}

// 注入顺序很关键（同一函数作用域里的 const 有 TDZ）：
//   subtitle/ebook（纯函数库）→ media/ocr（子系统常量，如 IMAGE_EXTS）→ core（顶层常量会用到它们，
//   例如 SCAN_EXT = GAME_EXT ∪ SUB_EXTS ∪ EBOOK_EXT ∪ IMAGE_EXTS…）→ 脚本资源 → 工具表/RPC → 信封尾部。
const body = [...libParts, ...subParts, core, trimEnd(assets), tools, rpc].join('\n\n')

// ── 静态插件（ESM）：export name/inject/apply
const staticOut = HEADER('静态插件包（「汉化模式」预设用）', '消费 host 的 tools/systemPrompt/fs/web/sandboxPolicy/subprocess 服务；不提供任何服务，无需 isolate realm。') + `
export const name = 'hanhua-engine'
export const inject = ['tools', 'systemPrompt', 'fs', 'web', 'sandboxPolicy', 'subprocess']
export const version = '2.0.0'

export function apply(ctx) {
${indent(body, 2)}

${indent(staticTail, 2)}
}
`

// ── 动态包：return { apply(ctx) { ... } }
// harness 是 dynamicCordisRunner 沙箱注入的全局（见 dsh-cordis-host-runner/lib/types/sandbox.js），
// 代码本体作为 async 函数体执行 —— 所以这里不能 `const harness = ...` 把它遮蔽掉。
const dynamicOut = HEADER('动态包（汉化工作台 host 半）', '由静态插件经 dynamicCordisRunner.define+run 装载；harness 是 vm 沙箱注入的全局（defineTool/handle）。') + `
return {
  apply(ctx) {
${indent(body, 4)}

${indent(dynamicTail, 4)}
  },
}
`

const clientSrc = mustRead(join(REPO, 'engine', 'client.js'))

const targets = [
  { path: join(REPO, 'engine', 'host.js'), text: dynamicOut },
  { path: join(REPO, 'preset', 'plugins', 'hanhua', 'index.js'), text: staticOut },
  // 预设要自带工作台的两半（hanhua_workbench action=install 会读同级 engine/）
  { path: join(REPO, 'preset', 'plugins', 'hanhua', 'engine', 'host.js'), text: dynamicOut },
  { path: join(REPO, 'preset', 'plugins', 'hanhua', 'engine', 'client.js'), text: clientSrc },
]

let bad = 0
for (const t of targets) {
  const current = readOrNull(t.path)
  const same = current === t.text
  if (CHECK) {
    console.log(`${same ? 'OK  ' : 'DIFF'} ${t.path}${same ? '' : ` (产物 ${current ? current.split('\n').length : 0} 行 / 生成 ${t.text.split('\n').length} 行)`}`)
    if (!same) bad++
  } else {
    writeFileSync(t.path, t.text, 'utf8')
    console.log(`wrote ${t.path} (${t.text.split('\n').length} 行)`)
  }
}
if (CHECK) {
  if (bad) { console.log('\n产物与 engine/src/ 不一致：跑 node tools/build-engine.mjs 重新生成。'); process.exit(1) }
  console.log('OK   两个信封产物都与 engine/src/ 一致')
}
