// ═══════════════════════════════════════════════════════════════════════════
// 汉化引擎 · 工具规格表（canonical tools）
//
// 两个信封共用这一份定义：
//   · 静态插件（preset/plugins/hanhua/index.js）→ ctx.tools.register
//   · 动态包（engine/host.js）→ harness.defineTool（仅作为契约参考，不注册到全局表）
// run(args, exec) 返回可 JSON 化的结果；信封负责包 withExec / JSON.stringify。
// ═══════════════════════════════════════════════════════════════════════════

// 模型侧提示词里的工具指南（systemPrompt 片段）。分行书写，运行时 join('\n')。
const GUIDE_LINES = [
  '汉化引擎工具指南（hanhua_*）：',
  '- 支持的汉化载体：① 游戏文本（RPG Maker MV/MZ 的 JSON、RGSS 家族 XP/VX/VX Ace/mkxp-z 的 .rxdata/.rvdata/.rvdata2 Ruby Marshal、krkr/KAG 的 .ks/.tjs/.scn、Ren\'Py，以及通用 JSON/CSV/PO/INI/YAML/TXT）；② 视频字幕（.srt/.vtt/.ass/.ssa/.lrc/.sub/.smi，以及 ffmpeg 可抽取的内嵌字幕轨）；③ 电子书（.epub 全量往返、.html/.xhtml、.pdf 文本层与内嵌图片、.txt）；④ 漫画与图片（.cbz/.zip 图包、图片目录、单图，以及游戏里的图片艺术字）。',
  '- 图文类载体（漫画页 / 图片艺术字 / 扫描件 / 游戏 UI 图）先走 hanhua_ocr：本地 Windows OCR 免费且不耗 token，识别不了（日文假名、描边艺术字）才升级到多模态模型，结果按图像哈希缓存，重复运行零成本。',
  '- 图片字体（游戏把字做成图片、一个词由多张小图拼成，扫描结果里 imageFont.suspected=true）：hanhua_ocr 会**先关联再识别** —— 按文件名序号序列或同一行的碎片分组、拼接成一条、整体识别成一个语义单元，整句翻译后回写到锚点碎片并把其余碎片擦空。不要把这个流程拆成「逐图识别再拼译文」，那样必然不通顺。',
  '- 图片字体的调参：imageFontGrouping（auto/filename/none）、imageFontMinParts（默认 2）、imageFontPhraseGap（默认 2.5）、imageFontGap（默认 6）；扫描结果里的 imageFont.sample 会给出被判为一组的文件名样例，误判时用 imageFontGrouping=none 关闭。',
  '- 标准流程：hanhua_scan 扫描 → hanhua_parse 提取文本（errors 字段列出失败文件）→ hanhua_glossary 维护术语词典（人名/地名/道具名必须统一）→ hanhua_translate 翻译 → hanhua_qa 质检 → hanhua_export 写回。',
  '- 图文载体流程：hanhua_ocr（识别出带坐标的文本条目）→ hanhua_translate → hanhua_export：漫画页/T 图会擦除原文并按框自动排版译文回写图片；字幕与 EPUB 按原文件结构回写。',
  '- 视频字幕：hanhua_media action=subs-extract 从视频抽出字幕轨，翻译后用 action=subs-mux 回封（需要本机有 ffmpeg/ffprobe；没有时直接翻译外挂字幕文件）。',
  '- 词典/术语表优先级最高（完全匹配 > 子串最长优先 > 正则替换），词典未覆盖的文本才会调用在线翻译 API（需先 hanhua_config 配置 apiUrl/apiKey）。',
  '- 导出：mode=inplace 就地替换并自动生成 <file>.bak 备份（推荐）；mode=out 输出到 .hanhua-out/ 镜像目录；RGSS Marshal、krkr、EPUB/CBZ 按原格式原编码回写（ZIP 重打包保留条目顺序与压缩方式）。',
  '- 编码：XP/VX/Ace 游戏多为 GBK/Shift-JIS 字符串，如乱码请用 hanhua_config 设置 rgssEncoding（gbk/shift_jis）；krkr 文本同理设置 krkrEncoding；GBK/Shift-JIS 写回依赖 iconv-lite（桌面版安装会把它放在插件 node_modules 下，无需配置）。',
  '- 铁律：绝不破坏占位符（%s %d {0} \\N[1] \\V[5] \\C[2] <color=...> 等）、ASS 覆写标签（{\\an8} 等）、换行与 JSON/Marshal/EPUB 结构；翻译后用 hanhua_qa 复查。',
  '- 省 token：翻译自动跳过无字母/高中日韩占比条目、按原文+语境去重、按 apiChunk 分批；OCR 本地优先＋哈希缓存＋同图去重；所有工具只返回紧凑预览（≤20 条）与统计。用 hanhua_usage 查看省了多少（缓存命中、本地 OCR 命中、去重条数、API token 用量）。',
  '- 浏览器面板「汉化工作台」：0.1.6-alpha.2 起 cordis 工具已退役，需用 hanhua_workbench action=install 自装动态包，然后到 Cordis 面板点「批准」，面板出现在 设置 →「汉化工作台」；定义随进程存在，重启后重新 install。排错用 action=status。',
]

