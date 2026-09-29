# 「汉化模式」预设 · 主机 API 兼容性审计：DSH 0.1.1-rc.2 → 0.1.6-alpha.2

> 任务：`task-1`（主机 API 兼容性审计）　执行者：api-audit　日期：2026-09-29
> 结论口径：**A=新版会硬失败（必须改）／B=行为变化或静默失效（建议改）／C=新旧等价（无需改）**。
> 每条结论都给出**新旧两侧**的 `文件:行号`。行号口径：仓库内文件用 ripgrep/read 工具口径；`.yml` 与 `.ts` 均已逐条复核。

---

## 0. 审计基线与方法

| 代号 | 路径 | 版本 / 标识 |
|---|---|---|
| `[old]` | `D:\Agent-windows\deepseek_harness\.tmp-core-old-0.1.1-rc.2` | `package.json: version = 0.1.1-rc.2` |
| `[new]` | `D:\Agent-windows\DeepSeekHarness\core` | `package.json: version = 0.1.6-alpha.2` |
| `[repo]` | `D:\Games\汉化模式\DSH-hanhua-mode` | 插件 v11 |
| `[prst]` | `[repo]\preset` | 静态预设包（`agent.cordis.yml` + `plugins/hanhua/index.js`） |
| `[inst]` | `D:\Agent-windows\DeepSeekHarness\data\.dsh\.agent-presets\hanhua` | 已安装副本 |

**被审插件（静态预设版 v11）基线**：`[prst]\plugins\hanhua\index.js`
- sha256 `38216A86D7FBA3BA0ED72222AE338074E7AD8A5E7B1D044CB3037155B674E5AA`，83250 字节，1594 行（read 工具口径）。
- 审计开始时 `[prst]\plugins\hanhua\index.js` 与该哈希一致；审计期间该文件被队友修改（见 §6），**原始 v11 完好保存在 `[repo]\.tools\relstage\preset\plugins\hanhua\index.js`（同哈希）**，本报告行号以该基线为准。
- 动态版：`[repo]\engine\host.js`（1594→1639 行，sha 未记录；审计时未被修改）。

**已安装副本一致性**：`[inst]\plugins\hanhua\index.js`、`[inst]\agent.cordis.yml`、`[inst]\preset.yml` 与 `[prst]` 对应文件**逐字节相同**（sha256：插件 `38216A86…`、组合文件 `6EBEDE8E6444D808A47DCE33E15FCF4EED87A7F0BAD4E14F0ABBF22478AEDE27`）。

**方法**：先对两侧关键文件做 SHA-256 逐文件比对定位「哪些文件变了」，再对变化文件做逐行 diff 与定向阅读；对**会决定成败**的两条结论（persona 行配置、`subprocess.spawn` 缺 `cwd`）另外写了最小复现脚本，直接加载 0.1.6 随包的已构建产物执行，实测输出见 §4。

**关于「新版随包标准预设」**：
- 新版标准 = `[new]\packages\preset\agent-presets\presets\standard\agent.cordis.yml`（265 行）。
- `[new]\apps\cli\config\agent-presets\standard\agent.cordis.yml`（251 行）与 `[old]` 同路径文件**哈希完全相同**，确认是**旧副本残留**，不作为新版标准。
- `[prst]\agent.cordis.yml`（257 行）与 `[old]\apps\cli\config\agent-presets\standard\agent.cordis.yml` 的 diff **只有两处**：persona 的 `text` 内容换成汉化文案（`[prst]\agent.cordis.yml:24-28`）、末尾追加 `hanhua-engine` 行（`:256-257`）。即：**本预设的组合文件 = 0.1.1-rc.2 的 standard 预设 + 本地插件行**，因此旧 standard 的每一处过期都在本预设中原样存在。

---

## A 类 · 新版会硬失败（必须改）

| # | 项目 | 旧行为（0.1.1-rc.2） | 新行为（0.1.6-alpha.2） | 证据 file:line | 必须的修改 |
|---|---|---|---|---|---|
| **A1** | 预设 `persona` 行配置字段：`text` → `prefix` | `Config.text: z.string().required()`；行写 `config: { text: … }` 合法，persona 正常注册 | `Config.prefix: z.string().required()` + `suffix?`；`text` 变成**未知键**（被静默合并、不报错），但**缺 `prefix` 触发必填校验** → 该行配置校验抛错 | 旧：`[old] packages/preset/persona/src/index.ts:40`（`text: string`）、`:49`（`text: z.string().required()`）<br>新：`[new] packages/preset/persona/src/index.ts:36`（`prefix: string`）、`:41`（`suffix?`）、`:50-51`（`prefix: z.string().required()` / `suffix: z.string().default('')`）<br>预设：`[prst] agent.cordis.yml:24-28`（`- id: persona` / `name: '@deepseek-ai/dsh-persona'` / `text: >-`）<br>必填语义：`[new] vendor/schemastery/src/index.ts:474-475`（`isNullable(data) && schema.meta.required` → `missing required value`）<br>校验入口：`[new] vendor/cordis/src/fiber.ts:50-62`（`resolveConfig` → 抛 `ValidationError`） | 把 `[prst]\agent.cordis.yml:27` 的 `text: >-` 改为 `prefix: >-`；原正文保持不动。若要还原新版「persona 后缀」语义，可另加 `suffix: Your working directory is {{cwd}}.`（新版标准见 `[new] …presets/standard/agent.cordis.yml:27-29`） |
| **A2** | `ctx.subprocess.spawn(spec)` 未传 `cwd`（插件 4 处调用点全中） | `spawn()` 只校验 `graceMs`/`signal`/`argv`，`cwd` 原样交给 Node 的 `child_process.spawn`，`undefined` → 回落到 `process.cwd()`，**可用** | `spawn()` 同步调用 `targetEnvironment(spec)`，其中 `validateNoNullByte('options.cwd', spec.cwd)` 对 `undefined` 执行 `value.includes('\0')` → **`TypeError: Cannot read properties of undefined (reading 'includes')`**，spawn 直接抛错 | 旧：`[old] packages/subprocess/subprocess-local/src/index.ts:146-147`（`spawn()` 直接 `spawnSubprocess`）、`[old] …/subprocess-local/src/spawn.ts:326-341`（仅校验 graceMs/signal/argv）、`:350-351`（`cwd: spec.cwd`）<br>新：`[new] packages/subprocess/subprocess-local/src/index.ts:179-181`（`validateSubprocessSpec` → `targetEnvironment(spec)`）、`[new] …/subprocess-local/src/runner-launch.ts:300-306`（`targetEnvironment` → `validateNoNullByte('options.cwd', spec.cwd)`）、`:291-293`（`if (value.includes('\0'))`）<br>契约两侧均为必填：`[new] packages/subprocess/subprocess/src/types.ts:77-83`（`cwd: string`）／`[old] 同文件:75-81`<br>新版契约文档：`[new] packages/subprocess/subprocess/src/index.ts:110`（“throws synchronously when … cwd … is invalid”）<br>插件调用：`[prst]\plugins\hanhua\index.js:170`、`:198`；动态版 `[repo]\engine\host.js:178`、`:211` | 4 处 spawn 全部补 `cwd`（绝对路径，建议 `state.root`/会话 cwd；`argv` 已用绝对可执行路径，`cwd` 只影响子进程继承的相对路径解析与 Node 的 `--require` 查找）。**注意**：`preset/plugins/hanhua/index.js` 已由队友修复，但 `engine/host.js:178`、`:211` **仍是原样** |

