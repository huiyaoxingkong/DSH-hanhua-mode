/**
 * 把「汉化模式」安装到 DSH 桌面版（0.2.0-rc.2 的声明式预设）。
 *
 * 背景：0.2.0 起 `$DSH_HOME/.agent-presets/<id>/` 目录式预设不再被任何代码读取，
 * 预设是 profile 组合里的一个 `@deepseek-ai/dsh-agent-preset` 行。因此本脚本：
 *   1) 把插件整棵树（index.js + engine/{host,client}.js + 自带 node_modules）复制到
 *      <home>/hanhua/plugins/hanhua/；
 *   2) 由随包 standard.patch.yml（仓库自带 tools/standard.patch.yml）派生
 *      <home>/hanhua/cordis.patch.yml：persona 换汉化文案 + 追加本地引擎行；
 *   3) 把该声明带标记地追加进 <home>/profiles/<profile>/cordis.patch.yml（幂等）；
 *   4) 同时写出 bundle 清单，供官方 plugin_manager install_bundle 使用。
 *
 * 仓库自包含：iconv-lite 已随 preset/plugins/hanhua/node_modules 一起提交，
 * 无需再从别的安装目录拷依赖。
 *
 * 用法：node tools/install-hanhua-desktop.mjs [--home <DSH_HOME>] [--profile desktop] [--dry]
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const argv = process.argv.slice(2)
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }
const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const HOME = resolve(argOf('--home', process.env.DSH_HOME || 'C:/Users/lihao/.dsh'))
const PROFILE = argOf('--profile', process.env.DSH_PROFILE || 'desktop')
const TEMPLATE = join(REPO, 'tools', 'standard.patch.yml')
const SRC_PLUGIN_DIR = join(REPO, 'preset', 'plugins', 'hanhua')
const DRY = argv.includes('--dry')
const VERSION = '2.1.0'

const PRESET_ID = 'hanhua'
const INSTALL_DIR = join(HOME, 'hanhua')
const PLUGIN_DIR = join(INSTALL_DIR, 'plugins', 'hanhua')
const PLUGIN_ENTRY = join(PLUGIN_DIR, 'index.js')
const PLUGIN_URL = 'file:///' + PLUGIN_ENTRY.replace(/\\/g, '/')
const PROFILE_PATCH = join(HOME, 'profiles', PROFILE, 'cordis.patch.yml')
const MARK_START = '# >>> hanhua-mode preset (managed by install-hanhua-desktop.mjs)'
const MARK_END = '# <<< hanhua-mode preset'

const PERSONA_PREFIX = '你是「汉化模式」多媒体本地化专家 Agent，由 {{model}} 驱动。核心流程：hanhua_scan 扫描项目 → hanhua_parse 提取文本（游戏文本/视频字幕/电子书）→ hanhua_ocr 处理图片艺术字与漫画页（本地 Windows OCR 优先，识别不了才用视觉模型兜底）→ hanhua_glossary 维护术语词典 → hanhua_translate 翻译（词典优先，可选在线 API 兜底）→ hanhua_qa 质检 → hanhua_export 写回（自动 .bak 备份；漫画/艺术字会擦除原文并排版译文）。铁律：绝不破坏占位符（%s、{0}、\\N[1]、\\V[5]、<color>、ASS 的 {\\an8} 等）、时间轴、换行与 JSON/Marshal/EPUB 结构；术语全文统一；导出前确认备份已生成。省 token：能本地 OCR 就不要调视觉模型，能查词典/缓存就不要调 API，用 hanhua_usage 复核。'
const PERSONA_SUFFIX = '工作目录 {{cwd}} 是汉化项目根目录。先用 hanhua_scan/hanhua_parse 摸清文本、hanhua_ocr 摸清图片，再动 hanhua_export 写回。'
const DESCRIPTION = '多媒体汉化专家模式：游戏文本（JSON/Marshal/krkr/RenPy）、视频字幕（SRT/VTT/ASS/SSA/LRC）、电子书（EPUB/HTML/PDF）与漫画图片艺术字 OCR，一体化扫描解析、词典优先翻译、QA 质检与安全回写（省 token）。'

/** 由随包 standard 派生 preset-hanhua 声明。 */
function buildDeclaration() {
  let text = readFileSync(TEMPLATE, 'utf8')
  text = text.replace(/^#.*\n(?:#.*\n)*/m, `# 「汉化模式」预设声明（由桌面版随包 standard 派生）。\n# 安装：本文件的 insert 项追加到 $DSH_HOME/profiles/${PROFILE}/cordis.patch.yml，\n# 或作为 bundle（package.json 里的 dsh.bundle.patch）用 plugin_manager 安装。\n`)
  text = text.replace('    - id: preset-standard\n', '    - id: preset-hanhua\n')
  const presetHeadRe = / {8}id: standard\n {8}order: 1\n/
  if (!presetHeadRe.test(text)) throw new Error('未能在模板里定位 preset 行的 id/order')
  text = text.replace(presetHeadRe, `        id: ${PRESET_ID}\n        name: 汉化模式\n        description: ${DESCRIPTION}\n        order: 10\n`)
  const personaRe = /( {14}suffix: ).*\n( {14}prefix: ).*\n/
  if (!personaRe.test(text)) throw new Error('未能在模板里定位 persona 的 suffix/prefix')
  text = text.replace(personaRe, `$1${PERSONA_SUFFIX}\n$2${PERSONA_PREFIX}\n`)
  text = text.replace(/\s*$/, '\n')
  text += `          - id: hanhua-engine\n            name: '${PLUGIN_URL}'\n`
  return text
}

const log = (...a) => console.log(...a)
if (!existsSync(TEMPLATE)) throw new Error(`模板不存在：${TEMPLATE}`)
if (!existsSync(join(SRC_PLUGIN_DIR, 'index.js'))) throw new Error('仓库插件不存在：' + SRC_PLUGIN_DIR)

const declaration = buildDeclaration()

if (DRY) {
  log('[dry] 将写入：')
  log('  ' + PLUGIN_ENTRY + '（+ engine/ + node_modules/）')
  log('  ' + join(INSTALL_DIR, 'cordis.patch.yml'))
  log('  ' + join(INSTALL_DIR, 'package.json'))
  log('  ' + PROFILE_PATCH + ' （追加声明块）')
  log('插件 URL: ' + PLUGIN_URL)
  process.exit(0)
}

// ── 1) 复制整棵插件树（index.js + engine/ + 自带 node_modules/iconv-lite）──
let copied = 0
const copyTree = (src, dst) => {
  mkdirSync(dst, { recursive: true })
  for (const e of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, e.name)
    const d = join(dst, e.name)
    if (e.isDirectory()) copyTree(s, d)
    else if (e.isFile()) { copyFileSync(s, d); copied++ }
  }
}
mkdirSync(PLUGIN_DIR, { recursive: true })
copyTree(SRC_PLUGIN_DIR, PLUGIN_DIR)
log(`插件已安装：${PLUGIN_ENTRY}（${copied} 个文件）`)
if (!existsSync(join(PLUGIN_DIR, 'node_modules', 'iconv-lite'))) {
  log('警告：插件里没有自带 iconv-lite —— GBK/Shift-JIS 回写将依赖 hanhua_config 的 iconvPath 或 profile node_modules')
}

