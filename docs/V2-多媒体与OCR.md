# v2：漫画 / 电子书 / 视频字幕 + 图片艺术字与图片字体 OCR

> 适用版本：**2.1.0**（内核 dsh 0.2.0-rc.2 / 0.1.6-alpha.2）
> 相关实现：`engine/src/{subtitle,ebook,group,core,media,ocr}.js`、`engine/src/scripts/{mediakit.js,imglib.py,winocr.ps1}`

## 0. 一句话

v1 只会汉化**游戏文本**；v2 把「汉化载体」扩到**视频字幕、电子书、漫画、图片艺术字**，
并加入一个 **OCR 组件**——它先免费地在本机识别，只有本机搞不定的（中文描边艺术字、
日文假名）才升级到多模态模型，且结果按图像哈希缓存，重复运行零成本。
v2.1 再补上**图片字体**（游戏把字做成图片、一个词由多张小图拼成）：**先关联、再识别**，
保证送去翻译的是完整词组而不是碎片，译文才可能通顺。

## 1. 新增的四类载体

| 载体 | 扩展名 | 解析 | 回写 | 说明 |
| --- | --- | --- | --- | --- |
| 视频字幕 | `.srt` `.vtt` `.ass` `.ssa` `.lrc` `.sub`(MicroDVD) `.smi` | 按格式抽正文，**时间轴/样式/注释/顺序原样保留** | 只替换正文的字符区间，其余字节不动 | ASS/SSA 的覆写标签（`{\an8}`、`\N`、`\h`）换成 `⟦n⟧` 占位符再送翻译，回写时还原；编码自动识别（UTF-8/UTF-16/Shift-JIS/GBK） |
| 视频里的内嵌字幕轨 | `.mkv` `.mp4` `.avi` … | 用 `ffmpeg/ffprobe` 抽成 `.srt` 再走上面流程 | `hanhua_media action=subs-mux` 回封成新文件 | **需要本机有 ffmpeg**（本机当前没有，见「限制」） |
| 电子书 | `.epub` | 读 ZIP → `META-INF/container.xml` → opf → spine 顺序 → 逐个 XHTML 抽文本节点 | **整包重打包**：保留条目顺序、目录项与压缩方式，`mimetype` 仍是第一个且 store | 2 章夹具实测：章节正文汉化、7 个条目顺序不变、7z/Python zipfile 都能读 |
| 电子书（网页形态） | `.html` `.htm` `.xhtml` | XHTML 文本节点（跳过 `script/style/svg`） | 按偏移替换并做 HTML 转义 | 内联标签之间的碎片文本按节点独立翻译，回写零风险 |
| 电子书（PDF） | `.pdf` | 解析间接对象 + `FlateDecode` 解码后抽 `Tj/TJ`，支持 `ToUnicode` 的 bfchar/bfrange | **不回写 PDF**，输出 `.hanhua-out/<name>.hanhua.txt` 译文对照 | 扫描件无文本层时报告 `hasText:false`，改用 OCR 路径 |
| 漫画 | `.cbz` `.zip` 图片包、图片目录、单图 | 逐页抽区域 → OCR → 条目带 `(页, 框)` 坐标 | 逐页**擦除原文 + 自动字号排版译文**，再 `zip-replace` 回包（未改页按原始压缩字节搬运） | 900×600 双页夹具实测：页数/尺寸不变、内容已变、`.bak` 为汉化前原包 |
| 图片艺术字 | `.png` `.jpg` `.webp` `.bmp` `.gif` `.tga` `.dds` … | 区域检测（描边大字用 `art` 模式）→ OCR | 擦除原字 + 排版译文（`auto` 擦除会采样框外底色并重建局部背景，白底/渐变底都保留） | 标题图 10413 → 8433 字节实测，框外像素零改动 |

`hanhua_scan` 会把文件按 `game / subtitle / ebook / image / comic / video` 分类统计，
`hanhua_parse` 负责前三类，`hanhua_ocr` 负责 image/comic，`hanhua_media` 负责 video 与打包。

## 2. OCR 组件（`hanhua_ocr`）

### 2.1 引擎链

