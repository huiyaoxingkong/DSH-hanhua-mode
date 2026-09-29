# DSH-hanhua-mode · 汉化模式

面向 DSH（DeepSeek Harness）的**多媒体汉化专家模式**：游戏文本、视频字幕、电子书、漫画与图片艺术字，
一条龙完成扫描 → 解析 → OCR（图片）→ 术语词典翻译 → 在线 API 兜底 → QA 质检 → 按原格式/原编码二进制回写。

**v2.0.0 新增**：视频字幕、电子书（EPUB/HTML/PDF）、漫画（CBZ/ZIP/图片）三类载体，
以及一个**省 token 的 OCR 组件**——本地 Windows OCR 优先，只有本机搞不定的（中文描边艺术字、
日文假名）才升级到多模态模型，并按图像哈希缓存。详见 [v2 多媒体与 OCR](docs/V2-多媒体与OCR.md)。

## 支持的载体与格式

| 载体 | 文件格式 | 说明 |
| --- | --- | --- |
| 游戏·通用文本 | JSON / CSV / TSV / PO / INI / TXT / YAML / RenPy | 通用结构解析，按路径/行列/行回写 |
| 游戏·RPG Maker MV / MZ | `data/*.json`、`Map*.json`、`System.json`、`CommonEvents.json` | 地图事件对话(101/401)、选项(102/402)、注释(408)、数据库条目、System 术语 |
| 游戏·RPG Maker XP / VX / VX Ace / mkxp-z | `.rxdata` / `.rvdata` / `.rvdata2`（Ruby Marshal 4.8） | 纯 JS Marshal 读取/写回（保留符号/对象/链接结构）；`Scripts.*` 自动跳过 |
| 游戏·krkr / KAG | `.ks` / `.tjs` / `.scn` / `.csv` / `.txt` | 自动识别 UTF-16LE(BOM)/UTF-16BE/UTF-8/Shift-JIS/GBK；按原编码回写 |
| **视频字幕** | `.srt` `.vtt` `.ass` `.ssa` `.lrc` `.sub` `.smi` | 只换正文，**时间轴/样式/Comment/顺序原样保留**；ASS 覆写标签用 `⟦n⟧` 占位符保护 |
| **视频内嵌字幕轨** | `.mkv` `.mp4` … | `hanhua_media action=subs-extract` 抽取 → 翻译 → `subs-mux` 回封（需本机 ffmpeg） |
| **电子书** | `.epub` | 按 opf spine 顺序遍历 XHTML，整包重打包（`mimetype` 仍第一个且 store） |
| **电子书** | `.html` `.xhtml` | 文本节点抽取/回写（跳过 script/style），HTML 转义安全 |
| **电子书** | `.pdf` | 文本层（FlateDecode + Tj/TJ + ToUnicode）→ 译文对照输出；扫描件走 OCR |
| **漫画 / 图片艺术字** | `.cbz` `.zip` 图包、图片目录、`.png` `.jpg` `.webp` `.bmp` `.gif` `.tga` `.dds` | 区域检测 → OCR → 翻译 → **擦除原文并按框自动排版译文**回写图片/漫画包 |

## 安装

### A. 桌面版（0.2.0-rc.2，推荐）

`$DSH_HOME/.agent-presets/` 目录式预设已被内核废弃，预设现在是 profile 组合里的一行声明：

```powershell
node tools\install-hanhua-desktop.mjs            # 复制插件 + 写声明 + 追加 profile patch（幂等）
node tools\validate-declaration.mjs "$env:USERPROFILE\.dsh\hanhua\cordis.patch.yml"   # 校验可挂载
```

脚本会把 `preset/plugins/hanhua/` 整棵树（含自带的 `node_modules/iconv-lite`）装到
`<DSH_HOME>/hanhua/`，并由随包 standard 派生「汉化模式」声明。**重启 DSH 后**新建会话即可选到
「汉化模式」（11 个 `hanhua_*` 工具）。回滚见 [桌面版安装说明](docs/DESKTOP-0.2.0-install.md)。

### B. 旧内核（0.1.6-alpha.2）目录式预设

1. 打开 `${DSH_HOME:-~/.dsh}/.agent-presets/`
2. 把仓库的 `preset/` 目录复制为 `<预设根>/hanhua/`（`agent.cordis.yml` 与 `preset.yml` 在该目录下）
3. 新建会话选择「**汉化模式**」

> `preset/agent.cordis.yml` 里挂载了本地插件：`name: ./plugins/hanhua/index.js`（相对预设目录解析）。
> 插件消费 host 的 `tools/systemPrompt/fs/web/sandboxPolicy/subprocess` 服务，不提供任何服务，无需 isolate realm。

## 工作流

