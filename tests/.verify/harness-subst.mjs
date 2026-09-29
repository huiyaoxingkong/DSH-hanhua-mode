/**
 * 探针 C：在**真实 0.1.6-alpha.2 服务**（fs/sandboxPolicy/systemPrompt/tools/web）下，
 * 只把 `subprocess` 服务替换为 spawnSync(stdio:'inherit') 替身 —— 因为受限沙箱禁止
 * Node 以管道方式 spawn 子进程（实测 `spawn stdio=pipe => EPERM`），而
 * dsh-subprocess-local 的 runner 无论请求什么 stdio 都会建立管道 fd。
 * 这样做的目的：让插件的 writeBytes / writeTextLegacy / **iconvBatch** 真实代码路径
 * 全部跑起来，并记录每次 spawn 的 cwd / argv / exitCode。
 *
 * 用法：node tests/.verify/harness-subst.mjs --plugin <绝对路径/index.js> [--work <dir>]
 */
import { mkdir, cp, rm, readFile, readdir, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve as pathResolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const PROFILE_MODULES = 'D:/Agent-windows/DeepSeekHarness/data/.dsh/profiles/node_modules'
const imp = (spec) => import(pathToFileURL(join(PROFILE_MODULES, spec)).href)
const requireFromProfiles = createRequire(PROFILE_MODULES + '/_resolver.js')
const iconv = requireFromProfiles('iconv-lite')

const argv = process.argv.slice(2)
const argOf = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback }
const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = pathResolve(HERE, '..', '..')
const PLUGIN_PATH = argOf('--plugin', 'D:/Agent-windows/DeepSeekHarness/data/.dsh/.agent-presets/hanhua/plugins/hanhua/index.js')
const WORK = pathResolve(argOf('--work', join(HERE, 'work-subst')))
const FIXTURES = 'D:/Games/汉化模式/test-fixtures'
const FIXTURES_SJIS = join(HERE, 'fixtures-sjis')

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

// ── subprocess 替身 ────────────────────────────────────────────────────────
const spawnLog = []
const subprocessShim = {
  async resolveExecutable(command) { return process.execPath },
  spawn(spec) {
    const [file, ...args] = spec.argv
    const entry = {
      file,
      hasCwd: typeof spec.cwd === 'string' && spec.cwd.length > 0,
      cwd: spec.cwd,
      argvAfterEval: args[0] === '-e' ? args.slice(2) : args.slice(1),
      scriptHead: args[0] === '-e' ? String(args[1] || '').slice(0, 70) : null,
      env: spec.env || null,
      graceMs: spec.graceMs,
    }
    const r = spawnSync(file, args, {
      cwd: spec.cwd,
      env: spec.env ? { ...process.env, ...spec.env } : process.env,
      stdio: 'inherit',
      windowsHide: true,
    })
    entry.exitCode = r.error ? 'ERR:' + r.error.code : (r.status ?? 0)
    spawnLog.push(entry)
    console.log(`      · spawn cwd=${entry.cwd} args=${entry.argvAfterEval.length} exit=${entry.exitCode}`)
    return { done: Promise.resolve({ exitCode: typeof entry.exitCode === 'number' ? entry.exitCode : 1, signal: null }) }
  },
}

await rm(WORK, { recursive: true, force: true })
await mkdir(WORK, { recursive: true })
const project = join(WORK, 'project')
await mkdir(project, { recursive: true })
await cp(FIXTURES, project, { recursive: true })
// 只并入 game_xp 子树：strings.json 留在夹具目录，避免被当成待汉化 JSON 文件
await cp(join(FIXTURES_SJIS, 'game_xp'), join(project, 'game_xp'), { recursive: true })
const strings = JSON.parse(await readFile(join(FIXTURES_SJIS, 'strings.json'), 'utf8'))

const { Context } = await imp('@deepseek-ai/cordis/lib/index.js')
const { LocalFileSystem } = await imp('@deepseek-ai/dsh-fs-local/lib/index.js')
const { SandboxPolicyService } = await imp('@deepseek-ai/dsh-sandbox-policy/lib/index.js')
const { SystemPrompt } = await imp('@deepseek-ai/dsh-system-prompt/lib/index.js')
const { ToolRuntime } = await imp('@deepseek-ai/dsh-tools/lib/index.js')
const { WebRuntime } = await imp('@deepseek-ai/dsh-web/lib/index.js')

const ctx = new Context()
await ctx.plugin({
  name: 'verify-services',
  apply(c) {
    c.provide('sessionProjections', { register: () => () => {}, stateOf: () => null })
    c.provide('subprocess', subprocessShim)
  },
})
await ctx.plugin(LocalFileSystem, { cwd: WORK })
await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: WORK })
await ctx.plugin(SystemPrompt, {})
await ctx.plugin(WebRuntime, {})
await ctx.plugin(ToolRuntime, {})
check('运行时装配（subprocess=替身，其余真实）', !!ctx.fs && !!ctx.tools && !!ctx.subprocess, 'plugin=' + PLUGIN_PATH)

