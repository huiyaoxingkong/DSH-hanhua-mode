/**
 * 校验 0.2.0-rc.2 的预设声明（patch 文件里的 `@deepseek-ai/dsh-agent-preset` 行）：
 *   1. YAML 能解析（含 !!js 表达式，用内核的 cordis-plugin-include schema）；
 *   2. preset 行自身的 config 满足 `@deepseek-ai/dsh-agent-preset` 的 Config schema；
 *   3. config.plugins（递归，含 group 行）里每一行：
 *        - 行名可解析（包名 / file: URL / cordis: 内置）；
 *        - 能 import（本地文件或已解出的内核包）；
 *        - config 通过该插件自己的 Config schema 校验（顺序/必填/未知键与挂载时一致）。
 *
 * 用法：node tools/validate-declaration.mjs <patch.yml> [--kernel <已解出的 node_modules>]
 */
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const argv = process.argv.slice(2)
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }
const PATCH = resolve(argv[0] ?? '')
const KERNEL = resolve(argOf('--kernel', 'D:/Games/汉化模式/.kernel-0.2.0/node_modules'))
if (!existsSync(PATCH)) throw new Error(`patch 不存在：${PATCH}`)
const requireFromKernel = createRequire(join(KERNEL, 'noop.js'))

const include = await import(pathToFileURL(join(KERNEL, '@deepseek-ai/cordis-plugin-include/lib/index.js')).href)
const yaml = await import(pathToFileURL(join(KERNEL, 'js-yaml/index.js')).href)
const doc = yaml.load(readFileSync(PATCH, 'utf8'), { schema: include.entryListSchema })

const problems = []
const ok = []

/** 收集 patch 列表里所有 @deepseek-ai/dsh-agent-preset 行。 */
function findPresetRows(list, acc = []) {
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue
    if (Array.isArray(entry.insert)) findPresetRows(entry.insert, acc)
    if (entry.name === '@deepseek-ai/dsh-agent-preset') acc.push(entry)
  }
  return acc
}
const presetRows = findPresetRows(doc)
if (!presetRows.length) problems.push('patch 里没有 @deepseek-ai/dsh-agent-preset 行')
console.log(`patch: ${PATCH}\n预设声明行：${presetRows.length}`)

const resolveRow = (name) => {
  if (name.startsWith('cordis:')) return { kind: 'builtin' }
  if (name.startsWith('file:')) {
    const p = fileURLToPath(name)
    return existsSync(p) ? { kind: 'file', url: name, path: p } : { kind: 'missing', detail: p }
  }
  try { return { kind: 'package', url: pathToFileURL(requireFromKernel.resolve(name)).href } }
  catch (e) { return { kind: 'missing', detail: e.message } }
}

async function validateRows(rows, presetId, depth = 0) {
  for (const row of rows) {
    const name = String(row.name ?? '')
    const label = `${presetId}${'  '.repeat(depth)} / ${row.id ?? name}`
    if (row.disabled !== undefined) {
      const disabled = typeof row.disabled === 'function' ? row.disabled() : row.disabled
      if (disabled) { ok.push(`${label}（disabled，跳过）`); continue }
    }
    const res = resolveRow(name)
    if (res.kind === 'missing') { problems.push(`${label}: 行名无法解析 ${name} — ${res.detail}`); continue }
    if (res.kind === 'builtin') { ok.push(`${label}（内置）`); }
    else {
      let mod
      try { mod = await import(res.url) } catch (e) { problems.push(`${label}: import 失败 ${name} — ${e.message}`); continue }
      const schema = mod.Config ?? mod.default?.Config
      if (schema === undefined) { ok.push(`${label}（无 Config）`); continue }
      const config = (row.config !== undefined && !Array.isArray(row.config)) ? row.config : {}
      const result = schema['~standard'].validate(config)
      if (result.issues) {
        problems.push(`${label}: config 校验失败 (${name})`)
        for (const issue of result.issues) problems.push(`      - ${issue.message} (at ${(issue.path ?? []).join('.') || '<root>'})`)
        continue
      }
      ok.push(`${label}`)
    }
    if (Array.isArray(row.config)) await validateRows(row.config, presetId, depth + 1)
  }
}

for (const preset of presetRows) {
  const presetMod = await import(pathToFileURL(join(KERNEL, '@deepseek-ai/dsh-agent-preset/lib/index.js')).href)
  const Config = presetMod.Config ?? presetMod.default?.Config
  const check = Config['~standard'].validate(preset.config ?? {})
  if (check.issues) {
    problems.push(`preset 行 ${preset.id}: 声明校验失败`)
    for (const i of check.issues) problems.push(`      - ${i.message} (at ${(i.path ?? []).join('.') || '<root>'})`)
    continue
  }
  const id = preset.config.id
  const plugins = preset.config.plugins ?? []
  console.log(`\n=== preset "${id}"（${preset.config.name ?? '无名'}，${plugins.length} 个顶层行）===`)
  await validateRows(plugins, id)
}

console.log(`\n通过 ${ok.length} 行`)
if (problems.length) {
  console.log(`\n发现问题 ${problems.length} 条：`)
  for (const p of problems) console.log('  - ' + p)
  process.exit(1)
}
console.log('声明可挂载 ✅')