```
区域检测 (Pillow/numpy，本地)  →  裁剪 (+小图 2× 放大)  →  本地 Windows OCR (powershell.exe + WinRT)
                                                            │
                                          结果可信？ ── 否 ──┴──→  视觉模型（多模态，批量 ≤4 张/请求）
```

* **本地 Windows OCR**：零安装、零 token、离线。本机实测可用语言 `en-US`、`zh-Hans-CN`，
  一次 PowerShell 进程批量处理所有裁剪（6 张 999ms vs 逐张 ~600–800ms/次）。
* **视觉模型**：OpenAI 兼容多模态接口（默认 `glm-4v-flash`），一次请求带多张裁剪图，
  只要求返回 JSON 字符串数组，摊薄提示词开销。
* **区域检测**：积分图局部自适应二值化 → 膨胀/腐蚀 → 行程编码 + 并查集 8 连通 →
  过滤/同行合并/空白带切分 → 按漫画阅读顺序（上→下、行内右→左）排序；
  4000×3000 图 0.53s（先降采样到 1600 再映射回原坐标）。

### 2.2 为什么要视觉兜底：一条实测结论

`tests/winocr.test.mjs` 的实测（Windows 内置 OCR）：

| 图 | 结果 |
| --- | --- |
| 120px 粗体中文 + 描边 3 | **空字符串** |
| 200px 常规字重 + 描边 3 | `汉 化 模 式`（4/4 正确） |
| 200px 粗体 + 描边 3 | **空** |
| 120px + 描边 8 | `汊 0 模 0`（乱码） |
| 220px 英文粗体 + 描边 3 | `BOOM`（正确） |

**致命点：空结果与「图中无字」不可区分**（都是 `ok:true, text:""`）。所以引擎的策略是：

> 区域检测说「这里有字」+ 本地 OCR 说「没有」 ⇒ **不可信**，交给视觉模型兜底。

`ocrLooksUnreliable()` 判据：空/无字母无 CJK 字符/乱码占比 ≥ 60% / 信号字符 ≤2 且区域墨迹 >5%。

### 2.3 图片字体：先关联、再识别（v2.1）

有些游戏不用字体文件，而是把字**做成图片**：一个按钮标签由若干张小图（每个碎片一个文件，
或同一张图里被间隙分开的若干块）拼出来。逐张 OCR 只会得到碎片（`New` / `Ga` / `me`），
空串或乱码也常见；拿碎片去翻译必然不通顺。因此管线是：

```
区域检测 → 裁剪 → 【分组/关联】 → 拼接成一条 → 整体 OCR → 一个语义单元条目 → 整句翻译
                     │                                            └→ 回写：整句画在锚点碎片，其余碎片擦空
                     └─ 规则 1（sequence）：文件名序号序列（btn_newgame_0/1/2.png）
                     └─ 规则 2（atlas）  ：同一张图里同一行的碎片（间隙 > 1.2×行高被检测拆开，
                                            但 < 2.5×行高 → 仍属于同一个词/标签）
```

**为什么先关联再识别，而不是先识别再拼句子？**
拼接后的条子给了 OCR 完整的上下文（字距、基线、词间关系），识别率远高于碎片；
而且一次 OCR 出一个词，比每个碎片各跑一次（还可能各自触发视觉兜底）更省。实测本机：
碎片各自识别会得到 `''`/`lNew`，拼接后得到 `NewGame`。

| 环节 | 做法 | 为什么 |
| --- | --- | --- |
| 分组（序号序列） | 文件名去掉结尾序号（`_0` `-1` ` 2` `(3)`）后同目录同 stem 且序号连续、成员数 2–8 | 一个词很少由 8 张以上碎片拼成，超过就当它是「一串独立图标」不关联 |
| 分组（同行碎片） | 同一张图内垂直重叠 ≥50%、高度比 ≤2.5 视为同一行，行内间隙 > 2.5×行高才断开成另一个词组 | 区域检测会把间隙 > 1.2×行高的碎片拆成两块，这里再把「同一个词」的碎片合回来 |
| 只对 UI 小图启用序号规则 | 整页面积 > 420000px²（约 650×650）的图不参与 | 否则 `page_001…page_400` 这种整页图会被当成一个词 |
| 拼接 | 横向拼接，**按墨迹底边对齐**，间距取 2px×放大倍数、不留 padding | 留白/大间距会被 OCR 当成空格，`NewGame` 被读成 `New Ga me` |
| atlas 不拼接 | 直接裁原图的并集框 | 保留原图真实字距，`Continue` 才不会被读成 `Con tinue` |
| 回写 | 整句译文画在**锚点碎片**（序号最小的那张 / 并集框）上，其余碎片**只擦不画** | 无法把译文按字拆回每张小图；擦空其余碎片才能让界面上只剩一句完整的话 |