const mod = await import(pathToFileURL(PLUGIN_PATH).href)
check('插件模块导出 name/inject/apply', typeof mod.name === 'string' && Array.isArray(mod.inject), `name=${mod.name} inject=[${mod.inject.join(',')}]`)
await ctx.plugin(mod)

const TOOLS = ['hanhua_scan', 'hanhua_parse', 'hanhua_translate', 'hanhua_qa', 'hanhua_glossary', 'hanhua_export', 'hanhua_config']
const missing = TOOLS.filter((t) => ctx.tools.get(t) === undefined)
check('7 个 hanhua_* 工具注册', missing.length === 0, missing.length ? '缺失: ' + missing.join(', ') : '已注册 7 个')

const signal = AbortSignal.timeout(180000)
const exec = { signal, agent: { session: { id: 'verify', header: { cwd: project } } } }
const call = async (name, args = {}) => {
  const def = ctx.tools.get(name)
  const raw = await def.execute(args, exec)
  try { return JSON.parse(raw) } catch { return raw }
}

const scan = await call('hanhua_scan', { root: project })
check('hanhua_scan 发现 5 个文件（含 Shift-JIS 的 Map002.rxdata）', scan.total === 5, `total=${scan.total} files=${JSON.stringify((scan.files || []).map((f) => f.path || f.rel || f))}`)

const parse = await call('hanhua_parse', {})
const parsedSjis = (parse.files || parse.perFile || {})
check('hanhua_parse 无错误', (parse.errors || []).length === 0, `total=${parse.total} errors=${JSON.stringify(parse.errors)}`)
console.log('      perFile =', JSON.stringify(parse.perFile || parse.files || {}))

for (const [k, src] of Object.entries(strings.SOURCES)) {
  const r = await call('hanhua_glossary', { action: 'add', source: src, target: strings.TARGETS[k] })
  check(`词典写入 #${k}`, r && r.total >= 1, `${src} → ${strings.TARGETS[k]} (total=${r && r.total})`)
}
// krkr 的 Shift-JIS 夹具也要有命中，才能证明 writeTextLegacy 真的改写了文件
const KRKR_SRC = 'こんにちは、世界。'
const KRKR_DST = '你好，世界。'
await call('hanhua_glossary', { action: 'add', source: KRKR_SRC, target: KRKR_DST })
check('词典写入 #krkr-legacy', true, `${KRKR_SRC} → ${KRKR_DST}`)

const tr = await call('hanhua_translate', { limit: 500 })
const s = tr.summary || {}
check('hanhua_translate 完成', typeof s.total === 'number', `total=${s.total} methods=${JSON.stringify(s.methods)}`)
const glossaryHits = (tr.preview || []).filter((p) => p.method === 'glossary' && p.target !== p.source)
check('词典命中且 target != source 的条目 ≥5（保证 legacy 回写）', glossaryHits.length >= 5, `glossaryHits=${glossaryHits.length}`)

// 导出前后字节
const originals = new Map()
const walk = async (dir) => {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) await walk(p)
    else if (!e.name.endsWith('.bak')) originals.set(p, await readFile(p))
  }
}
await walk(project)

console.log('\n--- 开始 hanhua_export（应触发 iconvBatch + writeTextLegacy）---')
const exp = await call('hanhua_export', { mode: 'inplace' })
console.log('      export =', JSON.stringify(exp))
check('hanhua_export 全部成功', exp.ok === exp.total && exp.total === 5, `total=${exp.total} ok=${exp.ok}`)

let bakOk = true
const bakDetail = []
for (const r of exp.results || []) {
  const p = join(project, r.file)
  const before = originals.get(p)
  const bak = p + '.bak'
  const has = existsSync(bak)
  const same = has && before !== undefined ? Buffer.compare(readFileSync(bak), before) === 0 : false
  if (!has || !same) bakOk = false
  bakDetail.push(`${r.file}: ok=${r.ok} bak=${has} bak==原字节=${same}`)
}
check('5 个文件的 .bak 都等于导出前原始字节', bakOk, bakDetail.join(' | '))

