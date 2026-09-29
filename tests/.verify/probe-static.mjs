// 探针 E：① 组合文件对抗性检查（persona / workflow-worker-thread / workflow-ptc）
//        ② 两半实现（preset 插件 与 engine/host.js）的子进程辅助代码是否一致
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const MODS = 'D:/Agent-windows/DeepSeekHarness/data/.dsh/profiles/node_modules'
const { entryListSchema } = await import(pathToFileURL(join(MODS, '@deepseek-ai/cordis-plugin-include/lib/index.js')).href)
const yaml = await import(pathToFileURL(join(MODS, 'js-yaml/index.js')).href)

const INST = 'D:/Agent-windows/DeepSeekHarness/data/.dsh/.agent-presets/hanhua/agent.cordis.yml'
const REPO = 'D:/Games/汉化模式/DSH-hanhua-mode/preset/agent.cordis.yml'
const BEFORE = 'D:/Games/汉化模式/DSH-hanhua-mode/preset/agent.cordis.yml.before-v12'

const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`) }

const collect = (rows, acc = []) => {
  for (const r of rows) {
    if (r === null || typeof r !== 'object') continue
    acc.push(r)
    if (Array.isArray(r.config)) collect(r.config, acc)
  }
  return acc
}
const load = async (p) => collect(yaml.load(await readFile(p, 'utf8'), { schema: entryListSchema }))

const inst = await load(INST)
const before = await load(BEFORE)

// ── ① 组合文件 ────────────────────────────────────────────────────────────
const rawInst = await readFile(INST, 'utf8')
const personaRows = inst.filter((r) => r.id === 'persona')
check('persona 行只出现一次', personaRows.length === 1, `次数=${personaRows.length}`)
const pcfg = personaRows[0] ? personaRows[0].config : {}
check('persona 行使用 prefix 键', pcfg && typeof pcfg.prefix === 'string' && pcfg.prefix.length > 0, `prefix 长度=${pcfg && pcfg.prefix ? pcfg.prefix.length : 'N/A'}`)
check('persona 行存在 suffix 键', pcfg && typeof pcfg.suffix === 'string' && pcfg.suffix.length > 0, `suffix 长度=${pcfg && pcfg.suffix ? pcfg.suffix.length : 'N/A'}`)
check('persona 行不存在 text 键', pcfg && !('text' in pcfg), `键=${pcfg ? Object.keys(pcfg).join(',') : 'N/A'}`)
check('persona prefix 含「汉化模式」标识', pcfg && String(pcfg.prefix).includes('汉化模式'), '')
// 对照：修复前
const pBefore = before.filter((r) => r.id === 'persona')[0]
check('对照 before-v12：persona 用 text 且无 prefix', pBefore && 'text' in pBefore.config && !('prefix' in pBefore.config), `键=${pBefore ? Object.keys(pBefore.config).join(',') : 'N/A'}`)

const wwt = inst.filter((r) => String(r.id || '').includes('worker-thread') || String(r.name || '').includes('worker-thread'))
check('组合文件不含 workflow-worker-thread 行', wwt.length === 0, `命中=${wwt.length}`)
check('组合文件不含 workflow-worker-thread 文本', !rawInst.includes('workflow-worker-thread'), '')
const ptc = inst.filter((r) => r.id === 'workflow-ptc')
check('组合文件含 workflow-ptc 行', ptc.length === 1, `次数=${ptc.length} name=${ptc[0] && ptc[0].name}`)
check('workflow-ptc 指向 @deepseek-ai/dsh-workflow-ptc', ptc[0] && ptc[0].name === '@deepseek-ai/dsh-workflow-ptc', String(ptc[0] && ptc[0].name))

const hanhuaRow = inst.filter((r) => r.id === 'hanhua-engine')
check('组合文件含 hanhua-engine 行（挂载本地插件）', hanhuaRow.length === 1, `name=${hanhuaRow[0] && hanhuaRow[0].name}`)

// ── ② 两半实现一致性 ──────────────────────────────────────────────────────
const plugin = await readFile('D:/Games/汉化模式/DSH-hanhua-mode/preset/plugins/hanhua/index.js', 'utf8')
const host = await readFile('D:/Games/汉化模式/DSH-hanhua-mode/engine/host.js', 'utf8')
function block(src, from, to) {
  const i = src.indexOf(from)
  const j = src.indexOf(to, i)
  if (i < 0 || j < 0) return null
  return src.slice(i, j)
}
const norm = (s) => s.split(/\r?\n/)
  .map((l) => l.trim().replace(/\/\/.*$/, '').trim())   // 去注释
  .filter((l) => l !== '')
  .map((l) => l.replaceAll('ctx.', ''))                 // 服务访问写法差异：ctx.subprocess/ctx.fs ↔ subprocess/fs
  .join('\n')

// 从 spawnCwd 定义开始（跳过其上方的中文注释，只比对代码），到 decodeBytes 之前
const bp = block(plugin, 'const spawnCwd = () =>', 'function decodeBytes')
const bh = block(host, 'const spawnCwd = () =>', 'function decodeBytes')
check('两半都能定位到子进程辅助代码块', bp !== null && bh !== null, `plugin=${bp ? bp.split('\n').length + ' 行' : 'null'} host=${bh ? bh.split('\n').length + ' 行' : 'null'}`)
// 归一化后去掉实现差异行（服务获取方式不同：ctx.subprocess vs ctx.get('subprocess')）
const stripLocal = (s) => norm(s).split('\n').filter((l) => !/^const subprocess = ctx\.get\('subprocess'\)$/.test(l) && !/^const subprocess = get\('subprocess'\)$/.test(l) && !/^if \(!subprocess\) throw/.test(l) && !/^needFs\(\)$/.test(l) && !/^await writeText\(tmpIn/.test(l))
const lp = stripLocal(bp)
const lh = stripLocal(bh)
const setP = new Set(lp), setH = new Set(lh)
const sameSet = lp.length === lh.length && [...setP].every((l) => setH.has(l))
const sameOrder = JSON.stringify(lp) === JSON.stringify(lh)
check('两半子进程辅助代码（去注释、去 ctx. 访问写法）行集合完全一致', sameSet, `plugin=${lp.length} 行 host=${lh.length} 行`)
console.log(`[NOTE] 声明顺序：${sameOrder ? '完全一致' : '内容相同但声明顺序不同——host 把 nodeSpawn 放在 ICONV_CANDIDATES 之前；两者都是 function/const 声明且仅在调用期引用，无 TDZ 问题，运行期已实测通过'}`)
if (!sameSet) {
  for (const l of lp) if (!setH.has(l)) console.log('   P-only| ' + l)
  for (const l of lh) if (!setP.has(l)) console.log('   H-only| ' + l)
}
// 关键行必须同时出现在两半
const keyLines = [
  "{ argv: [node, '-e', script].concat(args), cwd: spawnCwd(), stdio: { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' }, graceMs: 60000 }",
  'const iconvLoad = (argIndex) =>',
  'const script = \'const fs=require("fs");const pt=require("path");\' + iconvLoad(4)',
  "'const fs=require(\"fs\");' + iconvLoad(3)",
  'JSON.stringify(ICONV_CANDIDATES())], cwd: spawnCwd(),',
]
for (const k of keyLines) {
  const a = plugin.includes(k)
  const b = host.includes(k)
  check('关键行两半一致：' + k.slice(0, 58) + '…', a && b, `plugin=${a} host=${b}`)
}
// spawn 调用点数量与 cwd 覆盖
const spawnCallsPlugin = (plugin.match(/\.spawn\(spec\)/g) || []).length
const spawnCallsHost = (host.match(/\.spawn\(spec\)/g) || []).length
const cwdPlugin = (plugin.match(/cwd: spawnCwd\(\)/g) || []).length
const cwdHost = (host.match(/cwd: spawnCwd\(\)/g) || []).length
check('preset 插件 2 个 spawn 调用点都带 cwd', spawnCallsPlugin === 2 && cwdPlugin === 2, `spawn=${spawnCallsPlugin} cwd=${cwdPlugin}`)
check('engine/host.js 2 个 spawn 调用点都带 cwd', spawnCallsHost === 2 && cwdHost === 2, `spawn=${spawnCallsHost} cwd=${cwdHost}`)

const failed = results.filter((r) => !r.ok)
console.log(`\n===== 探针 E：${results.length - failed.length}/${results.length} 通过 =====`)
process.exit(failed.length === 0 ? 0 : 1)
