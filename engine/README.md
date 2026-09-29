# 引擎源码说明（v2）

> ⚠️ `engine/host.js`、`preset/plugins/hanhua/index.js` 与 `preset/plugins/hanhua/engine/{host,client}.js`
> **都是生成物**。改功能请改 `engine/src/`，然后跑：

```powershell
node tools\build-engine.mjs            # 重新生成全部产物
node tools\build-engine.mjs --check     # 校验产物与源码一致（已进 tests\run-all.mjs）
```

## 目录

```
engine/
├── src/                       ★ 唯一真源
│   ├── subtitle.js            字幕库（纯函数，可单测）：srt/vtt/ass/ssa/lrc/sub/smi
│   ├── ebook.js               电子书文本层（纯函数，可单测）：container/opf/spine/XHTML 文本节点
│   ├── group.js               图片字体关联（纯函数，可单测）：文件名序号序列 / 同图同行碎片 → 语义单元
│   ├── core.js                引擎主体：扫描/解析/翻译/QA/导出/Marshal/krkr/配置/词典
│   ├── media.js               基础设施：子进程脚本、ZIP、HTTP(apiRequest)、字幕/EPUB/图片回写、媒体操作
│   ├── ocr.js                 OCR 组件：区域检测→本地 OCR→视觉兜底→缓存/去重/预算
│   ├── tools.js               TOOL_SPECS（两半共用的工具规格表）+ GUIDE_LINES（提示词）
│   ├── rpc.js                 WORKBENCH_RPC（浏览器面板调用的 workbench.* 处理器）
│   ├── scripts/               子进程脚本（构建时内联成 SCRIPT_SOURCES）
│   │   ├── mediakit.js        ZIP 读写/替换（中央目录 + zip64 读 + 编码回退）+ HTTP JSON
│   │   ├── imglib.py          Pillow/numpy：区域检测 / 裁剪 / 排版 / PDF 文本与图片
│   │   ├── winocr.ps1         Windows.Media.Ocr 桥（批量、缩放坐标换算、语言回退）
│   │   └── runprobe.js        外部命令探测（用文件描述符而非管道，规避沙箱 EPERM）
│   ├── static-tail.js         静态插件尾部：工具注册 + systemPrompt + 工作台自装
│   └── dynamic-tail.js        动态包尾部：harness.defineTool（契约参考）+ harness.handle
├── host.js                    生成物：动态包（「汉化工作台」host 半）
└── client.js                  手写：浏览器「汉化工作台」面板（v2 增加 OCR/能力探测/账本卡片）
```

## 两个信封的差异（生成器负责）

| | 静态插件 `preset/plugins/hanhua/index.js` | 动态包 `engine/host.js` |
| --- | --- | --- |
| 形态 | ESM：`export const name/inject` + `export function apply(ctx)` | 动态包：`return { apply(ctx) {...} }`，作为 **async 函数体**求值 |
| 服务访问 | `ctx.get(name)`（同 core，`svc()` 兜底） | 同左；`harness` 是 vm 沙箱注入的**全局** |
| 工具注册 | `ctx.tools.register`（agent 层，11 个工具） | 只 `harness.defineTool` 保留契约，**不注册到全局表**（避免污染同进程其它会话） |
| 工作台 RPC | 不注册（由它装起来的动态包注册） | `harness.handle` 注册 13 个 `workbench.*` |
| 缩进 | 2 空格 | 4 空格 |

## 环境/内核踩坑备忘（按时间累积）