// Shift-JIS RGSS 文件：必须含 iconv 编码后的中文目标（即 iconvBatch 真的跑通）
const sjisFile = join(project, 'game_xp/Data/Map002.rxdata')
const sjisBuf = readFileSync(sjisFile)
const expectName = iconv.encode(strings.TARGETS.name, 'shift_jis')
const containsName = sjisBuf.includes(expectName)
check('Map002.rxdata 含 iconv(shift_jis) 编码后的词典译文 @name', containsName, `期望字节 ${Buffer.from(expectName).toString('hex')} 出现=${containsName}`)
const stillHasSource = sjisBuf.includes(iconv.encode(strings.SOURCES.name, 'shift_jis'))
check('Map002.rxdata 原文日文串已被替换（不再是原字节）', !stillHasSource, `原字节仍存在=${stillHasSource}`)

// krkr Shift-JIS 文件：writeTextLegacy 落盘后字节已变，且含 iconv 编码后的译文
const legacyFile = join(project, 'game_krkr/scenario/legacy.ks')
const legacyBuf = readFileSync(legacyFile)
const legacyBefore = originals.get(legacyFile)
const legacyChanged = legacyBefore !== undefined && Buffer.compare(legacyBuf, legacyBefore) !== 0
const legacyWanted = iconv.encode(KRKR_DST, 'shift_jis')
const legacyHasTarget = legacyBuf.includes(legacyWanted)
const legacyDecoded = iconv.decode(legacyBuf, 'shift_jis')
check('legacy.ks 被 writeTextLegacy 改写（字节已变）', legacyChanged, `len ${legacyBefore && legacyBefore.length} → ${legacyBuf.length}`)
check('legacy.ks 含 iconv(shift_jis) 编码后的词典译文', legacyHasTarget, `期望字节 ${Buffer.from(legacyWanted).toString('hex')} 出现=${legacyHasTarget}`)
check('legacy.ks 仍是合法 shift_jis（无 U+FFFD，KAG 结构保持）', !legacyDecoded.includes('\uFFFD') && legacyDecoded.includes('[title name=') && legacyDecoded.includes('[ch text='), JSON.stringify(legacyDecoded.slice(0, 80)))

// ── spawn 日志断言 ─────────────────────────────────────────────────────────
await writeFile(join(HERE, 'spawn-log.json'), JSON.stringify(spawnLog, null, 2), 'utf8')
const withCwd = spawnLog.filter((e) => e.hasCwd)
check('每一次 subprocess.spawn 都带非空 cwd', withCwd.length === spawnLog.length, `${withCwd.length}/${spawnLog.length}`)
const cwdAllProject = spawnLog.every((e) => e.cwd === project)
check('每次 spawn 的 cwd 都等于项目根目录', cwdAllProject, 'cwd=' + project)

const batchSpawns = spawnLog.filter((e) => e.argvAfterEval.some((a) => String(a).endsWith('.hanhua-iconv.in.json')))
check('iconvBatch 被真实执行（argv 含 .hanhua-iconv.in.json）', batchSpawns.length === 1, `次数=${batchSpawns.length}`)
if (batchSpawns.length) {
  const b = batchSpawns[0]
  check('iconvBatch spawn exitCode = 0（iconv-lite 装载成功，未 code=3）', b.exitCode === 0, `exitCode=${b.exitCode} argv=${JSON.stringify(b.argvAfterEval.slice(0, 2))}`)
  const cand = b.argvAfterEval[2]
  let candOk = false
  try { const arr = JSON.parse(cand); candOk = Array.isArray(arr) && arr.some((x) => x.includes('iconv-lite')) } catch {}
  check('iconvBatch 第 3 个参数（下标 3）= 候选清单 JSON', candOk, String(cand).slice(0, 160))
  check('iconvBatch argv 长度=3（in/out/candidates）', b.argvAfterEval.length === 3, `len=${b.argvAfterEval.length}`)
}
// writeTextLegacy 布局：[outPath, base64, encoding, 候选清单JSON] —— 4 个参数，末参数为候选数组
const legacySpawns = spawnLog.filter((e) => {
  if (e.argvAfterEval.length !== 4) return false
  try { return Array.isArray(JSON.parse(e.argvAfterEval[3])) } catch { return false }
})
check('writeTextLegacy 被真实执行（4 参数，末参数=候选清单）', legacySpawns.length >= 1, `次数=${legacySpawns.length} exitCodes=${legacySpawns.map((e) => e.exitCode).join(',')}`)
check('writeTextLegacy 全部 exitCode = 0', legacySpawns.length > 0 && legacySpawns.every((e) => e.exitCode === 0), legacySpawns.map((e) => e.exitCode).join(','))

const failed = results.filter((r) => !r.ok)
console.log(`\n===== 探针 C 结果：${results.length - failed.length}/${results.length} 通过 =====`)
for (const f of failed) console.log('  失败: ' + f.name + ' — ' + f.detail)
console.log('spawn 次数 =', spawnLog.length, ' → tests/.verify/spawn-log.json')
process.exit(failed.length === 0 ? 0 : 1)
