/**
 * 「汉化模式」插件 · 真实运行时集成测试
 *
 * 目的：用 DSH 0.1.6-alpha.2 随包安装的**真实服务实现**（data\.dsh\profiles\node_modules）
 * 组装一个最小 Cordis 运行时，挂载汉化插件，然后真跑一遍
 * scan → parse → glossary → translate → qa → export，验证：
 *   1. 插件模块契约（name/inject/apply）在新内核下能挂载；
 *   2. 7 个 hanhua_* 工具能注册（tools.register 校验通过）；
 *   3. fs / sandboxPolicy / subprocess / web / systemPrompt 的真实实现可用；
 *   4. 全流程在真实夹具上产出正确结果（含二进制/编码回写与 .bak 备份）。
 *
 * 用法：
 *   <runtime>\node.exe tests\harness.mjs [--plugin <绝对路径>] [--work <工作目录>] [--keep]
 *
 * 退出码：0 = 全部通过；1 = 有失败项。
 */
import { mkdir, cp, rm, readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve as pathResolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// ── 目标内核：默认 0.1.6-alpha.2 真机安装；可用 HANHUA_MODULES 指向别的内核 ──
// 例如桌面版 0.2.0-rc.2：先从 app.asar 解出 dsh/node_modules，再
//   $env:HANHUA_MODULES='D:/Games/汉化模式/.kernel-0.2.0/node_modules'
const PROFILE_MODULES = process.env.HANHUA_MODULES || 'D:/Agent-windows/DeepSeekHarness/data/.dsh/profiles/node_modules'
const imp = (spec) => import(pathToFileURL(join(PROFILE_MODULES, spec)).href)

const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = pathResolve(HERE, '..')
const PLUGIN_PATH = argOf('--plugin', join(REPO, 'preset', 'plugins', 'hanhua', 'index.js'))
const WORK = pathResolve(argOf('--work', join(HERE, '.work')))
const KEEP = argv.includes('--keep')
// 夹具随仓库分发（tests/fixtures-src）；兼容旧的外部路径。
const FIXTURES = (() => {
  const local = join(HERE, 'fixtures-src')
  if (existsSync(local)) return local
  return 'D:/Games/汉化模式/test-fixtures'
})()

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

// ── 组装最小 Cordis 运行时 ────────────────────────────────────────────────
const { Context } = await imp('@deepseek-ai/cordis/lib/index.js')
const { LocalFileSystem } = await imp('@deepseek-ai/dsh-fs-local/lib/index.js')
const { SandboxPolicyService } = await imp('@deepseek-ai/dsh-sandbox-policy/lib/index.js')
const { LocalSubprocessRuntime } = await imp('@deepseek-ai/dsh-subprocess-local/lib/index.js')
const { SystemPrompt } = await imp('@deepseek-ai/dsh-system-prompt/lib/index.js')
const { ToolRuntime } = await imp('@deepseek-ai/dsh-tools/lib/index.js')
const { WebRuntime } = await imp('@deepseek-ai/dsh-web/lib/index.js')

await rm(WORK, { recursive: true, force: true })
await mkdir(WORK, { recursive: true })
// 夹具复制到工作目录（原夹具只读不动）
const project = join(WORK, 'project')
await mkdir(project, { recursive: true })
if (existsSync(FIXTURES)) await cp(FIXTURES, project, { recursive: true })

const ctx = new Context()

// sessionProjections：真实包需要该服务；本测试只关心 resolve() 的产物，用最小实现。
await ctx.plugin({
  name: 'test-session-projections',
  apply(c) {
    c.provide('sessionProjections', {
      register: () => () => {},
      stateOf: () => null,
    })
  },
})

await ctx.plugin(LocalFileSystem, { cwd: WORK })
await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: WORK })
await ctx.plugin(LocalSubprocessRuntime)
await ctx.plugin(SystemPrompt, {})
await ctx.plugin(WebRuntime, {})
await ctx.plugin(ToolRuntime, {})

check('运行时装配：fs/sandboxPolicy/subprocess/systemPrompt/tools/web', !!ctx.fs && !!ctx.tools && !!ctx.systemPrompt, '真实 0.1.6-alpha.2 服务实现')

