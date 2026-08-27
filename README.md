# DSH-hanhua-mode · 汉化模式

面向 DSH（DeepSeek Harness）的游戏汉化专家模式：扫描、解析、术语词典翻译、在线 API 兜底、QA 质检、按原格式/原编码二进制回写，一条龙完成游戏汉化。

## 支持的引擎与格式

| 引擎 | 文件格式 | 说明 |
| --- | --- | --- |
| 通用文本 | JSON / CSV / TSV / PO / INI / TXT / YAML / RenPy | 通用结构解析，按路径/行列/行回写 |
| RPG Maker MV / MZ | `data/*.json`、`Map*.json`、`System.json`、`CommonEvents.json` | 地图事件对话(101/401)、选项(102/402)、注释(408)、数据库条目、System 术语 |
| RPG Maker XP / VX / VX Ace / mkxp-z（RGSS 家族） | `.rxdata` / `.rvdata` / `.rvdata2`（Ruby Marshal 4.8） | 纯 JS 实现的 Marshal 读取/写回（保留符号/对象/链接结构），地图事件、数据库、System 术语、公共事件；`Scripts.*` 自动跳过 |
| krkr / KAG（KiriKiri） | `.ks` / `.tjs` / `.scn` / `.csv` / `.txt` | 自动识别 UTF-16LE(BOM)/UTF-16BE/UTF-8/Shift-JIS/GBK；标签属性(`text=`/`name=`/`title=` 等)与裸文本行提取；按原编码回写 |

## 安装（DSH 预设）

1. 打开 DSH 用户预设根目录：`${DSH_HOME:-~/.dsh}/.agent-presets/`
2. 把本仓库的 `preset/` 目录复制为 `<预设根>/hanhua/`（即 `agent.cordis.yml` 与 `preset.yml` 位于该目录下）
3. 新建会话时选择「**汉化模式**」预设即可；重启后功能依然可用

> `preset/agent.cordis.yml` 中挂载了本地插件包：`name: ./plugins/hanhua/index.js`（相对预设目录解析）。插件消费 host 的 `tools/systemPrompt/fs/web/sandboxPolicy/subprocess` 服务，不提供任何服务，无需 isolate realm。

## 工作流

```
hanhua_scan 扫描项目
  → hanhua_parse 提取全部文本（errors 字段列出失败文件）
  → hanhua_glossary 维护术语词典（人名/地名/道具名必须统一）
  → hanhua_translate 翻译（词典优先，可选在线 API 兜底）
  → hanhua_qa 质检（占位符/换行/长度/漏译）
  → hanhua_export 写回（inplace 自动 .bak 备份 / out 输出镜像目录）
```

## 配置（hanhua_config）

| 字段 | 说明 |
| --- | --- |
| `root` | 项目根目录（游戏目录） |
| `apiUrl` / `apiKey` / `model` | OpenAI 兼容 chat/completions 接口，用于词典未覆盖文本的在线翻译 |
| `targetLang` / `sourceLang` | 目标/源语言 |
| `rgssEncoding` | RGSS 字符串编码（`auto`/`utf-8`/`gbk`/`shift_jis`），默认 `auto` |
| `krkrEncoding` | krkr 文本编码，默认 `auto` |
| `iconvPath` | iconv-lite 绝对路径，用于 GBK/Shift-JIS 写回；不设置时尝试 node 全局解析 |

## 目录结构

```
DSH-hanhua-mode/
├── engine/          # 动态插件源码（本会话运行的版本）
│   ├── host.js      # 引擎主体（解析/翻译/QA/导出/Marshal/krkr）
│   └── client.js    # 浏览器「汉化工作台」面板
├── preset/          # 「汉化模式」持久化预设成品（复制到 .agent-presets/hanhua）
│   ├── agent.cordis.yml
│   ├── preset.yml
│   └── plugins/hanhua/{package.json,index.js}
├── fixtures/        # 测试夹具生成器与调试脚本
├── docs/            # 使用手册与引擎说明
└── release/         # 成品压缩包
```

## 已知限制

- RGSS `Scripts.rxdata` 脚本代码不处理（仅跳过）；加密/改造过的 Marshal 数据可能无法解析（errors 会报告）。
- `.xp3` 打包的 krkr 资源需先用外部工具解包。
- GBK/Shift-JIS 写回依赖 iconv-lite（node 子进程）；离线词典模式不联网。
- RGSS 字符串按 `rgssEncoding` 配置统一解码，同一游戏混用多种编码时建议逐文件处理。

## License

MIT
