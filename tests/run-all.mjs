/**
 * 「汉化模式」全量自检：一条命令跑完所有测试并给出汇总。
 *
 *   node tests/run-all.mjs [--quick]     # --quick 跳过最慢的 v2 端到端
 *
 * 覆盖：
 *   1. mount-check         预设组合「挂载级」检查（行解析 + 每行 Config 校验）
 *   2. preset-health       真实 discovery 健康检查
 *   3. build-composition   组合文件是否等于「新版标准 + 汉化行」的派生结果
 *   4. build-check         生成物与 engine/src/ 一致 + 动态包信封契约
 *   5. subtitle / ebook    纯函数库单测
 *   6. mediakit / winocr   子进程脚本自测（ZIP/HTTP、Windows OCR）
 *   7. imglib              Python 图像/PDF 工具自测
 *   8. harness             真实内核服务下的 scan→parse→translate→qa→export
 *   9. v2-e2e              字幕/电子书/漫画/艺术字 OCR/账本 端到端（本地 mock API，不花 token）
 *
 * 环境变量：
 *   HANHUA_MODULES  内核 node_modules 路径（默认桌面版解包目录 .kernel-0.2.0/node_modules）
 *   HANHUA_PYTHON   带 Pillow 的 python.exe（默认 DSH 运行时里的那个）
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve as pathResolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = pathResolve(HERE, '..')
const QUICK = process.argv.includes('--quick')
const NODE = process.execPath
const PY = process.env.HANHUA_PYTHON || join(process.env.DSH_HOME || 'C:/Users/lihao/.dsh', 'dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe')

const env = Object.assign({}, process.env)
if (!env.HANHUA_MODULES) env.HANHUA_MODULES = 'D:/Games/汉化模式/.kernel-0.2.0/node_modules'

const CASES = [
  { name: 'mount-check（预设挂载级）', cmd: NODE, args: [join(HERE, 'mount-check.mjs')], skipIf: () => !existsSync('D:/Agent-windows/DeepSeekHarness/data/.dsh/profiles/node_modules') },
  { name: 'preset-health（discovery）', cmd: NODE, args: [join(HERE, 'preset-health.mjs')], skipIf: () => !existsSync('D:/Agent-windows/DeepSeekHarness/data/.dsh/profiles/node_modules') },
  { name: 'build-composition（组合派生一致性）', cmd: NODE, args: [join(HERE, 'build-composition.mjs'), '--check'], skipIf: () => !existsSync('D:/Agent-windows/DeepSeekHarness/core/packages/preset/agent-presets/presets/standard/agent.cordis.yml') },
  { name: 'build-check（生成物一致 + 动态包信封）', cmd: NODE, args: [join(HERE, 'build-check.mjs')] },
  { name: 'subtitle（字幕库单测）', cmd: NODE, args: [join(HERE, 'subtitle.test.mjs')] },
  { name: 'ebook（电子书文本层单测）', cmd: NODE, args: [join(HERE, 'ebook.test.mjs')] },
  { name: 'mediakit（ZIP/HTTP 工具）', cmd: NODE, args: [join(HERE, 'mediakit.test.mjs')] },
  { name: 'winocr（Windows OCR 桥）', cmd: NODE, args: [join(HERE, 'winocr.test.mjs')] },
  { name: 'imglib（图像/PDF 工具）', cmd: PY, args: [join(HERE, 'imglib.test.py')], skipIf: () => !existsSync(PY) },
  { name: 'harness（真实内核服务全流程）', cmd: NODE, args: [join(HERE, 'harness.mjs')], skipIf: () => !existsSync(env.HANHUA_MODULES) },
  { name: 'v2-e2e（字幕/EPUB/漫画/OCR 端到端）', cmd: NODE, args: [join(HERE, 'v2-e2e.mjs')], skipIf: (c) => QUICK || !existsSync(env.HANHUA_MODULES) },
]

const results = []
for (const c of CASES) {
  if (c.skipIf && c.skipIf(c)) { results.push({ name: c.name, status: 'SKIP' }); console.log(`SKIP  ${c.name}（环境缺失）`); continue }
  const t0 = Date.now()
  const r = spawnSync(c.cmd, c.args, { cwd: REPO, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const ms = Date.now() - t0
  const ok = r.status === 0
  results.push({ name: c.name, status: ok ? 'PASS' : 'FAIL', ms })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}  (${ms} ms)`)
  if (!ok) {
    const tail = String((r.stdout || '') + (r.stderr || '')).split('\n').filter((l) => /FAIL|✖|Error|error|assert/i.test(l)).slice(0, 6)
    for (const l of tail) console.log('        ' + l.trim())
  }
}

const passed = results.filter((r) => r.status === 'PASS').length
const failed = results.filter((r) => r.status === 'FAIL').length
const skipped = results.filter((r) => r.status === 'SKIP').length
console.log(`\n===== 全量自检：${passed} 通过 / ${failed} 失败 / ${skipped} 跳过 =====`)
process.exit(failed === 0 ? 0 : 1)