### A1 的杀伤半径（为什么是「硬失败」而不是「功能降级」）

单行配置校验失败会**整份预设挂载失败**，不是只丢 persona：

1. `EntryGroup.update` 逐行 `create(...).catch(err => ctx.logger.error(err))` —— 单行失败只记日志，不中断其它行：`[new] vendor/loader/src/config/group.ts:56-64`。
2. 该行的 `Entry.fiber` 不会被建立（`registry.plugin(...)` 抛错前 `this.fiber` 尚未赋值）：`[new] vendor/loader/src/config/entry.ts:175-189`（`this.fiber = this.ctx.registry.plugin(plugin, this.options.config, …).ctx.fiber`）。
3. 挂载后的可用性审计把「无 fiber 的启用行」记为 `never started`：`[new] packages/preset/agent-presets/src/mount.ts:303-326`（尤其 `:309-311`）。
4. `mountPreset` 只要拿到非空诊断就抛错并回滚整棵子树：`[new] …/mount.ts:394-397`（`N row(s) did not activate`）、`:406-409`（失败即 `handle.dispose()`）。

旧版同样是「一行坏→整份挂载失败」，只是失败路径不同：旧 loader 的 `EntryGroup.update` 用 `Promise.allSettled` 收集失败并抛出（`[old] vendor/loader/src/config/group.ts:59-103`，关键 `:71,79-80`），最终仍由 `[old] packages/preset/agent-presets/src/mount.ts:283`（同步 `inactiveRows`）、`:291-292`（`never started`）、`:357-359`（抛 `N row(s) did not activate`）收口。**即：字段名一改，预设从「能用」变「完全不能挂载」。**

---

## B 类 · 行为变化 / 静默失效（应该改）