**语义通顺的三道保障**：

1. 送翻译的是**拼接后的完整词组**（`New Game`、`Options`），不是碎片；
2. 提示词给语境标签 `图片字体标签`，并附上**同屏其它标签**（同目录/同页的其它 imagefont 源文本），
   让模型把一屏菜单译成同一套风格（`New Game/Options/Quit` → 新游戏/设置/退出）；
3. `hanhua_qa` 对图片字体条目有专项检查：碎片数 <2、`parts≥3` 但有效字符 ≤1（碎片没关联完整）、
   译文等于朴素拼接（没按整体语义翻）、译文按框宽估算放不下（会缩到很小）。

**已知误判**（诚实说明）：`icon_1.png`/`icon_2.png` 这类「其实是独立图标」的命名与
「一个词被切开」在外部完全同形，纯几何 + 文件名无法区分。兜底手段：
`hanhua_scan` 会在 `imageFont.sample` 里给出被判为一组的文件名样例供人工确认；
`hanhua_config imageFontGrouping=none`（或 `filename`）可关闭/收窄关联；
QA 会对可疑分组告警；`ocrBudget`/`force` 支持只重跑指定文件。

### 2.4 四道省 token 闸门

| 闸门 | 机制 | 效果 |
| --- | --- | --- |
| 1. 页面/词组两级哈希缓存 | `.hanhua-ocr-cache.json`：页面键 = `sha256(页面内容)+布局+语言`；词组键 = 成员碎片标识拼接 | 重复运行 **0 次调用、0 token**；跨文件的同一个词组只识别一次 |
| 2. 本地 OCR 优先 | 中文/英文常规字直接本地出结果 | 每个区域 **0 token** |
| 3. 裁剪去重 + 先关联后识别 | 同图同框只识别一次（`ocrRegionDedup`）；图片字体**一次 OCR 出一个词组**而不是 N 个碎片 | 既省调用次数，也避免每个碎片各自触发视觉兜底 |
| 4. 视觉预算 | `ocrBudget`（默认 8，`0` = 只用本地）+ 按墨迹量排序优先花预算 | 超预算的区域**不缓存**，下次调用继续；已识别的照旧命中缓存 |

## 3. Token 账本（`hanhua_usage`）

```jsonc
{
  "apiCalls": 1, "apiPromptTokens": 590, "apiCompletionTokens": 290,
  "visionCalls": 1, "visionImages": 2, "visionPromptTokens": 240, "visionCompletionTokens": 24,
  "totalTokens": 1144,
  "saved": {
    "translationCacheHits": 0,   // 命中 .hanhua-cache.json，未调 API
    "contextDedupHits": 3,       // 同原文+同语境复用首条译文
    "skippedNoTranslate": 3,     // 无字母 / 已是中日韩，直接跳过
    "localOcrHits": 4,           // 本地 OCR 成功（0 token）
    "ocrCacheHits": 2,           // 整页命中 OCR 缓存
    "ocrRegionDedup": 0,         // 同图同框去重
    "visionBudgetSkipped": 0     // 因预算未走视觉
  }
}
```

上表是 v2 端到端测试（39 项断言）跑出来的真实数字：**20 个条目里 4 个走本地 OCR、
3 个智能跳过、3 个语境去重，只有真正需要模型的才花 token**。
账本同时写盘 `.hanhua-usage.json`，浏览器面板「汉化工作台」有专门卡片。