```
游戏文本：hanhua_scan → hanhua_parse → hanhua_glossary → hanhua_translate → hanhua_qa → hanhua_export
图文载体：hanhua_scan → hanhua_ocr   → hanhua_translate → hanhua_qa → hanhua_export（擦字 + 排版回写）
视频字幕：hanhua_media subs-extract → hanhua_scan/parse → hanhua_translate → hanhua_export → subs-mux
```

浏览器面板（**设置 →「汉化工作台」**）是同一套引擎的第二入口：先在会话里执行
`hanhua_workbench action=install` 装载动态包，再到 Cordis 面板点「仅允许此版本」；
步骤、生命周期与排错见 [装载与使用说明](docs/WORKBENCH-0.1.6.md)。

## 工具（11 个）

| 工具 | 说明 |
| --- | --- |
| `hanhua_scan` | 扫描并按 `game/subtitle/ebook/image/comic/video` 分类（返回 `kinds` 统计） |
| `hanhua_parse` | 提取游戏文本 / 字幕 / 电子书条目（失败文件列在 `errors`） |
| `hanhua_ocr` | **OCR 组件**：图片、漫画页、图片艺术字 → 带坐标的文本条目；本地引擎优先、视觉兜底、哈希缓存、预算限量 |
| `hanhua_translate` | 词典/缓存优先，未覆盖的批量走在线 API；智能跳过 + 语境去重 + 分批 |
| `hanhua_qa` | 占位符（含 `⟦n⟧`）、换行、首尾空格、长度比例、漏译 |
| `hanhua_glossary` | 词典/术语表（完全匹配 > 子串最长 > 正则） |
| `hanhua_export` | 回写：文本/字幕/EPUB/图片；`inplace`（自动 `.bak`）或 `out`（`.hanhua-out/`） |
| `hanhua_media` | 字幕轨抽取/回封、EPUB 解包/打包、`probe` 报告本机能力 |
| `hanhua_usage` | token 账本：API/视觉调用与 token 用量、缓存命中、去重、跳过（可 reset） |
| `hanhua_config` | 读取/修改全部配置（get 会遮蔽 apiKey） |
| `hanhua_workbench` | 装载/查看/停止浏览器工作台面板 |

## 配置（hanhua_config）

| 字段 | 说明 |
| --- | --- |
| `root` | 项目根目录 |
| `apiUrl` / `apiKey` / `model` | OpenAI 兼容 chat/completions 接口（翻译） |
| `visionModel` | 多模态模型（图片艺术字/日文 OCR 兜底），默认 `glm-4v-flash` |
| `targetLang` / `sourceLang` | 目标/源语言 |
| `rgssEncoding` / `krkrEncoding` / `subtitleEncoding` | RGSS / krkr / 字幕文本编码，默认 `auto` |
| `iconvPath` | iconv-lite 绝对路径（桌面安装已自带，通常无需配置） |
| `apiChunk` | 在线 API 每批条数（默认 40，1–100）；越大越省提示词开销 |
| `ocrEngine` / `ocrLang` / `ocrBudget` / `ocrMaxImages` / `ocrLayout` | OCR 引擎链、语言、每次视觉预算（默认 8，0=只用本地）、单次处理页数、布局模式 |
| `typesetFont` | 漫画/艺术字排版字体；留空自动挑可用中文字体 |
| `pythonPath` / `powershellPath` / `ffmpegPath` / `ffprobePath` | 外部工具路径（缺省自动探测） |

## Token 优化

在保证译文质量的前提下尽量少消耗 token（在线 API token + 对话上下文 token）：

| 机制 | 说明 |
| --- | --- |
| 智能过滤 | 无字母（纯数字/符号）或中日韩占比 ≥ 50% 的条目直接跳过（`method=skip`），不产生 API 调用 |
| 语境去重 | 相同原文 + 相同语境只翻译一次，其余复用首条译文 |
| 语境标签压缩 | API 请求按紧凑的 `[语境, 原文]` 对发送（名称/选项/地图对话/字幕/气泡/艺术字…） |
| 分批 | 按 `apiChunk` 分批，单次提示词开销可控 |
| **本地 OCR 优先** | 中文/英文常规字用 Windows 内置 OCR，**零 token**；只对「本地识别不可信」的区域调视觉模型 |
| **OCR 哈希缓存** | 页面内容 sha256 为键，重复运行 0 调用；部分完成的页面只补没做完的区域 |
| **裁剪去重** | 同图同框只识别一次 |
| **视觉批量 + 预算** | 一次请求 ≤4 张裁剪图摊薄提示词；`ocrBudget` 限制每次最多看几张，超出的留到下次 |
| 紧凑预览 | 所有工具只返回 ≤20 条预览 + perFile 统计，翻译预览仅含实际变更条目 |
| 账本 | `hanhua_usage` 给出 API/视觉 token 用量与各项节省计数，可复核「省 token」是否真的生效 |

v2 端到端测试（39 项断言）实测：20 个条目中 4 个走本地 OCR、3 个智能跳过、3 个语境去重，
只有真正需要模型的才花 token；整轮 API+视觉合计 1144 token。