| # | 项目 | 旧行为（0.1.1-rc.2） | 新行为（0.1.6-alpha.2） | 证据 file:line | 必须的修改 |
|---|---|---|---|---|---|
| **B1** | `ctx.systemPrompt.section` 的 `order` 语义区间整体上移：插件的 `order: 115` 掉到「persona 之后、所有第一方指南之前」 | 文档约定 `-100`=harness identity、`0`=deployment persona、**工具指南用 100–199**；同代工具段：`tool-goal=114`、`tool-ralph=116` → 插件 115 与工具指南相邻 | 改为**中央分配的命名档位**：`HARNESS_IDENTITY=-1000`、`DEPLOYMENT_PERSONA_PREFIX=0`、`PLAN_POLICY=500`、`TEAM_POLICY=600`、`TOOL_*`=1000–3100、`TOOLS_SDK=5000`、`DEPLOYMENT_PERSONA_SUFFIX=10200`。`order: 115` 仍合法（只校验 `Number.isFinite`），但渲染位置**提前到 plan 策略与全部工具指南之前** | 旧：`[old] packages/core/system-prompt/src/index.ts:56-60`（order 约定注释）、`:128`（`PERSONA_SECTION`）、`:131`（`PERSONA_ORDER = 0`）、`:381-390`（`section()` 仅校验有限数）<br>新：`[new] packages/core/system-prompt/src/index.ts:125-160`（`SECTION_ORDERS`，含 `:145 TOOL_GOAL: 2400`、`:147 TOOL_RALPH: 2700`）、`:471-473`（`getSectionOrder`）、`:455-464`（`section()` 仍只校验有限数）<br>插件：`[prst]\plugins\hanhua\index.js:1589-1592`（`name:'tool:hanhua'` / `order: 115`） | 把 `order` 移到新版未被占用的工具档位区间（`TOOL_COMPUTER_USE=3000` 与 `MCP_SERVERS=3100` 之间，或 `3101–4999`），例如 `order: 3200`。**不要**用 `getSectionOrder('TOOL_GOAL')` 之类的第一方档位去挤位（同名/同序会退化为按 name 排序，见 `[new] …:238-240` `comparePromptSections`） |
| **B2** | `ctx.sandboxPolicy.resolve({session})` 的 `workspaceRoot` 不再做「解析+规范化」 | `resolveWorkspaceRoot(path) = resolvePath(canonicalPath(path))` —— 任何输入都被规范化成绝对路径（相对路径/空串也不会抛） | `resolveWorkspaceRoot(path)` **先 `isAbsolute` 断言**，不满足即抛 `sandbox-policy: workspace root must be an absolute execution-world path`；且不再解析符号链接、保留执行世界拼写 | 旧：`[old] packages/sandbox/sandbox-policy/src/index.ts:39-43`、`resolve()` `:135-142`<br>新：`[new] packages/sandbox/sandbox-policy/src/index.ts:40-45`（`isAbsolute` 断言）、`resolve()` `:164-171`<br>插件容错点：`[prst]\plugins\hanhua\index.js:110-113`（`try { policy = ctx.sandboxPolicy.resolve({session}) } catch { policy = undefined }`）→ 写入退化为 `policy=undefined`，由 `[new] packages/fs/fs-sandbox/src/index.ts:122-127` 回落 `this.ctx.sandboxPolicy.resolve()`（**工作区根从「会话 cwd」漂移为「部署默认根」**） | 建议保留 try/catch 但**记录日志**（至少 `console.error`/返回值带 warning），便于定位「写盘被沙箱拒绝」的真因；若确定只传 `{session}`，此条实际风险低（`SessionHeader.cwd` 由 `[new] packages/core/session/src/index.ts:111-116` 保证为绝对路径） |
| **B3** | `sandboxPolicy` 的会话覆盖值来源：直接扫事件 → 读会话投影 | `overrideOf(session) = effectiveSandboxMode(session.events)` | `overrideOf(session) = this.ctx.sessionProjections.stateOf(session,'sandboxMode')`；服务新增 `static inject = ['sessionProjections']`，并在构造时注册 `sandboxMode` 投影 | 旧：`[old] packages/sandbox/sandbox-policy/src/index.ts:149-151`<br>新：`[new] packages/sandbox/sandbox-policy/src/index.ts:178-180`、`static inject` `:89`、注册 `:133-139`<br>未注册键返回 `undefined` 不抛：`[new] packages/session/session-projection/src/index.ts:319-327` | 预设**无需改**。但这是**宿主前置条件**：宿主平面必须挂载 `sessionProjections`，否则 `sandboxPolicy` 服务自身加载不了，进而预设在 `inject:['sandboxPolicy']` 上永久等待 → `inactiveRows` 报 `waiting for …` → 整份挂载失败（`[new] …/mount.ts:320-323,394-397`） |
| **B4** | `ctx.web.fetch` 的目标地址校验：新版新增「非公网 IP 直接拒绝」 | 无地址校验，任意 http(s) URL 都会真正发起请求（SSRF 面大） | `HttpFetchProvider` 解析并**钉扎**地址，命中私网/回环即抛 `WebError(..., 'WEB_BLOCKED_URL')` | 旧：`[old] packages/web/web-fetch-http/src/provider.ts:105-108`（无校验，直接 `fetch`）<br>新：`[new] packages/web/web-fetch-http/src/network.ts:80-109`（`:100-102` 抛 `WEB_BLOCKED_URL`）、`[new] packages/web/web-fetch-http/src/index.ts` 去掉 `maxUrlLength` | 若 `hanhua_config` 的 `apiUrl` 指向本地/内网 LLM（`http://127.0.0.1:...`、局域网中转），新版会直接失败；需改用公网地址，或改为不经 `ctx.web` 的通道（见 C4 说明）。纯公网 API（api.openai.com 等）不受影响 |
| **B5** | 工具呈现模式枚举 `'code'` → `'ptc'` | `ToolPresentationMode = 'native' \| 'code' \| 'both'`；tools 配置 `mode` 联合含 `'code'` | `ToolPresentationMode = 'native' \| 'ptc' \| 'both'`；配置联合含 `'ptc'`；`ctx.codeRuntime` → `ctx.ptcRuntime` | 旧：`[old] packages/core/tools/src/index.ts:651`、`:790-791`（Config 联合）<br>新：`[new] packages/core/tools/src/index.ts:653`、`:792-793`；运行时改名 `:1025-1032`（`requirePtcRuntime`，错误文案指向 `dsh-ptc-runtime-node`） | 预设自身不设 tools 行，**无需改**。但**任何把 `mode: 'code'` 写进 tools 配置的组合文件/宿主配置在新版会加载即报错**；若项目其它配置文件（profile、`base.cordis.yml` 等）有此写法需一并改 `'ptc'`。默认仍是 `'native'`（`[new] …:793`），不改则不受影响 |
| **B6** | 预设组合文件相对新版随包 standard 的**行级差异**（哪些是新版要求、哪些只是可选功能） | 见下表 | 见下表 | 见下表 | 见下表 |

### B6 明细：`[prst]\agent.cordis.yml` vs `[new] …presets/standard/agent.cordis.yml`