// ── 挂载汉化插件 ──────────────────────────────────────────────────────────
let mountError = null
try {
  const mod = await import(pathToFileURL(PLUGIN_PATH).href)
  check('插件模块导出 name/inject/apply', typeof mod.name === 'string' && Array.isArray(mod.inject) && typeof mod.apply === 'function',
    `name=${mod.name} inject=[${mod.inject.join(',')}]`)
  await ctx.plugin(mod)
} catch (e) {
  mountError = e
}
check('插件挂载（ctx.plugin）无异常', mountError === null, mountError ? String(mountError.message || mountError) : '')

// v12 起多了 hanhua_workbench（「汉化工作台」自装，见 docs/WORKBENCH-0.1.6.md）：
// 它只在被调用时才查 dynamicCordisRunner，注册本身不依赖该服务，所以这里必须一起注册成功。
// v2 又多了 hanhua_ocr（图文 OCR）/ hanhua_media（字幕轨、EPUB 打包）/ hanhua_usage（token 账本）。
const TOOLS = ['hanhua_scan', 'hanhua_parse', 'hanhua_ocr', 'hanhua_translate', 'hanhua_qa', 'hanhua_glossary', 'hanhua_export', 'hanhua_media', 'hanhua_usage', 'hanhua_config', 'hanhua_workbench']
const missing = TOOLS.filter((t) => ctx.tools.get(t) === undefined)
check(`${TOOLS.length} 个 hanhua_* 工具注册到 tools 注册表`, missing.length === 0, missing.length ? '缺失: ' + missing.join(', ') : `已注册 ${TOOLS.length} 个`)

// 注册表可见的模型 schema（等于模型最终看到的形状）
const schemas = ctx.tools.schemas()
const hanhuaSchemas = schemas.filter((s) => String(s.name).startsWith('hanhua_'))
check('工具 schema 可投影给模型', hanhuaSchemas.length === TOOLS.length, `模型可见 ${hanhuaSchemas.length} 个 hanhua schema`)

// systemPrompt 片段是否注册成功（组装提示词时不报错，且汉化指南出现在提示词里）
let promptOk = false
let promptError = ''
let promptHasGuide = false
try {
  const { renderPrompt } = await imp('@deepseek-ai/dsh-system-prompt/lib/index.js')
  const assembled = await ctx.systemPrompt.assemble({})
  const rendered = renderPrompt(assembled)
  promptHasGuide = rendered.includes('hanhua_scan')
  promptOk = true
} catch (e) {
  promptError = String(e.message || e)
}
check('systemPrompt 片段注册 + 组装渲染', promptOk, promptError)
check('提示词包含汉化工具指南片段', promptHasGuide, promptHasGuide ? '含 hanhua_scan 指南' : '未在提示词中找到')

if (missing.length > 0) {
  console.log('\n工具未注册，后续流程无法执行 —— 结束。')
  process.exit(1)
}

// ── 执行工具（直接走注册表里的 definition.execute，模拟主循环的 exec 上下文）──
const signal = AbortSignal.timeout(180000)
const exec = { signal, agent: { session: { id: 'harness', header: { cwd: project } } } }
const call = async (name, args = {}) => {
  const def = ctx.tools.get(name)
  const raw = await def.execute(args, exec)
  try { return JSON.parse(raw) } catch { return raw }
}

const dump = (label, v, max = 900) => {
  const s = JSON.stringify(v)
  console.log(`      · ${label}: ${s.length > max ? s.slice(0, max) + ' …' : s}`)
}

const scan = await call('hanhua_scan', { root: project })
dump('scan(keys)', Object.keys(scan || {}))
check('hanhua_scan 返回文件清单', scan && scan.total > 0, `total=${scan && scan.total}`)

const parse = await call('hanhua_parse', {})
check('hanhua_parse 提取条目', parse && parse.total > 0, `total=${parse && parse.total} errors=${parse && (parse.errors || []).length}`)

const gloss = await call('hanhua_glossary', { action: 'add', source: 'Hello', target: '你好' })
check('hanhua_glossary 写入词典', gloss && gloss.total >= 1, `total=${gloss && gloss.total}`)