## 内核版本兼容

| 内核 | 状态 | 说明 |
| --- | --- | --- |
| `dsh 0.2.0-rc.2`（桌面封装） | ✅ 已适配并验证 | 声明式预设 + 插件自带 iconv-lite；`harness` 19/19、`v2-e2e` 39/39 通过 |
| `dsh 0.1.6-alpha.2` | ✅ 已适配并验证 | 目录式预设 + `dynamicCordisRunner` 自装工作台 |
| `dsh 0.1.1-rc.2` 及更早 | ⚠️ 未回归验证 | 组合文件已随新版 standard 对齐，旧内核上未再实测 |

审计与验证材料：

- [v2 多媒体与 OCR（功能与限制）](docs/V2-多媒体与OCR.md)
- [主机 API 兼容性审计（0.1.1-rc.2 → 0.1.6-alpha.2）](docs/COMPAT-0.1.6-alpha.2.md)
- [客户端半/动态插件审计](docs/CLIENT-COMPAT-0.1.6-alpha.2.md)
- [独立验证报告](docs/VERIFY-0.1.6-alpha.2.md)
- [汉化工作台装载与使用](docs/WORKBENCH-0.1.6.md)
- [桌面版 0.2.0 安装](docs/DESKTOP-0.2.0-install.md)

## 自检与回归测试

用桌面封装内置 Node（`<安装目录>\runtime\node.exe`）或系统 node：

```powershell
node tests\run-all.mjs              # 11 套全绿（--quick 跳过最慢的端到端）
```

单跑：

```powershell
node tests\mount-check.mjs                  # 组合文件「挂载级」检查：行解析 + 每行 Config 校验
node tests\preset-health.mjs                # 真实 discovery 健康检查（预设选择器口径）
node tests\harness.mjs                      # 真实内核服务下跑通 scan→parse→translate→qa→export
node tests\v2-e2e.mjs                       # 字幕/EPUB/漫画/艺术字 OCR/账本 端到端（本地 mock API）
node tests\build-engine.mjs --check         # 两个信封产物是否仍等于 engine/src/ 的派生结果
& "<python-with-Pillow>" tests\imglib.test.py
```

## 目录结构

```
DSH-hanhua-mode/
├── engine/                 # 动态插件（工作台）产物 + 规范源码
│   ├── src/                # ★ 唯一真源：core/tools/rpc/media/ocr/subtitle/ebook + scripts/
│   ├── host.js             # 生成物：动态包 host 半
│   └── client.js           # 手写：浏览器「汉化工作台」面板
├── preset/                 # 持久化预设成品
│   ├── agent.cordis.yml    # 旧内核（0.1.6）目录式预设组合
│   ├── preset.yml
│   └── plugins/hanhua/     # index.js（生成物）+ engine/{host,client}.js + node_modules/iconv-lite
├── tools/                  # build-engine.mjs（生成器）/ 桌面版安装与校验 / 随包 standard 模板
├── tests/                  # 自检与回归（11 套，含端到端与子进程脚本自测）
├── fixtures/               # 测试夹具生成器与调试脚本
├── docs/                   # 使用手册、v2 功能文档、兼容性审计与验证报告
└── release/                # 成品压缩包
```

## 已知限制

- **PDF 不回写**（只输出译文对照）；PDF 解析为启发式实现，复杂字体/压缩流会跳过并如实报告。
- **视频内嵌字幕轨需要 ffmpeg/ffprobe**：未安装时 `hanhua_media probe` 会明确告知，外挂字幕不受影响。
- `.cbr`/`.rar` 漫画包、`.mobi`/`.azw3` 电子书不支持（建议先用外部工具转换）。
- 本地 Windows OCR 依赖系统语言包（本机有中/英，无日文）——日文内容由视觉模型兜底。
- 区域检测是启发式的，密集网点/气泡可能合并或漏检；可用 `layout`/`ocrMinArea` 调参后重跑。
- 排版不复刻原字体与字形（艺术字只做擦除 + 重绘）。
- RGSS `Scripts.rxdata` 脚本代码不处理（仅跳过）；加密/改造过的 Marshal 数据可能无法解析（`errors` 会报告）。
- `.xp3` 打包的 krkr 资源需先用外部工具解包。
- GBK/Shift-JIS 写回依赖 iconv-lite；插件已自带（`preset/plugins/hanhua/node_modules/`），
  候选顺序为「显式配置 → 插件自带 → profile node_modules → 全局」。
- **目标编码容纳不了中文时会被替换成 `?`**：这类游戏请把 `rgssEncoding`/`krkrEncoding` 设为 `utf-8`。
- 导出时会留下 `.hanhua-tmp/`（子进程脚本与裁剪图）与 `.hanhua-*.json`（状态文件），都可安全删除。
- `.bak` 是**写一次即固定**的「汉化前原文」回滚点：重复导出不会刷新它。

## License

MIT