1. 工具输出 schema 必须是 `{type:'json'}`（`string` 会拒绝结构化返回值）。
2. `FsDirEntry.type` 的值是 `'directory'`（不是 `'dir'`）。
3. 会话工作区必须取 `exec.agent.session.header.cwd`（宿主级 `sandboxPolicy.workspaceRoot` 是进程工作目录）。
4. 写盘必须传 `sandboxPolicy.resolve({session})`，否则写不进会话工作区。
5. `parseFiles` 的 `root` 参数校验后要赋值给 `state.root`。
6. Marshal：文件头 `04 08` 要跳过/写出；`o/u/U/e/S/I` 的类名与 ivar 键是带 `0x3A` 前缀的符号（`readSym`），不能直接 `readName`。
7. 沙箱 `btoa` = UTF-8 编码后 base64；二进制必须用自实现 `bytesToB64`。
8. krkr 引号属性值切片：值域是 `[start+1, end)`，替换后剩余从 `end+1` 开始。
9. `subprocess.spawn` 必须带 `graceMs` 与 `cwd`（0.1.6 起 `cwd` 缺失会抛 `TypeError`）。
10. 提示片段 `order` 用 0.1.6 的中央档位（工具指南 1000–3100 / TOOLS_SDK 5000）→ `order: 3200`。
11. iconv-lite 解析：`node -e` 的 `require()` 从**子进程 cwd** 向上找 `node_modules`；
    候选顺序必须是「显式配置 → 插件自带 → profile node_modules → 全局」，并把候选目录并入 `NODE_PATH`。
12. **动态包不能 `const harness = ...`**：`harness` 是 vm 沙箱注入的全局，遮蔽它会拿到 `undefined`。
13. **不能靠「空 images 调 winocr」探测 OCR 能力**：脚本对空数组返回 `ok:false`；
    改用内联的 1×1 PNG 真跑一次，才能同时拿到 `availableLangs`。
14. **不能把大 base64 塞进 argv**：Windows 命令行上限 32767 字符，漫画包/EPUB 的 `.bak`
    会静默写失败（`backupOnce` 里被 catch 吞掉）。改成超过 16K 就先落盘再传路径。
15. **同一作用域内的 `const` 有 TDZ**：`core.js` 顶层常量引用了子系统常量（如 `SCAN_EXT` 用 `IMAGE_EXTS`），
    所以生成顺序必须是「纯函数库 → media/ocr → core」，且子系统里的查表要**懒建**（`B64CHARS` 在 core 里）。
16. `parseFiles files=[...]` 是增量语义：只替换这些文件的条目，**不能**把其它文件的既有条目/译文清空。
17. `.ps1` 子进程脚本必须保留 **UTF-8 BOM**：PowerShell 5.1 读无 BOM 的 `.ps1` 会按 ANSI 解码，
    中文注释会吃掉引号导致语法错误。构建时内联、运行时落盘都会补 BOM。
18. **图片字体必须「先关联、再识别」**：一个小图一个字形的游戏，逐图 OCR 只会得到碎片/空串；
    正确顺序是 区域检测 → 裁剪 → 分组（group.js）→ 拼接（imglib `stitch`）→ 整体 OCR → **一个**语义单元条目。
    两个易踩的点：(a) 拼接间距/留白**不能大**，否则 OCR 会在碎片之间插空格（`NewGame` → `New Ga me`）；
    (b) 同一张图里同行的碎片**不要拼接**，直接裁原图并集框（保留真实字距，`Continue` 才不会被读成 `Con tinue`）。
19. **`imglib.stitch` 单条失败时整体 `ok:false`（成功的条目仍写盘）**：调用要带 `allowFail`，
    再按返回的 `files[].out` 决定哪些拼接条可用；只对**真正提交给 stitch 的组**做失败回退，
    否则会把走「并集裁剪」的 atlas 组一起误删（这个 bug 真实踩过）。
20. **同一作用域内的 `const` 有 TDZ（续）**：`group.js` 必须排在 `core.js` 之前的 libs 段，
    且它内部只能有惰性初始化（不能在建包时就引用 core 的常量）。

> 自检：`node ..\tests\run-all.mjs`（11 套：挂载/派生一致性/生成物一致/库单测/子进程脚本自检/真实内核全流程/v2 端到端）。

## 与预设版的关系

`preset/plugins/hanhua/index.js`（静态插件）与 `engine/host.js`（动态包）由**同一份 `engine/src/` 生成**，
因此不再存在「两份源码需手动同步」的问题——这也修掉了 v1 时代真实发生过的漂移
（`iconvPath` 默认值、`resolveRoot`、`parseFiles` 的 `errors`、Marshal 读取修复、`401` 指令各只有一半）。