| 差异项 | 本预设（旧 standard 派生） | 新版 standard | 判定 | 证据 |
|---|---|---|---|---|
| persona 字段 | `text:`（`:24-28`） | `prefix:` + `suffix:`（`:24-29`） | **A1，必须改** | 见 A1 |
| `workflow-worker-thread` | `:222-226` `@deepseek-ai/dsh-workflow-worker-thread` (provider: spawn) | `:222-225` `@deepseek-ai/dsh-workflow-ptc` | **可选**（见下注） | `[new] packages/preset/agent-presets/presets/standard/agent.cordis.yml:222-225` |
| `tool-ralph` | `:230-234` 启用，`subagentProvider: spawn` / `maxRounds: 64` | `:236-238` `disabled: true` + 同 config | 可选（新版默认关闭该工具） | 同上 `:236-238`；Config 未变（`maxRounds` 等仍存在） |
| `tool-web` | `:248-252` `fetch: false` | `:255-258` `fetch: true` | 可选，且**不影响本插件**：`fetch` 只决定「模型可见的 `web_fetch` 工具」是否注册，`ctx.web` 服务与 provider 由宿主平面提供 | `[new] packages/web/tool-web/src/index.ts:40-41`（Config 注释）、`:54-62`（schema）、`:91-94`（`if (resolved.fetch) applyWebFetchTool(...)`）；该文件与 `[old]` **哈希相同** |
| `command-goal` | 无 | `:95-96` `@deepseek-ai/dsh-command-goal` | 可选（新版把 `/goal` 人工命令放进预设层） | `[new] …standard/agent.cordis.yml:95-96` |
| `present` | 无 | `:261-262` `@deepseek-ai/dsh-tool-present` | 可选（0.1.6 新增包，`[old]` 无此包） | `[new] …:261-262`；包名清单比对：`@deepseek-ai/dsh-tool-present` 仅新侧存在 |
| `tool-plugin-manager` | 无 | `:264-266` `@deepseek-ai/dsh-plugin-manager/tools` + `disabled: true` | 可选 | `[new] …:264-266` |
| `tool-subagent` | `provider/toolName/backgroundMode` | 额外 `modelSelectionSettings: true`（`:186`） | 可选（旧写法仍合法：新增键有默认值 `false`） | `[new] packages/subagent/tool-subagent/src/index.ts:106-111`（`modelSelectionSettings: z.boolean().default(false)`）；旧同文件 `:81-85` |
| plan-mode 提示正文 | `:113-124` | 同文本，未变 | 无需改 | 版本比对：`section` 文本块在两版随包 standard 中逐字相同 |
| 其余所有行（`agent-instructions`/`tool-fs`/`tool-fs-search`/`tool-jobs`/`skill-filesystem`/`tool-skill`/`tool-goal`/`compaction*`/`command-compact`/`tool-result-pruner`/`tool-subagent-control`/`tool-subagent`/`tool-workflow`/`tool-ask-user`/`tool-todo`） | — | 行名与已写配置键均未变 | 无需改 | 逐个包 `Config`/`inject` 比对，见 §3 |

> `workflow-worker-thread` 的注：该包源码在两侧**逐字节相同**（`packages/workflow/workflow-worker-thread/src` 全文件 SAME-ALL），其 `package.json` 版本仍是 `0.1.1-rc.2`（未随内核升级），说明它未被 0.1.6 改动。换成 `workflow-ptc` 是产品级现代化（`workflow-ptc` 依赖新版 `ptcRuntime`：`[new] packages/workflow/workflow-ptc/src/index.ts:103,117`）。**是否仍随 1.0.5 打包 → 未确认**，见 §5。

---

## C 类 · 新旧等价（无需改）

