/**
 * 由「新版随包标准预设」生成「汉化模式」的组合文件。
 *
 * 为什么这样做：本预设原本是 0.1.1-rc.2 版 standard 的整份拷贝 + 一行本地插件；
 * 0.1.6-alpha.2 的 standard 有多处结构性与字段性变化（persona 由 `text` 改为
 * 必填的 `prefix`（+ 可选 `suffix`）等）。逐字段手改容易漏，故以新版 standard
 * 为唯一基准，只替换 persona 正文并追加本地引擎行。
 *
 * 用法：node tests/build-composition.mjs [--check]
 *   --check  只比较，不写盘（退出码 1 表示当前文件与生成结果不一致）
 */
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const STANDARD = 'D:/Agent-windows/DeepSeekHarness/core/packages/preset/agent-presets/presets/standard/agent.cordis.yml'
const TARGET = join(REPO, 'preset', 'agent.cordis.yml')
const CHECK = process.argv.includes('--check')

// 汉化模式 persona：新版把 persona 拆成 prefix（最前）+ suffix（第一方指南之后）。
const PREFIX = `      你是「汉化模式」游戏本地化专家 Agent，由 {{model}} 驱动。核心流程：hanhua_scan 扫描项目 → hanhua_parse 提取全部文本 → hanhua_glossary 维护术语词典 → hanhua_translate 翻译（词典优先，可选在线 API 兜底）→ hanhua_qa 质检 → hanhua_export 写回（自动 .bak 备份）。铁律：绝不破坏占位符（%s、{0}、\\N[1]、\\V[5]、<color> 等）、换行与 JSON 结构；术语全文统一；导出前确认备份已生成。`
const SUFFIX = `工作目录 {{cwd}} 是游戏汉化项目根目录。先用 hanhua_scan/hanhua_parse 摸清文本，再动 hanhua_export 写回。`

const standard = await readFile(STANDARD, 'utf8')

// 1) 替换 persona 行配置块（标准预设固定形态：suffix 一行 + prefix 折叠块）
const personaBlock = /- id: persona\n  name: '@deepseek-ai\/dsh-persona'\n  config:\n(?:    .*\n)+/
if (!personaBlock.test(standard)) throw new Error('未能在标准预设中定位 persona 配置块，生成器需同步更新')
const withPersona = standard.replace(
  personaBlock,
  `- id: persona\n  name: '@deepseek-ai/dsh-persona'\n  config:\n    suffix: ${SUFFIX}\n    prefix: >-\n${PREFIX}\n`,
)

// 2) 追加本地汉化引擎行
const HANHUA_ROW = `
# ── 汉化引擎（本地插件包） ─────────────────────────────────────────────
# 消费 host 的 tools/systemPrompt/fs/web/sandboxPolicy/subprocess 服务，不提供任何服务，无需 isolate realm。
- id: hanhua-engine
  name: ./plugins/hanhua/index.js
`
const generated = withPersona.replace(/\s*$/, '\n') + HANHUA_ROW

if (CHECK) {
  const current = await readFile(TARGET, 'utf8').catch(() => '')
  if (current === generated) {
    console.log('OK   preset/agent.cordis.yml 与新版标准派生结果一致')
    process.exit(0)
  }
  console.log('DIFF preset/agent.cordis.yml 与新版标准派生结果不一致')
  process.exit(1)
}

await writeFile(TARGET, generated, 'utf8')
console.log('wrote', TARGET, `(${generated.split('\n').length} 行)`)
