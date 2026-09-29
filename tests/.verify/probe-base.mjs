// 探针 H：ctx.baseUrl（= preset discovery 的 harnessBase）取值对健康判定的影响
// 桌面封装从 core/apps/cli/lib/bin.js 启动（见 logs/core.log 调用栈），
// 这里把所有可能作为 ctx.baseUrl 的目录都试一遍，看 hanhua 是否在各处都 healthy。
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const MODS = 'D:/Agent-windows/DeepSeekHarness/data/.dsh/profiles/node_modules'
const { discoverPresets, SHIPPED_PRESET_ROOT } = await import(pathToFileURL(join(MODS, '@deepseek-ai/dsh-agent-presets/lib/index.js')).href)

const DSH = 'D:/Agent-windows/DeepSeekHarness/data/.dsh'
const roots = [{ path: SHIPPED_PRESET_ROOT, trust: 'system' }, { path: join(DSH, '.agent-presets'), trust: 'user' }]

const bases = [
  'D:/Agent-windows/DeepSeekHarness/core/apps/cli/',
  'D:/Agent-windows/DeepSeekHarness/core/apps/cli/lib/',
  'D:/Agent-windows/DeepSeekHarness/core/',
  'D:/Agent-windows/DeepSeekHarness/data/.dsh/profiles/web/',
  'D:/Agent-windows/DeepSeekHarness/data/.dsh/profiles/',
]
let bad = 0
for (const b of bases) {
  const presets = await discoverPresets(roots, pathToFileURL(b).href)
  const ids = presets.map((p) => p.id + (p.broken === undefined ? '=healthy' : '=BROKEN'))
  const std = presets.find((p) => p.id === 'standard')
  const han = presets.find((p) => p.id === 'hanhua')
  const line = `base=${b}\n    standard: ${std ? (std.broken === undefined ? 'healthy' : 'BROKEN — ' + std.broken) : 'MISSING'}\n    hanhua  : ${han ? (han.broken === undefined ? 'healthy' : 'BROKEN — ' + han.broken) : 'MISSING'}\n    全部: ${ids.join(', ')}`
  console.log(line)
  if (!std || std.broken !== undefined || !han || han.broken !== undefined) bad++
}
console.log(`\n===== 探针 H：${bases.length - bad}/${bases.length} 个 base 下 standard 与 hanhua 同时 healthy =====`)
process.exit(0)