| # | 项目 | 结论 | 证据 file:line（旧 / 新） |
|---|---|---|---|
| **C1** | 插件模块契约：`export const name` / `export const inject` / `export function apply` | **等价**。cordis 仍接受「带 `apply` 的对象插件」，`name`/`inject`/`Config` 元数据读取路径未变；`unwrapExports` 逐字相同 | 插件：`[prst]\plugins\hanhua\index.js:8,9,11`<br>`[old]`=`[new]` `vendor/cordis/src/registry.ts`（哈希相同；`:100-111` Plugin.Base、`:130-133` Plugin.Object、`:316-330` `plugin()`）<br>`[old] vendor/loader/src/index.ts:191-199` / `[new] vendor/loader/src/index.ts:188-196`（`unwrapExports` 逐字相同） |
| **C2** | 预设本地行 `name: ./plugins/hanhua/index.js` 的解析与加载 | **等价**：两版都把 `.` 前缀归为「预设自带文件」，并以**组合文件所在目录**为 baseUrl；新版只是把判定抽到 `specifier.ts`（旧版无此文件） | 旧：`[old] packages/preset/agent-presets/src/mount.ts:81-92`（`name.startsWith('.')` → `super.import(name)`）<br>新：`[new] packages/preset/agent-presets/src/specifier.ts:43-49`（`.` → `kind:'preset'`）、`[new] …/mount.ts:93-104`<br>预设行：`[prst]\agent.cordis.yml:256-257`<br>新版 discovery 新增「行可解析」健康检查：`[new] …/discovery.ts:172-193`（`unresolvableRows`，`disabled` 为真即跳过）、`:112-121`（`packageInstalled`）、`:134-149`（`rowResolves`）、`:206-246`（`compositionProblem`，`:231` 用组合目录作 presetBase）、`:282-315`（`scanRoot`）；本插件行解析到已存在的 `[inst]\plugins\hanhua\index.js` → **通过**（`disabled` 为 `!!js` 表达式的行也被跳过，因为表达式对象 truthy） |
| **C3** | `inject` 的 6 个服务名是否仍存在 | **6/6 存在**，且新版随包 standard 自身的行也在预设平面注入其中多数服务 | 服务注册名：`tools` `[old] packages/core/tools/src/index.ts:827` / `[new] …:829`；`systemPrompt` `[old] packages/core/system-prompt/src/index.ts:354` / `[new] …:423`；`fs` `[old]`=`[new] packages/fs/fs/src/index.ts:88`；`web` `[old]`=`[new] packages/web/web/src/index.ts:91`；`sandboxPolicy` `[old] packages/sandbox/sandbox-policy/src/index.ts:105` / `[new] …:126`；`subprocess` `[old] packages/subprocess/subprocess/src/index.ts:104` / `[new] …:119`<br>预设平面可注入的实证：`[new] packages/fs/tool-fs/src/index.ts` `inject=['tools','fs','systemPrompt']`；`[new] packages/fs/tool-fs-search/src/index.ts` `inject=['tools','systemPrompt','subprocess']`；`[new] packages/web/tool-web/src/index.ts:24` `inject=['tools','web','systemPrompt']`；`[new] packages/workflow/workflow-ptc/src/index.ts:103` `inject` 含 `sandboxPolicy` |
| **C4** | `ctx.tools.register` 的字段与校验 | **等价**。`output { schema, render, presentationMeta? }` 结构（含「`presentationMeta` 若出现必须是函数」这条检查，**旧版已有**）、`assertSupportedJsonSchema(output.schema)`、`render(exec.arguments, value)` 调用方式、工具名/描述无格式校验 —— 全部未变；返回的都是精确 disposer | 旧：`[old] packages/core/tools/src/index.ts:212-220`（`ToolOutputDefinition`）、`:1037-1044`（`register` 校验，`:1042` 即 presentationMeta 检查）、`:1045`（`assertSupportedJsonSchema`）、`:1057-1061`（返回 disposer）、`:1800`（`render` 调用）<br>新：`[new] packages/core/tools/src/index.ts:205-213`、`:1043-1050`（`:1048` 同样的 presentationMeta 检查）、`:1051`、`:1063-1067`、`:1809`<br>插件注册：`[prst]\plugins\hanhua\index.js:1560-1567`（`output: { schema: {type:'string'}, render }`、`execute: async (args, exec) => …`）<br>实测 `{type:'string'}` 被接受、`{type:'json'}` 若直接走 `register` 会被拒（但动态版走 DSL 会编译成 `{}`，见 §4 说明） |
| **C5** | `execute` 第二参数 `exec`：`exec.agent.session.header.cwd` | **等价**：`ToolRunContext → ToolExecution → ToolExecutionInput.agent?: Agent`，`Agent.session: Session`，`Session.header: SessionHeader`，`SessionHeader.cwd?: string` 全部仍在 | 旧：`[old] packages/core/tools/src/index.ts:314-325`（`ToolExecutionInput`）、`:379`、`:404`；`[old] packages/core/agent/src/runtime-types.ts:64-76`（`Agent.session`）；`[old] packages/core/session/src/index.ts:443`（`Session.header`）；`[old] packages/core/session/src/types.ts:73`（`cwd?`）<br>新：`[new] packages/core/tools/src/index.ts:309-322`、`:376`、`:401`；`[new] packages/core/agent/src/runtime-types.ts:163-174`（`Agent` 声明合并，`session` 在 `:168`）；`[new] packages/core/session/src/index.ts:464`；`[new] packages/core/session/src/types.ts:104`<br>插件：`[prst]\plugins\hanhua\index.js:16-21` |
| **C6** | `systemPrompt.section` 的 `name`/`text` 契约与会话作用域 | **等价**：`{name, order, text}` 三字段、`text` 支持字符串或函数、作用域内 shadow 全局、重复注册抛错的语义未变；新增可选的 `interpolate?: boolean`（本插件未用，且其片段文本不含 `{{var}}`，不受严格插值影响） | 旧：`[old] packages/core/system-prompt/src/index.ts:381-390`<br>新：`[new] packages/core/system-prompt/src/index.ts:455-464`（`section()`）、`:64-66`（新增 `interpolate?`）、`:272-278`（`renderPrompt` 对 `interpolate:false` 跳过插值）、`:596`（`sectionDefinitions` 排序）<br>`order` 数值语义差异见 B1 |
| **C7** | `fs` 服务：`resolve` / `processPath` / `readText` / `writeText(5 个位置参数)` / `listDir` / `stat` / `readBytes` 及返回结构 | **全部等价**。`writeText(target, content, expected?, signal?, sandboxPolicy?)` 逐字相同；`FsTarget`/`FsInfo`/`FsDirEntry`/`FsWriteIntent`/`FsWriteOutcome` 所在文件两侧哈希相同；写实现未变 | 旧：`[old] packages/fs/fs/src/index.ts:116`（resolve）、`:126`（processPath）、`:152`（stat）、`:176`（readText）、`:199`（readBytes）、`:208`（listDir）、`:222-228`（writeText）<br>新：`[new] packages/fs/fs/src/index.ts:116`、`:126`、`:165`、`:189`、`:212`、`:236`、`:250-256`<br>类型：`[old]`=`[new] packages/fs/fs/src/types.ts`（哈希相同；`FsTarget :60-68`、`FsInfo :76-83`、`FsDirEntry :104-115`、`FsWriteOutcome :128+`）<br>新增抽象 `readByteRange`（`[new] …:227`）只影响自研 FileSystem 实现，本插件不实现<br>沙箱写路径：`[old]`=`[new] packages/fs/fs-sandbox/src/index.ts:122-127`；`[new] packages/fs/fs-local/src/fsio.ts:588`（`writeFileAtomic` 未改）<br>插件：`[prst]\plugins\hanhua\index.js:105,108,114,120,130,150,175-176,182-183` |
| **C8** | `ctx.subprocess.resolveExecutable` | **等价**：`(command, env?, signal?)` 与候选解析/PATHEXT 逻辑相同；新版只是把「找不到」换成 `SubprocessExecutableNotFoundError`（插件 `.catch(() => 'node')` 不区分类型） | 旧：`[old] packages/subprocess/subprocess-local/src/index.ts:110-135`、`:137-144`（`executableCandidates`）<br>新：`[new] packages/subprocess/subprocess-local/src/index.ts:137-168`、`:170-177`；新错误类 `[new] packages/subprocess/subprocess/src/index.ts:168-176`<br>插件：`[prst]\plugins\hanhua\index.js:169,190` |
| **C9** | `ctx.subprocess` handle 字段：`done` / `done.exitCode` | **等价**：`SubprocessOutcome { exitCode, signal }` 未变，`done` 语义仍是「进程退出事实」（新版放宽为也可能因 provider 失败 reject，插件用 `await handle.done` 无差异） | 旧：`[old] packages/subprocess/subprocess/src/types.ts:113-118`（`SubprocessOutcome`）<br>新：`[new] packages/subprocess/subprocess/src/types.ts:116-121`<br>⚠ 新版移除了 `SubprocessHandle.pid`（旧 `:75`，新无）——本插件**未使用** `pid`，故不构成失败<br>插件：`[prst]\plugins\hanhua\index.js:171-172,199-200` |
| **C10** | `ctx.effect` 语义（仍须返回 disposer） | **等价**：`Context.effect` 所在文件两侧哈希相同；`Fiber.effect` 的接受形态（函数/迭代器/Promise/空）与 disposer 收集逻辑未变；`tools.register()` 返回的仍是「精确 disposer」 | `[old]`=`[new] vendor/cordis/src/context.ts`（哈希相同）<br>`[old]`=`[new] vendor/cordis/src/fiber.ts:356-399`（`_execute`）、`:402-441`（`effect`）；新版该文件仅在 `update()` 返回值处不同（`[new] …:730-745`）<br>`tools.register` 返回 disposer：`[new] packages/core/tools/src/index.ts:1063-1067`；`[old] …:1057-1061`<br>插件：`[prst]\plugins\hanhua\index.js:1561`、`:1589` |
| **C11** | `ctx.web.fetch` 的请求/返回结构 | **等价**（且两侧都只支持 `url`）：`WebFetchRequest` 只有 `url`，**没有 `method`/`headers`/`body`**；`WebFetchResult = { url, statusCode, body:{kind:'html'\|'text', content}, truncated }`；provider 硬编码 `GET` 并自带 headers；`web/web/src` 三个文件两侧哈希完全相同 | `[old]`=`[new] packages/web/web/src/types.ts:64-66`（`WebFetchRequest`）、`:74-96`（`WebFetchResult`/`WebFetchBody`）；`[old]`=`[new] packages/web/web/src/index.ts:157-162`（`fetch()`）<br>provider 硬编码 GET：`[old] packages/web/web-fetch-http/src/provider.ts:105-108`（`method:'GET'` + 自带 `headers`）、`[new] packages/web/web-fetch-http/src/network.ts:206`（`method: 'GET'`）<br>插件：`[prst]\plugins\hanhua\index.js:1132-1137`（传 `method/headers/body`）→ **额外字段被丢弃**；`:1138-1146`（读 `res.body.content` / `res.statusCode`） |
| **C12** | 插件能否被 discovery 判定为「健康」 | **等价/通过**：新版 discovery 新增了对每个启用行的可解析性检查，本预设全部行为「内置 / 已装包 / 预设自带文件」三类，均可解析（22 个 `@deepseek-ai/dsh-*` 行名在两版包清单中都存在；本地行解析到已装文件） | `[new] packages/preset/agent-presets/src/discovery.ts:112-121`（`packageInstalled`）、`:134-149`（`rowResolves`）、`:172-193`（`unresolvableRows`）、`:206-246`（`compositionProblem`）、`:282-315`（`scanRoot`）<br>包名双向核对：本预设 22 个行名在 `[old]`、`[new]` 包清单中均为 yes（`@deepseek-ai/dsh-tool-present` 等新包不在本预设中，不影响） |

