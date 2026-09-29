/**
 * 预设「挂载前检查」：复刻 Cordis Loader 在装配每一行时做的两件事——
 *   1. 解析行名（包名 / 相对组合文件的本地文件 / 内置加载器行）；
 *   2. 用该行插件的 Config schema 校验行内 config（`runtime.Config['~standard'].validate`）。
 * 第 2 步正是 discovery 的健康检查**不做**、却会在挂载时让整份预设失败的环节
 * （0.1.6-alpha.2 的 persona 行把必填键从 `text` 改成 `prefix` 就死在这里）。
 *
 * 用法：node tests/mount-check.mjs [组合文件路径 ...]
 * 退出码：0 = 全部行可挂载；1 = 有行会失败。
 */
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
// 与运行中的应用一致：随包内核 CLI 所在目录即行内包名的解析基准
const HARNESS_BASE = 'D:/Agent-windows/DeepSeekHarness/core/apps/cli/'
const requireFromHarness = createRequire(join(HARNESS_BASE, 'package.json'))

const PROFILE_MODULES = 'D:/Agent-windows/DeepSeekHarness/data/.dsh/profiles/node_modules'
const { entryListSchema } = await import(pathToFileURL(join(PROFILE_MODULES, '@deepseek-ai/cordis-plugin-include/lib/index.js')).href)
const yaml = await import(pathToFileURL(join(PROFILE_MODULES, 'js-yaml/index.js')).href)

const compositions = process.argv.slice(2)
const files = compositions.length > 0 ? compositions : [join(REPO, 'preset', 'agent.cordis.yml')]

let failures = 0
let checked = 0

/** 递归收集行：group 行的 config 是子行数组（discovery 的口径）。 */
function collectRows(rows, acc = []) {
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    acc.push(row)
    if (Array.isArray(row.config)) collectRows(row.config, acc)
  }
  return acc
}

const isDisabled = (row) => {
  const value = row.disabled
  if (typeof value === 'function') {
    try { return Boolean(value()) } catch { return true }
  }
  return Boolean(value)
}

for (const file of files) {
  console.log(`\n=== ${file} ===`)
  const raw = await readFile(file, 'utf8')
  const rows = yaml.load(raw, { schema: entryListSchema })
  const all = collectRows(rows)
  const base = pathToFileURL(dirname(resolve(file)) + '/').href

  for (const row of all) {
    if (isDisabled(row)) continue
    const name = String(row.name ?? '')
    if (name === '') { console.log(`FAIL  ${row.id ?? '?'} 行缺少 name`); failures++; continue }
    if (name.startsWith('cordis:')) { checked++; continue }

    // 1) 解析行名
    let moduleUrl
    try {
      if (name.startsWith('.')) moduleUrl = new URL(name, base).href
      else if (name.startsWith('file:')) moduleUrl = name
      else if (isAbsolute(name)) moduleUrl = pathToFileURL(name).href
      else moduleUrl = pathToFileURL(requireFromHarness.resolve(name)).href
    } catch (e) {
      console.log(`FAIL  row "${row.id ?? name}": 无法解析 ${name} — ${e.message}`)
      failures++
      continue
    }

    // 2) 导入并校验 config
    let mod
    try {
      mod = await import(moduleUrl)
    } catch (e) {
      console.log(`FAIL  row "${row.id ?? name}": 导入失败 ${name} — ${e.message}`)
      failures++
      continue
    }
    const schema = mod.Config ?? mod.default?.Config
    const config = row.config !== undefined && !Array.isArray(row.config) ? row.config : {}
    if (schema === undefined) { checked++; continue }
    const result = schema['~standard'].validate(config)
    if (result.issues) {
      console.log(`FAIL  row "${row.id ?? name}": config 校验失败 (${name})`)
      for (const issue of result.issues) console.log(`        - ${issue.message} (at ${(issue.path ?? []).join('.') || '<root>'})`)
      failures++
      continue
    }
    checked++
  }
}

console.log(`\n===== 检查 ${checked} 行；${failures} 行会挂载失败 =====`)
process.exit(failures === 0 ? 0 : 1)