## 4. 新增工具与配置

| 工具 | 作用 |
| --- | --- |
| `hanhua_ocr` | 图片/漫画页/艺术字/**图片字体** → 文本条目；`engine`(auto/windows/vision/tesseract)、`layout`(auto/manga/art)、`budget`、`maxImages`、`force` |
| `hanhua_media` | `subs-list`/`subs-extract`/`subs-mux`（ffmpeg）、`epub-unpack`/`epub-pack`/`comic-pack`、`probe`（报告本机能力与建议） |
| `hanhua_usage` | 查看/清零 token 账本与节省项 |

`hanhua_config` 新增：`visionModel`、`visionMaxTokens`、`ocrEngine`、`ocrLang`、`ocrBudget`、
`ocrMaxImages`、`ocrLayout`、`ocrMinArea`、`ocrMaxRegions`、`typesetFont`、
`imageFontGrouping`（auto/filename/none）、`imageFontMinParts`（默认 2）、
`imageFontPhraseGap`（默认 2.5）、`imageFontGap`（默认 2）、`imageFontMaxParts`（默认 8）、
`pythonPath`、`powershellPath`、`ffmpegPath`、`ffprobePath`、`subtitleEncoding`。

`hanhua_scan` 会在返回里多一个 `imageFont` 字段：`{ suspected: true, groups: n, sample: [[...文件名...]] }` ——
发现「一串编号小图」时提示这可能是图片字体，并把被判为一组的样例列出来供确认。

> **顺带修好了 v1 的老问题**：`ctx.web.fetch` 只接受 `url` 且 provider 硬编码 GET，
> POST 主体发不出去，所以 v1 的「在线翻译 API 兜底」实际上是坏的。
> v2 把 API 请求改走 **node 子进程里的 fetch**（`ctx.web.fetch` 仅作最后兜底），
> 在线翻译与视觉 OCR 因此真正可用——e2e 用本地 mock 服务验证了 POST 通路与 token 记账。

## 5. 工程改造：两份 1700 行引擎 → 一份源码 + 生成器

v1 的引擎在两个文件里各存一份（静态插件 `preset/plugins/hanhua/index.js` 与动态包
`engine/host.js`），**已经漂移过**：`iconvPath` 默认值、`resolveRoot`、`parseFiles` 的
`errors`、Marshal 读取修复、`401` 指令处理各只有一半。v2 改成单一真源：

```
engine/src/
  subtitle.js  ebook.js          纯函数库（可直接单测）
  media.js     ocr.js            子系统（子进程、ZIP、HTTP、OCR）
  core.js                        引擎主体（解析/翻译/QA/导出/Marshal/krkr）
  tools.js    rpc.js             工具规格表 + 工作台 RPC（两半共用）
  scripts/*                      mediakit.js / imglib.py / winocr.ps1 / runprobe.js（自动内联）
  static-tail.js dynamic-tail.js 两个信封各自的尾部
        │
        └─ tools/build-engine.mjs ─┬→ engine/host.js                  （动态包）
                                   ├→ preset/plugins/hanhua/index.js  （静态插件）
                                   └→ preset/plugins/hanhua/engine/{host,client}.js
```

* 生成器只做「按信封补缩进 + 剥 `export` 前缀 + 内联 scripts」的机械变换；
* `node tools/build-engine.mjs --check` 校验两个产物与源码一致（已进全量自检）；
* 子进程脚本内联成 `SCRIPT_SOURCES` 常量，运行时落到 `<项目根>/.hanhua-tmp/` 再执行——
  动态包跑在 vm 里、静态插件跑在 host 进程里，都没有稳定的相对路径可用。

## 6. 测试与验证

```powershell
node tests\run-all.mjs        # 11 套全绿（--quick 跳过最慢的端到端）
```

| 套件 | 覆盖 |
| --- | --- |
| `mount-check` / `preset-health` / `build-composition` | 预设组合可挂载、discovery 健康、与随包标准派生一致 |
| `build-check` | 生成物与源码一致；动态包在 vm 里能加载并注册 10 个工具契约 + 13 个 RPC |
| `subtitle.test` | 7 种字幕格式解析/回写、时间轴与 ASS 样式/注释保真、标签占位符 |
| `ebook.test` | container/opf/spine/href/文本节点/实体/回写转义 |
| `mediakit.test` | ZIP 读（中央目录/zip64/编码）、写、replace 保序保持压缩、路径穿越防护、**7z 与 Python zipfile 互操作**、HTTP |
| `imglib.test` | 区域检测/裁剪/排版（擦除三模式、自动字号、溢出）/PDF 文本层与图片抽取 |
| `winocr.test` | 批量 OCR、缩放坐标换算、错误隔离、艺术字实测 |
| `harness` | 真实 0.2.0 内核服务下 scan→parse→translate→qa→export（19/19，含 Shift-JIS 与 UTF-16LE 回写、`.bak` 逐字节比对） |
| `v2-e2e` | **39 项断言**：四类载体扫描分类、SRT/VTT/ASS/EPUB 解析、本地 OCR + 视觉批量兜底 + 缓存命中、mock API 的 POST 通道与 token 记账、字幕/EPUB/漫画/图片回写与备份、QA、账本 |

## 7. 已知限制（诚实清单）

1. **PDF 不回写**：只输出译文对照文本。PDF 重新排版需要重排字库/字形，风险远大于收益。
   PDF 解析也是启发式的：不解析 xref stream / 对象流，字体映射只支持 `ToUnicode`，
   `JPX/CCITT/JBIG2/LZW/Indexed/ICCBased/SMask/内联图像/非 8bpc` 一律跳过并在 `skipped[]` 里报告。
2. **视频内嵌字幕轨需要 ffmpeg/ffprobe**。本机当前没有，因此该路径只有代码与桩验证，
   未在真机上跑过；外挂字幕（.srt/.ass/.vtt…）全流程不受影响。
   `hanhua_media action=probe` 会如实报告本机能力并给出建议。
3. **`.cbr`/`.rar` 漫画包不支持**（RAR 需要外部解包），`.mobi`/`.azw3` 电子书不支持（建议 Calibre）。
4. **本地 OCR 依赖 Windows 语言包**：本机有 `zh-Hans-CN`/`en-US`，**没有日文**。
   日文漫画/假名要靠视觉模型兜底（这正是兜底链存在的原因）。
5. **ZIP 写出不支持 zip64**（>4GB 或 >65535 条目会明确报错而不是写坏包）；
   加密包在建立索引阶段就报错；单条目上限 512MB。
6. **区域检测是启发式的**：气泡密集或网点背景的漫画可能合并/漏检；
   通过 `layout`（manga/art/auto）与 `ocrMinArea`/`ocrMaxRegions` 调参，
   漏检的区域可以用 `files` 单独重跑（`force` 忽略缓存）。
7. **排版不能还原原字体/字形**：译文用系统 CJK 字体绘制，字号自动匹配框；
   艺术字（描边、渐变、变形）只做「擦除 + 重绘」，不做样式复刻。
8. 视觉 OCR 的框坐标来自模型，精度有限；**排版用的是本地检测的框**，
   模型的框只用于把文字和区域对应起来。
9. **图片字体的关联是启发式的**：`icon_1/icon_2` 这种「其实是独立图标」的命名会被误判成一个词组
   （文件名序号与「一个词被切开」在外部同形）；`ocrBudget`/`imageFontGrouping`/`imageFontMaxParts`
   可收窄或关闭关联，QA 会对可疑分组告警。
10. **图片字体的译文只能整句画在一个碎片上**（锚点碎片 / 并集框），其余碎片被擦空；
    如果游戏把每个字都当成独立控件单独定位（例如每个字有自己的对齐/热区），
    整句写进第一张图可能与控件的排版预期不符——这类游戏建议用 `hanhua_config typesetFont`
    指定接近原字形的字体，或只导出译文清单（`hanhua_export typeset=false`）自行排版。
11. 图片字体碎片如果**没有文件名序号、也不在同一张图里**（既不是 sequence 也不是 atlas），
    目前无法关联，会退化为逐个碎片识别并在 QA 里报「碎片未关联」。