### C11 的重要补充：在线翻译兜底路径「新旧都不成立」

插件的 `translateWithApi`（`[prst]\plugins\hanhua\index.js:1128-1153`）用 `ctx.web.fetch` 发 **POST + Authorization + JSON body** 调 OpenAI 兼容 `chat/completions`。但：

- `WebFetchRequest` 两侧都只有 `url`（`[old]`=`[new] packages/web/web/src/types.ts:64-66`）；
- provider 两侧都硬编码 `GET`（`[old] …/provider.ts:105-108`；`[new] …/network.ts:206`），并自带 `user-agent`/`accept`，不转发调用方 headers；
- 于是请求会以 GET 打到 `chat/completions`，典型返回 404/405，插件在 `:1145-1146` 判定 `statusCode >= 400` 并抛 `API HTTP 4xx`。

**这不是 0.1.6 引入的回归（C 类等价），但它是必须修的功能缺陷**：若预设要保留在线 API 兜底，需要换通道。可选方案（需另立任务验证）：
1. 复用已有的 `ctx.subprocess` 路径起 node 发 HTTP（本插件已有 node 子进程基础设施，注意同时满足 A2 的 `cwd` 要求）；
2. 走宿主 LLM 服务（若预设平面可取到）；
3. 让「在线兜底」不再是预设能力，改为由人手动在外部完成。

---

## 3. 逐项核对结论（对应 task-1 的 1–9 条要求）