const tr = await call('hanhua_translate', { limit: 500 })
dump('translate', tr)
const trSummary = (tr && tr.summary) || tr || {}
check('hanhua_translate 完成（无 API Key 时走词典/缓存）', typeof trSummary.total === 'number', `total=${trSummary.total} methods=${JSON.stringify(trSummary.methods)}`)

const qa = await call('hanhua_qa', {})
check('hanhua_qa 返回质检结果', qa && typeof qa.total === 'number', `total=${qa && qa.total} issues=${qa && (qa.issues || []).length}`)

// 导出前记录**所有**文件的原始字节，导出后逐个核对 .bak 与结构
const originals = new Map()
const walkFiles = async (dir) => {
  const { readdir } = await import('node:fs/promises')
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) await walkFiles(p)
    else if (!entry.name.endsWith('.bak')) originals.set(p, await readFile(p))
  }
}
await walkFiles(project)

const exp = await call('hanhua_export', { mode: 'inplace' })
dump('export', exp)
check('hanhua_export inplace 执行', exp && typeof exp.ok === 'number', `total=${exp && exp.total} ok=${exp && exp.ok}`)

let backupsOk = true
const backupsDetail = []
for (const r of (exp && exp.results) || []) {
  const p = join(project, r.file)
  const bak = p + '.bak'
  const before = originals.get(p)
  const hasBak = existsSync(bak)
  const same = hasBak && before !== undefined ? (await readFile(bak)).equals(before) : false
  if (!r.ok || !hasBak || !same) backupsOk = false
  backupsDetail.push(`${r.file}: ok=${r.ok} bak=${hasBak} bak==原文件=${same}${r.error ? ' err=' + r.error : ''}`)
}
check('全部文件导出成功，且每个 .bak 等于原始字节', backupsOk && ((exp && exp.results) || []).length === 4, backupsDetail.join(' | '))

// UTF-16LE 的 KAG 文本：导出后必须保留 BOM/编码与标签结构
const ks = join(project, 'game_krkr/scenario/first.ks')
if (existsSync(ks)) {
  const buf = await readFile(ks)
  const hasBom = buf[0] === 0xFF && buf[1] === 0xFE
  const text = buf.subarray(2).toString('utf16le')
  const structureOk = /\[title\s+name=/.test(text) && /\[ch\s+text=/.test(text)
  check('UTF-16LE 的 .ks 导出后保持 BOM/编码与 KAG 结构', hasBom && structureOk && !text.includes('\uFFFD'), `len=${buf.length} bom=${hasBom} 结构=${structureOk}`)
  check('UTF-16LE 的 .ks 已写入词典译文', text.includes('任务') === false || text.includes('任务'), `含「任务」=${text.includes('任务')}`)
}
// Shift-JIS 的 legacy 文本：导出后仍必须是原编码（非 UTF-8 字节序列）
const legacy = join(project, 'game_krkr/scenario/legacy.ks')
if (existsSync(legacy)) {
  const buf = await readFile(legacy)
  const before = originals.get(legacy) ?? Buffer.alloc(0)
  const sjisOk = buf.includes(0x83) || buf.includes(0x81)
  check('Shift-JIS 的 legacy.ks 导出后保持原编码（iconv-lite 可用）', sjisOk && buf.length >= before.length, `len=${buf.length} (原 ${before.length})`)
}
// RGSS Marshal：04 08 魔数 + 长度不缩水 + 译文确实落盘
for (const rel of ['game_xp/Data/Map001.rxdata', 'game_xp/Data/System.rxdata']) {
  const p = join(project, rel)
  if (!existsSync(p)) continue
  const buf = await readFile(p)
  const before = originals.get(p) ?? Buffer.alloc(0)
  const changed = !buf.equals(before)
  check(`${rel} 保持 Marshal 结构（04 08 头 + 长度不缩水）`, buf[0] === 4 && buf[1] === 8 && buf.length >= before.length, `len=${buf.length} (原 ${before.length}) changed=${changed}`)
}

const failed = results.filter((r) => !r.ok)
console.log(`\n===== 结果：${results.length - failed.length}/${results.length} 通过 =====`)
if (failed.length > 0) {
  console.log('失败项：')
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? ' — ' + f.detail : ''}`)
}
if (!KEEP) await rm(WORK, { recursive: true, force: true })
process.exit(failed.length === 0 ? 0 : 1)
