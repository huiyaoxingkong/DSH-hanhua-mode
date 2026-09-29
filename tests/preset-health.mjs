// 用真实内核的 preset discovery 检查「汉化模式」预设的健康状态 ——
// 这正是 Web 端预设选择器判断该预设是否可用的口径（broken 行会被丢弃）。
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const MODS = 'D:/Agent-windows/DeepSeekHarness/data/.dsh/profiles/node_modules'
const imp = (s) => import(pathToFileURL(join(MODS, s)).href)

const { discoverPresets, SHIPPED_PRESET_ROOT } = await imp('@deepseek-ai/dsh-agent-presets/lib/index.js')

const DSH = 'D:/Agent-windows/DeepSeekHarness/data/.dsh'
const userRoot = process.env.DSH_HOME ? join(process.env.DSH_HOME, '.agent-presets') : join(DSH, '.agent-presets')

console.log('SHIPPED_PRESET_ROOT =', SHIPPED_PRESET_ROOT)
console.log('user root           =', userRoot)

const roots = [
  { path: SHIPPED_PRESET_ROOT, trust: 'system' },
  { path: userRoot, trust: 'user' },
]

// harnessBase = 行内包名的解析基准（调用方 ctx.baseUrl / 已装内核所在位置）。
// 以「随包 standard 是否健康」为基准真值来挑选正确的基准目录。
const candidates = [
  join(DSH, 'profiles', 'web'),
  join(DSH, 'profiles'),
  'D:/Agent-windows/DeepSeekHarness/core/apps/cli',
  'D:/Agent-windows/DeepSeekHarness/core',
]

let best = null
for (const base of candidates) {
  const href = pathToFileURL(base.endsWith('/') ? base : base + '/').href
  const presets = await discoverPresets(roots, href)
  const std = presets.find((p) => p.id === 'standard')
  const han = presets.find((p) => p.id === 'hanhua')
  const stdOk = std !== undefined && std.broken === undefined
  console.log(`\n--- harnessBase=${base} ---`)
  console.log(`  standard: ${stdOk ? 'healthy' : 'BROKEN: ' + (std ? std.broken : 'missing')}`)
  console.log(`  hanhua  : ${han && han.broken === undefined ? 'healthy' : 'BROKEN: ' + (han ? han.broken : 'missing')}`)
  if (stdOk && (best === null || (han && han.broken === undefined))) best = { base, presets, han }
}

if (best !== null) {
  console.log(`\n===== 采用基准 ${best.base} =====`)
  for (const p of best.presets) {
    console.log(`[${p.broken === undefined ? 'healthy' : 'BROKEN'}] ${p.id}${p.broken === undefined ? '' : ' — ' + p.broken}`)
  }
}

// 逐 root 明细（定位「汉化预设是否出现在列表里」）
const { scanRoot } = await imp('@deepseek-ai/dsh-agent-presets/lib/index.js')
const base = 'D:/Agent-windows/DeepSeekHarness/core/apps/cli/'
console.log('\n===== 逐 root 明细（harnessBase=core/apps/cli）=====')
for (const root of roots) {
  const found = await scanRoot(root, pathToFileURL(base).href)
  console.log(`root ${root.trust} ${root.path} -> ${found.length} 个: ${found.map((p) => p.id + (p.broken === undefined ? '' : '(BROKEN)')).join(', ')}`)
  for (const p of found) {
    if (p.broken !== undefined) console.log(`    ${p.id} 原因: ${p.broken}`)
  }
}
process.exit(0)