| 要求 | 结论 |
|---|---|
| 1. 插件模块契约 / 本地行解析 / `export name/inject/apply` / inject 服务名 | **C1+C2+C3**：全部等价。`./plugins/hanhua/index.js` 仍归 `'preset'` 类并以组合目录为 base 加载；`{apply}` 对象插件仍被接受；6 个 inject 服务名两版都在 |
| 2. `ctx.tools.register` 字段与校验 / JsonSchemaNode 子集 / 工具名与描述限制 / `exec` 字段 | **C4+C5**：等价。`output.schema/render` 必填、`presentationMeta` 可选且「若给必须是函数」（该检查旧版已有）；JSON Schema 子集未变（`json-schema.ts` 仅 import 路径变化）；工具名/描述无格式校验；`exec.agent.session.header.cwd` 仍在 |
| 3. `systemPrompt.section` 的 name/order/text 契约与会话作用域 | **C6（契约等价）+ B1（order 语义区间变化）**。section 仍注册成功，但渲染位置从「工具指南带（100–199）」跳到「persona 之后、所有第一方指南之前」 |
| 4. `fs` 服务各方法签名与返回结构 | **C7**：`writeText` 5 位置参数逐字相同；`Fs*` 类型文件哈希相同；新增 `readByteRange`/`processPathFromHostPath` 为**新增**成员，不破坏消费方 |
| 5. `sandboxPolicy.resolve({session})` 入参与返回 | **等价**（`:164-171` vs `:135-142`，字段一致）→ 归 C；**B2/B3** 只涉及其内部实现变化与宿主前置条件 |
| 6. `subprocess.spawn(spec)` 与 `resolveExecutable`（graceMs / stdio / handle） | **A2（spawn 缺 `cwd` 硬失败）**；`graceMs` 语义与取值域未变（`MAX_TIMER_DELAY_MS` 上限）；`stdio` 取值域 `'pipe'\|'inherit'\|collect` 未变（注意 `stdin:'inherit'` 两版都非法、都被静默映射为 `'pipe'`，见 §4 备注）；`handle.done/exitCode` 等价（C9）；新版**删除 `handle.pid`**（本插件未用）；`resolveExecutable` 等价（C8） |
| 7. `ctx.web.fetch` 的 `WebFetchRequest/Result` | **C11**：两侧都只有 `url`，**不支持 POST/headers/body**；返回为 `{url,statusCode,body:{kind,content},truncated}`。插件的 POST 用法两版都不成立 → §C11 补充是**必修功能项**；另新版 provider 新增非公网地址拦截（**B4**） |
| 8. `ctx.effect` 语义 | **C10**：仍需返回 disposer，语义未变 |
| 9. 预设组合文件 vs 新版随包 standard | 见 **B6** 表：必须改 1 项（persona，A1）；其余为可选对齐（workflow-ptc、ralph disabled、web fetch、command-goal、present、plugin-manager、modelSelectionSettings） |

---

## 4. 实测复现（可复跑）