// ── 2) 预设声明 + bundle 清单 ────────────────────────────────────────────
mkdirSync(INSTALL_DIR, { recursive: true })
writeFileSync(join(INSTALL_DIR, 'cordis.patch.yml'), declaration, 'utf8')
writeFileSync(join(INSTALL_DIR, 'package.json'), JSON.stringify({
  name: '@local/dsh-hanhua-preset',
  version: VERSION,
  private: true,
  type: 'module',
  dsh: { bundle: { patch: './cordis.patch.yml' } },
}, null, 2) + '\n', 'utf8')
log(`预设声明：${join(INSTALL_DIR, 'cordis.patch.yml')}`)
log(`bundle 清单：${join(INSTALL_DIR, 'package.json')}`)

// ── 3) 装进 profile patch（带标记，幂等）──────────────────────────────────
if (!existsSync(PROFILE_PATCH)) throw new Error(`profile patch 不存在：${PROFILE_PATCH}（桌面版请先启动一次，或用 --profile 指定）`)
const original = readFileSync(PROFILE_PATCH, 'utf8')
const marked = `${MARK_START}\n${declaration.trimEnd()}\n${MARK_END}\n`
let next
const startIdx = original.indexOf(MARK_START)
if (startIdx >= 0) {
  const endIdx = original.indexOf(MARK_END, startIdx)
  next = original.slice(0, startIdx) + marked + original.slice(endIdx + MARK_END.length).replace(/^\s*/, '\n')
} else {
  next = original.replace(/\s*$/, '\n') + '\n' + marked
}
writeFileSync(PROFILE_PATCH + '.hanhua-backup', original, 'utf8')
writeFileSync(PROFILE_PATCH, next, 'utf8')
log(`profile patch 已更新（原文件备份为 ${PROFILE_PATCH}.hanhua-backup）`)
log('\n完成。重启 DeepSeek Harness 后，新建会话的预设列表里会出现「汉化模式」（11 个 hanhua_* 工具）。')