const TOOL_SPECS = [
  {
    name: 'hanhua_scan',
    description: '扫描汉化项目目录，列出全部可汉化的资源文件：游戏文本（JSON/CSV/TSV/PO/TXT/INI/YAML/RenPy、RPG Maker MV/MZ、RPG Maker XP/VX/VX Ace/mkxp-z 的 .rxdata/.rvdata/.rvdata2、krkr/KAG 的 .ks/.tjs/.scn）、视频字幕（.srt/.vtt/.ass/.ssa/.lrc/.sub/.smi）、电子书（.epub/.pdf/.html/.xhtml）、漫画与图片（.cbz/.zip/.png/.jpg/.webp 等）。返回按类别统计的文件清单；若发现「图片字体」（同目录里一串编号小图，游戏把字做成了图片）会在 imageFont 字段里给出提示。',
    properties: {
      root: { type: 'string', description: '项目根目录，绝对路径或相对当前根目录；缺省用上次配置' },
      kinds: { type: 'array', items: { type: 'string', enum: ['game', 'subtitle', 'ebook', 'image'] }, description: '只扫描指定类别（缺省全部）' },
      limit: { type: 'number', description: '最多返回文件条数，默认 200，上限 2000' },
    },
    required: [],
    run: async (args) => scanRoot(args && args.root, args || {}),
  },
  {
    name: 'hanhua_parse',
    description: '解析扫描到的文本资源，提取全部可翻译字符串：RPG Maker MV/MZ 事件、RGSS 家族地图事件/数据库/System 术语/公共事件、krkr/KAG 文本（自动识别 UTF-16LE/UTF-8/Shift-JIS/GBK）、视频字幕（SRT/VTT/ASS/SSA/LRC，保留时间轴与 ASS 样式）、电子书 EPUB（OPF 脊柱顺序遍历 XHTML 文本节点）。失败的文件会列在 errors 中。返回 perFile（每文件条目数）与最多 20 条紧凑预览，节省上下文 token。',
    properties: {
      files: { type: 'array', items: { type: 'string' }, description: '只解析指定文件（相对路径列表）；缺省解析上次扫描结果' },
      root: { type: 'string', description: '项目根目录覆盖' },
    },
    required: [],
    run: async (args) => parseFiles((args && args.files) || null, args && args.root),
  },
  {
    name: 'hanhua_ocr',
    description: 'OCR 组件：从图片里识别文本（漫画页气泡、图片艺术字、图片字体、游戏 UI 图、扫描件），产出带坐标的文本条目，可直接进入 hanhua_translate/hanhua_export 流程。**图片字体**（游戏用图片代替字体、一个词由多张小图拼成）会先做关联：按文件名序号序列或同一行的碎片分组 → 拼接成一条 → 整体识别 → 得到语义完整的词组（而不是 "New"/"Ga"/"me" 这种碎片），译文才可能通顺。引擎链 auto：Windows 内置 OCR（本地、免费、零 token）→ 多模态视觉模型（识别日文假名、描边艺术字等本地搞不定的内容，按图批量调用）→ tesseract（若本机装了）。省 token：页面/词组两级哈希缓存、同图同框去重、只对「有文字的区域」调用视觉模型、可用 budget 限制本次最多看几张图。',
    properties: {
      files: { type: 'array', items: { type: 'string' }, description: '要 OCR 的图片/漫画页（相对路径）；缺省用上次 hanhua_scan 的图片类结果' },
      root: { type: 'string', description: '项目根目录覆盖' },
      engine: { type: 'string', enum: ['auto', 'windows', 'vision', 'tesseract', 'none'], description: 'OCR 引擎：auto（默认，本地优先）／windows／vision（多模态模型）／tesseract' },
      lang: { type: 'string', description: '语言提示，如 zh-Hans-CN / ja-JP / en-US；缺省 auto（按需回退）' },
      layout: { type: 'string', enum: ['auto', 'manga', 'art', 'auto-detect'], description: '区域检测模式：manga（气泡，默认）/ art（描边艺术字，放宽尺寸）/ auto' },
      maxImages: { type: 'number', description: '本次最多处理的图片数（默认 40）；超出部分留到下次调用，便于分批控制成本' },
      budget: { type: 'number', description: '本次最多调用视觉模型的图片数（默认 8，0 表示只用本地引擎）；本地 OCR 不消耗 token，不受此限' },
      force: { type: 'boolean', description: '忽略 OCR 缓存，强制重新识别' },
    },
    required: [],
    run: async (args, exec) => ocrAction(args || {}, exec),
  },
  {
    name: 'hanhua_translate',
    description: '翻译已解析条目（含 OCR 出来的图文条目）：先查词典/术语表与翻译缓存；词典未覆盖的文本批量调用在线翻译 API（需先 hanhua_config 配置 apiUrl/apiKey）。为节省 token：自动跳过无需翻译的条目（无字母或已含大量中日韩字符）、按原文+语境去重复用译文、按 apiChunk 分批并带语境标签压缩提示词。limit 是每批条数（默认 500，上限 20000）：默认只处理尚未翻译的条目，因此反复调用会一批批推进到全部条目，译文累计保存，最后一次性 hanhua_export。返回值含 progress{processed,pendingBefore,remaining,translatedTotal,entryTotal} 与 usage（本轮 API token 开销）。',
    properties: {
      ids: { type: 'array', items: { type: 'string' }, description: '只翻译指定条目 id（会覆盖这些 id 的旧译文）' },
      limit: { type: 'number', description: '每批最多处理条目数，默认 500，上限 20000' },
      offset: { type: 'number', description: '在待处理队列中跳过前 N 条（一般不需要）' },
      forceApi: { type: 'boolean', description: '跳过词典与缓存，全部走在线 API' },
    },
    required: [],
    run: async (args) => translateEntries(args || {}),
  },
  {
    name: 'hanhua_qa',
    description: '对当前译文做质检：占位符（%s/{0}/\\N[1]/<tag> 等）、字幕时间轴与 ASS 覆写标签、换行数、首尾空格、长度比例、漏译检测，返回问题清单。',
    properties: { ids: { type: 'array', items: { type: 'string' }, description: '只检查指定条目 id' } },
    required: [],
    run: async (args) => qaAction(args || {}),
  },
  {
    name: 'hanhua_glossary',
    description: '管理汉化词典/术语表（action: list/add/remove/reset）。词典优先级最高：完全匹配 > 子串最长优先 > 正则替换，之后才是在线 API。',
    properties: {
      action: { type: 'string', enum: ['list', 'add', 'remove', 'reset'] },
      source: { type: 'string', description: '原文或正则（regex=true 时）' },
      target: { type: 'string', description: '译文' },
      regex: { type: 'boolean', description: 'source 是否按正则解释' },
      note: { type: 'string' },
      index: { type: 'number', description: 'remove 用的列表下标' },
    },
    required: ['action'],
    run: async (args) => glossaryAction(args || {}),
  },
  {
    name: 'hanhua_export',
    description: '把译文写回原载体。文本/字幕/EPUB 就地替换或输出镜像目录；RGSS Marshal、krkr、EPUB/CBZ（ZIP）按原编码原格式回写；漫画页与图片艺术字会把译文擦除原文后按框自动排版回写到图片。mode=inplace 自动备份 <file>.bak（默认且推荐）；mode=out 输出到 .hanhua-out/ 镜像目录。',
    properties: {
      mode: { type: 'string', enum: ['inplace', 'out'], description: 'inplace（默认）或 out' },
      files: { type: 'array', items: { type: 'string' }, description: '只导出指定文件' },
      typeset: { type: 'boolean', description: '图片类条目是否排版回写（默认 true；false 时只输出译文清单 JSON/TXT）' },
      fontPath: { type: 'string', description: '排版用字体文件绝对路径；缺省自动挑可用的中文字体' },
    },
    required: [],
    run: async (args) => exportEntries(args || {}),
  },
  {
    name: 'hanhua_media',
    description: '媒体级操作（不影响 hanhua_* 主流程的文本条目）：action=subs-extract 从视频抽出内嵌字幕轨（ffmpeg/ffprobe）→ .srt；action=subs-mux 把译好的字幕回封进视频；action=subs-list 列出视频里的字幕轨；action=epub-unpack / epub-pack 解包/打包 EPUB（保留条目顺序与 mimetype）；action=probe 报告本机可用的外部能力（ffmpeg/ffprobe/tesseract/python/Pillow/Windows OCR）与建议。',
    properties: {
      action: { type: 'string', enum: ['subs-list', 'subs-extract', 'subs-mux', 'epub-unpack', 'epub-pack', 'comic-pack', 'probe'], description: '要执行的媒体操作' },
      file: { type: 'string', description: '输入文件（视频 / EPUB / 漫画包）' },
      out: { type: 'string', description: '输出文件或目录（相对项目根）' },
      stream: { type: 'number', description: '字幕轨序号（缺省第一轨）' },
    },
    required: ['action'],
    run: async (args) => mediaAction(args || {}),
  },
  {
    name: 'hanhua_usage',
    description: '查看 token/成本账本：本轮与累计的翻译 API 调用数、prompt/completion token、OCR 调用数、以及省下来的量（缓存命中、同图去重、本地 OCR 命中、智能跳过）。用于确认「省 token」是否真的生效。action=reset 可清零。',
    properties: { action: { type: 'string', enum: ['get', 'reset'], description: 'get（默认）或 reset' } },
    required: [],
    run: async (args) => usageAction(args || {}),
  },
  {
    name: 'hanhua_config',
    description: '读取/修改汉化引擎配置：root（项目根目录）、apiUrl（OpenAI 兼容 chat/completions 接口地址）、apiKey、model（翻译模型）、visionModel（图文 OCR 用的多模态模型，如 glm-4v-flash）、targetLang、sourceLang、rgssEncoding（XP/VX/Ace 字符串编码，默认 auto）、krkrEncoding（krkr 文本编码，默认 auto）、iconvPath（iconv-lite 绝对路径）、apiChunk（API 每批条数，默认 40，越大越省提示词开销）、ocrEngine（auto/windows/vision/tesseract）、ocrLang、ocrBudget、typesetFont（排版字体）。get 会遮蔽 apiKey。',
    properties: {
      action: { type: 'string', enum: ['get', 'set'] },
      root: { type: 'string' }, apiUrl: { type: 'string' }, apiKey: { type: 'string' },
      model: { type: 'string' }, visionModel: { type: 'string' },
      targetLang: { type: 'string' }, sourceLang: { type: 'string' },
      rgssEncoding: { type: 'string' }, krkrEncoding: { type: 'string' },
      iconvPath: { type: 'string' }, apiChunk: { type: 'number', description: 'API 每批条数（默认 40，范围 1-100）' },
      ocrEngine: { type: 'string', description: 'auto / windows / vision / tesseract / none' },
      ocrLang: { type: 'string', description: 'OCR 语言提示，如 auto / zh-Hans-CN / ja-JP' },
      ocrBudget: { type: 'number', description: '单次 hanhua_ocr 最多调用视觉模型的图片数（默认 8）' },
      typesetFont: { type: 'string', description: '漫画/艺术字排版字体绝对路径' },
      ffmpegPath: { type: 'string', description: 'ffmpeg 可执行文件路径（缺省自动探测）' },
      imageFontGrouping: { type: 'string', description: '图片字体关联：auto（默认，文件名序号 + 同一行碎片）/ filename（只按文件名序号）/ none（关闭关联，逐碎片识别）' },
      imageFontMinParts: { type: 'number', description: '少于这么多碎片不成组（默认 2）' },
      imageFontPhraseGap: { type: 'number', description: '同一行内间隙超过「该值 × 行高」才断开成另一个词组（默认 2.5）' },
      imageFontGap: { type: 'number', description: '拼接碎片之间的像素间距（默认 6）' },
    },
    required: ['action'],
    run: async (args) => configAction(args || {}),
  },
]