以下三个脚本位于 `%TEMP%\dsh-OB7ly5\`（本次会话临时目录），只读取 0.1.6 随包的**已构建产物**，不改任何仓库文件。

1. `probe-persona-config.mjs` —— 用 `[new] vendor/schemastery/lib/index.mjs` 构造新版 persona 的 Config，验证旧行配置：
   ```
   old row -> NEW persona schema: ISSUES -> [{"message":"$.prefix missing required value","path":["prefix"]}]
   old row -> OLD persona schema: OK -> {"text":"…","complete":false,"includeRuntimeContext":true}
   new row -> NEW persona schema: OK -> {"prefix":"…","suffix":"","complete":false,"includeRuntimeContext":true}
   ```
   → 证据链：**缺 `prefix` 报错，`text` 是被忽略的未知键**（`vendor/schemastery/src/index.ts:752-763` 非 strict 对象会合并未知键，`:474-475` 才抛必填缺失）。

2. `probe-subprocess-cwd.mjs` —— 直接 import `[new] packages/subprocess/subprocess-local/lib/runner-launch-*.js` 的 `targetEnvironment`：
   ```
   spawn spec WITHOUT cwd (plugin behavior): THREW TypeError: Cannot read properties of undefined (reading 'includes')
   spawn spec WITH cwd: OK (env keys=64)
   ```
   → 与 `[new] …/runner-launch.ts:291-293,306` 一致；旧版对应路径（`[old] …/spawn.ts:326-361`）无此校验。

3. `probe-output-schema.mjs` —— `[new] packages/core/tools/lib/index.js` 的 `assertSupportedJsonSchema`：
   ```
   {type:"json"}  (dynamic host.js output.schema): REJECTED -> JsonSchemaError: … must be one of object/array/string/number/integer/boolean/null
   {type:"string"} (static preset output.schema): ACCEPTED
   {} (annotation-only): ACCEPTED
   ```
   **注意别误读**：动态版 `engine/host.js:1565` 的 `{type:'json'}` 走的是 `harness.defineTool` → `defineTool` → `valueSchemaSpecToJsonSchema`（`[new] packages/core/tools/src/schema.ts:432-442`，作者侧 `json` 节点编译成「仅注解 schema」），因此**动态版是安全的**（新旧一致）。真正危险的是：**静态版若把 `output.schema` 改成 `{type:'json'}` 会直接在 `register()` 被拒**（`[new] …/index.ts:1051` 直接 `assertSupportedJsonSchema(output.schema)`，不经 DSL 编译）。当前静态版用 `{type:'string'}`（`[prst]\plugins\hanhua\index.js:1560`）→ 通过。

> 备注（C 类小瑕疵，两版一致，非本次回归）：插件 4 处 spawn 都写 `stdio: { stdin: 'inherit', … }`，但 `SubprocessStdinMode = 'ignore' | 'pipe' | {data}`（`[old]`=`[new] packages/subprocess/subprocess/src/types.ts:36`），`'inherit'` 非法；实现只把 `'ignore'` 映射为 `'ignore'`，其余一律 `'pipe'`（`[new] …/spawn.ts:452-456`、`[old] …/spawn.ts:353-357`）→ 实际是 `stdin:'pipe'`。行为两版相同，可顺手改成 `'ignore'` 以消除类型谎言。

---

## 5. 未确认项与验证方法

| # | 未确认项 | 为什么无法从现有证据确认 | 建议验证方法 |
|---|---|---|---|
| U1 | `@deepseek-ai/dsh-workflow-worker-thread` 是否仍被 1.0.5 随包分发 | `[new]` 源码树中该包仍在且逐字节未变（`packages/workflow/workflow-worker-thread/src` 全文件 SAME-ALL），但其 `package.json` 版本仍是 `0.1.1-rc.2`（未随内核升级）；新版 standard 已改用 `workflow-ptc` | 在 1.0.5 安装目录/profile 的 `node_modules/@deepseek-ai/` 下查该目录是否存在；或挂载预设后看 `mountPreset` 诊断里是否出现该行 `never started`（`[new] …/mount.ts:310`） |
| U2 | 桌面宿主平面是否挂载 `web` 服务 + fetch provider | `[new]` 仓库不含 `base.cordis.yml`/`web.cordis.yml`（由封装/构建期组装），本次只审计 core 源码 | 在会话里执行 `hanhua_config`（设 apiUrl/apiKey）后调 `hanhua_translate --forceApi`，看错误是 `WebError` 还是「服务不可用」；或查宿主组合文件里是否有 `@deepseek-ai/dsh-web-fetch-http` 行 |
| U3 | 桌面宿主平面是否挂载 `sessionProjections` | 同上（宿主组合不在仓库内）；但新版多行 `inject` 已把它列为必需，缺失会导致整份预设挂载失败 | 直接用「汉化模式」开一个会话：能开起来即说明该服务在；开不起来看诊断里的 `waiting for sessionProjections`（`[new] …/mount.ts:320-323`） |
| U4 | 新版 discovery 的健康检查在本机实际把该预设判为 healthy 还是 broken | 需要真实宿主 baseUrl 与已装包树才能跑 | 在 GUI 的预设选择器里看「汉化模式」是否可选/是否有 broken 标记；或用 `[new] packages/preset/agent-presets` 的 `discoverPresets` 配真实 roots 跑一次 |
| U5 | `persona` 修复后 persona 的最终渲染位置/内容 | 新版把 persona 拆成 `prefix`(order 0) + `suffix`(order 10200)，并把 suffix 放在所有指南之后 | 修复后在一个会话里读系统提示首个与末个 section，确认汉化文案完整出现 |

---

## 6. 插件 + 预设「最小改动清单」

按「必须 → 建议」排序。**注意 §6.1 是唯一能让预设从「挂不上」变「挂得上」的两条**。

### 6.1 必须改（A 类）
1. **`[prst]\agent.cordis.yml:27`（即 `D:\Games\汉化模式\DSH-hanhua-mode\preset\agent.cordis.yml`）**：`text: >-` → `prefix: >-`（正文不动）。可选加 `suffix: Your working directory is {{cwd}}.`（与新版 standard 对齐）。**同步更新 `[inst]\agent.cordis.yml`（与仓库副本逐字节相同，必须一起改，否则运行时用到的仍是旧的）。**
2. **`ctx.subprocess.spawn` 4 处补 `cwd`**：
   - 静态版 `[prst]\plugins\hanhua\index.js:170`、`:198` —— **工作树已由队友修复**（现 `preset\plugins\hanhua\index.js:168-178`、`:203-206` 引入 `spawnCwd()` 并传入 `cwd`）；
   - 动态版 `[repo]\engine\host.js:178`、`:211` —— **仍是原样，未修**，需同样补 `cwd`（可用 `state.root`）。

### 6.2 建议改（B 类）
3. `[prst]\plugins\hanhua\index.js:1591`：`order: 115` → 移入新版空档（如 `3200`），避免提示片段跑到 persona 之后、所有第一方指南之前（B1）。若改了，注意 `engine/host.js` 无 systemPrompt 片段，无需同步。
4. `preset/plugins/hanhua/index.js:110-113`（动态版 `engine/host.js:21-32`）：把 `sandboxPolicy.resolve` 的 `catch` 从「静默吞掉」改为「记日志/返回告警」，避免工作区根悄悄从「会话 cwd」漂到「部署默认根」（B2）。
5. 若保留在线 API 兜底：`ctx.web.fetch` 无法发 POST（C11 补充）→ 改用 node 子进程发 HTTP 或宿主 LLM 服务；同时注意新版对非公网 `apiUrl` 的拦截（B4）。
6. 顺手修 `stdio.stdin:'inherit'` → `'ignore'`（§4 备注；两版一致的小瑕疵）。

### 6.3 可选对齐新版 standard（非必需）
7. `workflow-worker-thread` → `workflow-ptc`（B6；先确认 U1）。
8. `tool-ralph` 加 `disabled: true`；`tool-web` 的 `fetch: false` → `true`；新增 `command-goal`、`present`、`tool-plugin-manager(disabled)`；`tool-subagent` 加 `modelSelectionSettings: true`。

### 6.4 明确「不要改」的部分（C 类）
- 插件里 `ctx.tools.register` 的 `output/parameters/execute` 写法、`ctx.effect(() => …)` 用法、`exec.agent.session.header.cwd` 读法、`ctx.fs.*` 全部调用（含 `writeText` 5 参数）、`inject` 数组、模块 `export name/inject/apply` 形式、`./plugins/hanhua/index.js` 本地行写法 —— **全部无需修改**。
- `[prst]\preset.yml`（`name`/`description`）无需改：新版 metadata 解析文件两侧哈希相同（`packages/preset/agent-presets/src/metadata.ts` 哈希相同）。

---

## 附：本次审计产生的只读证据文件（临时目录，非交付物）

- `%TEMP%\dsh-OB7ly5\probe-persona-config.mjs`（persona 字段实测）
- `%TEMP%\dsh-OB7ly5\probe-subprocess-cwd.mjs`（spawn cwd 实测）
- `%TEMP%\dsh-OB7ly5\probe-output-schema.mjs`（output.schema 子集实测）
- `%TEMP%\dsh-OB7ly5\audit\*.diff`（两侧逐文件 diff）
- 报告未修改任何插件、内核或配置文件；本报告为本次任务唯一写入。
