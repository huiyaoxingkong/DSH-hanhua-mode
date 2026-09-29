# 汉化工作台 客户端半 / 动态插件机制 兼容性审计
### 目标内核：DSH 0.1.1-rc.2 → 0.1.6-alpha.2

- 审计对象：`engine/client.js`（动态包 browser 半，v8）、`engine/host.js`（动态包 host 半）、
  `preset/agent.cordis.yml`、`preset/plugins/hanhua/index.js` 中与动态插件相关的部分。
- 证据源（下文用【新】【旧】指代）：
  - 【新】`D:\Agent-windows\DeepSeekHarness\core` —— `package.json` version `0.1.6-alpha.2`；
    `.dsh-desktop-info.json` tag `dsh-v0.1.6-alpha.2`（commit `ddefc45fbc7f`，2026-09-17）。
  - 【旧】`D:\Agent-windows\deepseek_harness\.tmp-core-old-0.1.1-rc.2` —— `package.json` version `0.1.1-rc.2`；
    `.dsh-desktop-info.json` tag `dsh-v0.1.1-rc.2`（commit `b150a551b8d4`）。
- 路径约定：【新】下的路径省略前缀，例如 `packages/extensions/...` 均指【新】。
- 结论分级：**不变**（源码契约相同）/ **需要改**（必须动代码或流程）/ **实效失效**（API 还在但已无渲染位）/ **已退役**。

---

## 0. 结论摘要（先读这一段）

1. **动态包的 client 半「源码形态」没有变。**
   新版仍然把 client 半当作**字符串源码**求值：`new Function('React','console','styles','host','harness', …traps, 'process','Buffer', 'return (async () => {' + 源码 + '})()')`，
   仍然必须 `return` 一个函数或 `{ apply(ctx) {...} }`。
   `packages/extensions/cordis-client-runner/src/client/evaluator.ts` 在【旧】【新】中**逐字节相同**（文件均 222 行）。
   `engine/client.js` 里用到的 `ctx.get('slots')`、`slots.inject`、`slots.register`、`styles.insert`、`host.call` **全部仍然有效**。

2. **但「装载入口」没了 —— 这是致命项。**
   0.1.6 起 `cordis_define` / `cordis_run` / `cordis_stop` / `cordis_undefine` / `cordis_inspect_self`
   **已整体退役**，任何预设、任何 composition 都不再有这些工具；`tool-cordis` 只剩两个只读 inspect 工具。
   官方 README 明写 "no model tool creates dynamic definitions"。
   → 《使用手册》里「动态插件方式安装工作台」这条路在 0.1.6 下不存在，**工作台面板不能原样跑起来**。

3. **两个 slot 的契约都还在，且与旧版逐字相同。**
   - `settings.section`（`kind:'list'`, `scope:'root'`，注册选项 `id`(必填)/`order`/`label`，owner props `{close}`）——**不变**，汉化工作台主面板逻辑可直接复用。
   - `tool.view.cordis`（`kind:'keyed'`, `scope:'session'`，`key` 必须 `'self'`，guard 重写为 `<pluginId>.<packageId>`）——**契约不变**。

4. **`tool.view.cordis` 的渲染位实效失效。**
   该 slot 由 `ui-cordis` 挂在 `tool.call.toolview` key=`cordis_run` 的注册项 **children** 上，
   只有会话记录里真的存在 `cordis_run` 工具调用卡片时才会渲染。
   `cordis_run` 工具退役后，即使 client 半成功加载，**「快捷面板」也永远不会出现**（注册静默挂起，不报错）。
   设置页里的 `settings.section` 面板不受此影响。

5. **最小修复方向**：client 半源码基本不用改，改的是**装载方式**——
   由 preset 自己的插件在 host 平面调用 `ctx.dynamicCordisRunner.define()` + `run()` 自装（见 §5 方案 B），
   或把工作台改造成 `dsh.client` 客户端插件包（见 §5 方案 A）。方案 B 改动最小，但需用户在 Cordis 面板点一次「批准」。

---

## 1. 契约对照总表

| # | 项目 | 旧契约（0.1.1-rc.2） | 新契约（0.1.6-alpha.2） | 证据（file:line） | 判定 |
|---|---|---|---|---|---|
| 1 | 动态包 client 半源码形态 | 字符串：`return { apply(ctx) {...} }`，作为 async 函数体求值 | **完全相同** | 【新】`packages/extensions/cordis-client-runner/src/client/evaluator.ts:166-221`（`:180` 为 `new Function` 包装）；与【旧】同路径文件 `git diff --no-index` **无差异** | 不变 |
| 2 | client 半可用的全局量 | `React`、`console`、`styles`、`host`，另加 `harness`（陷阱代理）与 `setTimeout/fetch/require/…` 教学陷阱；`process`/`Buffer` 为 `undefined` | **完全相同** | 【新】`…/client/evaluator.ts:173`（参数表）、`:201-210`（调用实参）、`:43-52`（陷阱表） | 不变 |
| 3 | `return` 形态校验 | 函数 或 `{ apply }` 对象；`undefined` 报「忘了 return」 | **完全相同** | 【新】`…/client/evaluator.ts:151-155`、`:211-220` | 不变 |
| 4 | `host.call(method, args)` | 转发到本包 host 半的 `harness.handle`；省略 args 时线上传 `null` | **完全相同** | 【新】`…/client/evaluator.ts:191-200`；host 侧 `packages/extensions/cordis-host-runner/src/index.ts:740-766`（`invoke`） | 不变 |
| 5 | `harness.handle(method, fn)` 命名约束 | 非空字符串即可（`workbench.state` 这类带点名字合法）；返回值经 JSON 克隆 | **完全相同** | 【新】`packages/extensions/cordis-host-runner/src/guard.ts:594-617`；该文件与【旧】仅 1 行 import 差异 | 不变 |
| 6 | `window.__ModuleLoader__.load({id, factory})` | 已存在（runner **内部**装载通道） | 仍存在，仍是 runner 内部实现细节，**没有变成作者要写的形态** | 【新】`…/client/runtime.ts:367-376`；【旧】`…/client/runtime.ts:98-100`、`:371-376`（两版此处相同） | 不是新契约 |
| 7 | **动态装载工具** | `cordis_define`、`cordis_run`、`cordis_stop`、`cordis_undefine`、`cordis_inspect_self` | **全部退役**，仅剩 `cordis_inspect_list` / `cordis_inspect_query` | 【旧】`packages/extensions/tool-cordis/src/index.ts:149, 241, 330, 352, 97`；【新】`packages/extensions/tool-cordis/src/index.ts:27-81`；【新】`apps/cli/tests/web-agent-presets.e2e.ts:362-368`；【新】`packages/extensions/cordis-host-runner/README.md:12` | **已退役（致命）** |
| 8 | dynamic 插件 id 前缀 | — | `plugin.idPrefix` 必须匹配 `/^[a-z]{3,6}$/`（3–6 个小写英文） | 【新】`packages/extensions/cordis-host-runner/src/index.ts:164-167`；【旧】同文件同处（diff 未涉及） | 不变 |
| 9 | `settings.section` | `kind:'list'`, `scope:'root'`；注册 `{name,id,order,label}`；owner props `{ close: () => void }` | **完全相同**（文件差异仅一行 type-only import） | 【新】`packages/client/ui-settings/src/client/contract/slots.ts:54`、`:123-126`；消费端【新】`packages/client/ui-settings-general/src/client/index.ts:112-128`（按 id/order/label 投影导航行）、`…/client/SettingsRoot.tsx:101`（`renderSlot('settings.section', { close }, { only: active })`）；目录【新】`…/cordis-client-runner/src/client/slot-catalog.ts:2196-2248` | 不变，可用 |
| 10 | `tool.view.cordis`（key=`'self'`） | `kind:'keyed'`, `scope:'session'`；guard 只接受 `key:'self'` 并改写为 `<pluginId>.<packageId>` | **完全相同** | 【新】`packages/extensions/ui-cordis/src/client/slots.ts:31-35`（与【旧】仅 import 路径差异）；guard【新】`…/cordis-client-runner/src/client/guard.ts:119-124`；目录【新】`…/client/slot-catalog.ts:3137-3183` | 契约不变 |
| 11 | `tool.view.cordis` 渲染位 | 由 `cordis_run` 卡片提供 | **仍挂在 `cordis_run` 卡片上**，而 `cordis_run` 工具已不存在 | 【新】`packages/extensions/ui-cordis/src/client/index.ts:124-136`（`children: { 'tool.view.cordis': { kind:'keyed', scope:'session' } }`）；【新】`slot-catalog.ts:3179`（`declaredBy: an entry in 'tool.call.toolview' (client-ui-cordis)`） | **实效失效** |
| 12 | `slots` 服务由谁提供 | `@deepseek-ai/dsh-client-runtime` | `@deepseek-ai/dsh-client-ui-renderer`（`client-runtime` 不再挂载） | 【新】`packages/bundle/web-app/cordis.patch.yml:210-211`（无 client-runtime 行）；【旧】同文件 `:176-177`（client-runtime）与 `:191-192`（ui-renderer）；【新】`packages/client/ui-renderer/src/client/registry.ts:119-120`、`:209-271`、`:735-746` | 内部重构，client 半无感 |
| 13 | `styles.insert(css)` | 每包一个 `<style data-dyn>`，卸载自动移除；返回 disposer | **完全相同** | 【新】`…/client/evaluator.ts:78-112` | 不变 |
| 14 | 失败后的自动修复引导 | 提示模型「定义新 Package 并用 `cordis_run mode:"update"` 自行修复」 | 改为「**报告给用户**；定义可在 Cordis 面板里管理」 | 【新】`packages/extensions/cordis-host-runner/src/index.ts:1035-1041`、`:1086-1087`、`:1108-1114` | 需要改（影响 preset 提示词） |
| 15 | 动态机制本体是否还在 | 有 | **有**：`cordis-host-runner` / `cordis-client-runner` / `ui-cordis` 仍随 web 包挂载 | 【新】`packages/bundle/web-app/cordis.patch.yml:121-122`（host runner）、`:198-199`（client runner）、`:289-290`（ui-cordis 面板） | 不变 |
| 16 | 谁还能创建动态定义 | 模型工具 + 浏览器控件 + 程序调用 | **只有程序调用（host 平面插件调 `dynamicCordisRunner.define`）+ 浏览器控件** | 【新】`packages/extensions/cordis-host-runner/README.md:12`；【新】`…/cordis-client-runner/README.md:12` | 需要改 |

---

## 2. 三个决定性发现（展开）

### 2.1 client 半源码逐字兼容 —— 不用改 `engine/client.js` 的代码本身

`engine/client.js` 的入口是 `return { apply(ctx) {...} }`（`engine/client.js:5-6`），内部用到：

| 用法 | 位置 | 新内核对应实现 |
|---|---|---|
| `ctx.get('slots')` | `engine/client.js:7` | 【新】`guard.ts:218-221` —— `get` 走 `readService(name, /*requireDeclaration*/ false)`，**无需在 `inject` 里声明**；返回 `guardedSlots` 代理 |
| `React.createElement` / `React.useState` / `React.useEffect` | `engine/client.js:9, 13-16, 20-27, 35` | 【新】`evaluator.ts:173`（`React` 作为闭包形参注入）、`:201-202` |
| `styles.insert(css)` | `engine/client.js:11` | 【新】`evaluator.ts:89-100` |
| `slots.inject(key, cb)` + `slots.register(options, component)` | `engine/client.js:131-138` | 【新】`registry.ts:209-271`（inject）、`:735-746`（register 仍是**原型方法**，guard 依赖此点做调用方 fiber 追踪，见 `guard.ts:96-143`） |
| `host.call('workbench.*')` | `engine/client.js:30-32, 50-54, 60, 63-64, 74, 112, 116, 120` | 【新】`evaluator.ts:199` → `runtime.ts:348-349` → host `invoke`（`cordis-host-runner/src/index.ts:740-766`） |
| `slots.register({name:'settings.section', id, order, label}, …)` | `engine/client.js:131-134` | 【新】契约一致（见 §1 #9）；合法选项集见 `slot-catalog.ts:2201-2220` |
| `slots.register({name:'tool.view.cordis', key:'self'}, …)` | `engine/client.js:135-138` | 【新】`guard.ts:119-124` 显式校验 `key === 'self'`；其余键直接抛 guard 错误 |

**验证方式**：`evaluator.ts` 与【旧】完全一致（两版都是 222 行，逐行对比无差异）；`guard.ts` 与【旧】的差异仅 4 处：
头部注释、`SlotRegistry` 的 import 包名（`dsh-client-runtime/client` → `dsh-client-ui-renderer/client`）、新增 `registerFactory` 分支、ledger 注释。
`tool.view.cordis` 的 `key='self'` 校验逻辑 `guard.ts:119-124` 两版相同。

### 2.2 装载入口整体退役（致命）

- `tool-cordis` 在 0.1.6 里**只剩两个只读工具**：`cordis_inspect_list`（`:28`）、`cordis_inspect_query`（`:47`），
  连 `cordis_inspect_self` 都删了；系统提示从 10318 字节缩到 339 字节（【新】`tool-cordis/src/prompt.ts:1-4`）。
- 官方 e2e 直接断言这五个工具**不存在**：
  `apps/cli/tests/web-agent-presets.e2e.ts:365-367`、`apps/cli/tests/profiles/web/tests/creator-plugin-manager.expected.e2e.ts:76-78`。
  `:422` 还断言 `standard` 预设里没有 `cordis_define`。
- host runner README 原文（`cordis-host-runner/README.md:12`）：
  "Agents discover APIs through `tool-cordis` and install persistent bundles through Plugin Manager;
  **no model tool creates dynamic definitions**."
- 0.1.6 的 `cordis` 预设把重心换成 **Plugin Manager（Creator 模式）**：
  `packages/preset/agent-presets/presets/cordis/agent.cordis.yml:260-261`（tool-cordis 行）、`:282-283`（`@deepseek-ai/dsh-plugin-manager/tools`）。
- 动态机制本体还在（`cordis-host-runner` / `cordis-client-runner` / `ui-cordis` 都随 web 包挂载，见 §1 #15），
  且 `define` 仍是 host 服务的公开方法（`cordis-host-runner/src/index.ts:151-202`），`run` 也是（`:248-312`）——
  所以「程序调用 + 面板」这条路仍然通，只是**模型工具没了**。
- 附带的流程变化：动态装载失败后不再引导模型自愈，而是引导上报用户（见 §1 #14）。

### 2.3 `tool.view.cordis` 快捷面板实效失效

`ui-cordis` 的注册结构（【新】`packages/extensions/ui-cordis/src/client/index.ts:124-136`）：

```ts
ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
  name: 'tool.call.toolview',
  key: 'cordis_run',
  children: { 'tool.view.cordis': { kind: 'keyed', scope: 'session' } },   // ← 该 slot 的声明点
  inject: …,
}, CordisRunRow))
```

- `tool.call.toolview` 的 key=`cordis_run` 条目只在会话里**存在 `cordis_run` 工具调用**时才被渲染（`CordisRunRow`）。
- 会话索引 `CordisRunCardRegistry`（`ui-cordis/src/client/run-card-index.ts`）只从 `cordis_run` 结果卡片里 `observe(pointer)`。
- `cordis_run` 工具退役 ⇒ 永远没有这张卡片 ⇒ 即便 client 半加载成功、`slots.register({key:self})` 成功，
  `QuickPanel` 也找不到渲染位（`slots.inject` 的注册回调会静默等待，不报错）。
- 对比：`settings.section` 由常驻的 `ui-settings-general` 条目声明（【新】`ui-settings-general/src/client/index.ts:158-170`），
  所以**设置页的「汉化工作台」面板不受影响**，只有会话流里的快捷面板失效。

---

## 3. 迁移目标：新版官方推荐的形态是什么

新版 `cordis` 预设的 persona 明确指向 **安装式 UI 插件（installed UI plugin）**：

- `packages/preset/agent-presets/presets/cordis/agent.cordis.yml:32`：
  "requests to make a visual object, decoration, or widget mean creating an installed UI plugin that displays it in
  this Harness Web UI … build the plugin in the workspace, and install it with `plugin_manager`."
- 客户端插件包契约（`packages/client/modules/README.md:34`）：
  `package.json` 声明 `dsh.client: { platform: 'web' }`，导出 `./client` bundle，非基线依赖写进 `dsh.client.external`；
  host 半扫描 **enabled Loader entries** 的包并把它作为 `/plugins/<id>/client.js` 提供（`:12`、`:50`）。
- 客户端 bundle 的实际形态（可直接照抄，`packages/extensions/ui-cordis/lib/client.js:1-3` 与文件尾）：

```js
window.__ModuleLoader__.load({
  id: "@deepseek-ai/dsh-client-ui-cordis",
  factory: (require) => {
    // …模块体，require("react") / require("react/jsx-runtime") / require("<其他 client 包名>")
    exports.apply = apply
    exports.inject = inject
    return module.exports
  }
})
```

- 即：**`window.__ModuleLoader__.load({id, factory})` 是「安装式客户端插件」的形态**，
  与动态包的「闭包字符串」是两条并行的通道；前者在 0.1.1 里也已存在（`client/modules` 【旧】就有）。
- `plugin_manager` 是 0.1.6 **新增**的能力（【旧】无 `packages/boot/plugin-manager`，【新】有）。

---

## 4. 最小迁移方案（按改动量排序）

### 方案 B（推荐，改动最小）：保留动态包，改由 preset 自己的插件「自装」

**思路**：`engine/host.js` / `engine/client.js` **源码保持不动**（动态半契约没变），
只把「模型调 `cordis_run`」换成「preset 本地插件在 host 平面调 `dynamicCordisRunner.define()` + `run()`」。

**落地要点**（改 `preset/plugins/hanhua/index.js`，约 20–30 行）：

1. 在插件里解析 host 服务：`const runner = ctx.get('dynamicCordisRunner')`
   （或在 `export const inject` 里加 `'dynamicCordisRunner'`；该服务由 host 平面 `cordis-host-runner` 提供，
   `packages/bundle/web-app/cordis.patch.yml:121-122`）。**取不到就早退**，别让整个插件挂掉。
2. 新注册一个工具（沿用文件里现成的 `registerTool` helper，签名改成能拿到 `exec`）：

```js
registerTool('hanhua_workbench_install', '安装/升级「汉化工作台」面板（动态插件）。',
  { action: { type: 'string', enum: ['install', 'status'] } }, [], async (args, exec) => {
    const agent = exec && exec.agent            // Agent.id 即 SessionId，见 host-runner index.ts:1229-1232
    const receipt = runner.define({
      sessionId: agent.id,
      plugin: { kind: 'new', idPrefix: 'hanhu' },   // 必须 /^[a-z]{3,6}$/（index.ts:164-167）
      name: '汉化工作台', purpose: '设置页面板 + 快捷面板',
      code: { host: readFileSync(HOST_JS, 'utf8'), client: readFileSync(CLIENT_JS, 'utf8') },
    })
    const res = await runner.run(agent, receipt.pluginId, receipt.packageId, 'run')
    // res.status === 'awaiting-approval' 时，提示用户到左侧栏 Cordis 面板点「批准」
    return { ok: res.ok !== false, receipt, run: res }
  })
```

3. 工具返回里必须告诉用户：**首次装载需要在 Cordis 面板点「批准」**
   （host `run` 会 emit `cordis/request-run` 并返回 `awaiting-approval`，`cordis-host-runner/src/index.ts:277-311`；
   client runner 的文档也说 "It loads a definition after an approved request or explicit user gesture"，
   `cordis-client-runner/README.md:12`）。
4. `engine/client.js` 只需**一处**小改：`tool.view.cordis` 快捷面板没有渲染位了（§2.3），
   把它改注册到别的常驻 slot（`shell.overlay` `kind:'list', scope:'root'`，目录 `slot-catalog.ts:2280-2294`；
   或 `sidebar.footer.action`，`ui-cordis` 自己就用它放面板，`ui-cordis/src/client/index.ts:86`），
   或者直接删掉 `engine/client.js:135-138` 那段、只保留设置页面板。
5. **preset 提示词/文档要同步改**：`preset/agent.cordis.yml` persona、`docs/使用手册.md:3-14` 里的
   「动态插件方式」「已运行动态插件 `hanhu-1`」等描述在 0.1.6 下不再成立（没有模型工具可调）。

**优点**：host/client 两半源码零改动（RPC 仍走 `dynamicCordisRunner/invoke`，`workbench.*` 名字合法）；
**代价**：每次装载需用户点一次批准；定义在进程重启后消失（`cordis-host-runner/README.md:12`：
"Definitions disappear on restart"）。

### 方案 A（与新内核方向一致，改动大）：改造成安装式 `dsh.client` 插件包

1. `preset/plugins/hanhua/package.json` 增加：
   ```json
   "exports": { ".": "./index.js", "./client": "./client.js" },
   "dsh": { "client": { "platform": "web" } }
   ```
   （现有文件只有 `main` + `exports["."]`，见 `preset/plugins/hanhua/package.json:1-8`。）
2. 把 `engine/client.js` 改写成 `client.js`：外壳用 `window.__ModuleLoader__.load({ id: 'hanhua-engine', factory: (require) => { … } })`，
   模块体导出 `apply` + `inject`（**必须是 `ctx.slots` 这种声明式访问，客户端插件是真 Cordis 插件**，
   不再是 guard 门面；`ctx.get('slots')` 同样可用）。
3. 面板代码基本可原样搬：`React.createElement` 部分不动；`styles.insert(css)` 换成模块内自行 `document.head.append(style)`
   （或 `ctx.effect` 清理）；`h(Workbench)` 之类的组件写法不变。
4. **必须重做 RPC**：安装式客户端插件没有动态 runner 的 `host.call`。
   现有 Remote namespace 是**固定清单**（`packages/api/remotes/src/client/index.ts:168-174` 逐个 `ctx.remote.$mount(...)`），
   第三方包能否自注册 namespace **未在本仓库文档中找到明确路径**（见 §6 无法确认项）。
   可行替代：host 半把能力做成工具/服务，client 半只做展示；或改走 `workspaceFiles` / `terminal` 等既有 namespace。

> 结论：**方案 B 是真正的最小改动**；方案 A 更"正统"但要重新设计浏览器↔host 的数据通道，属于重写级工作量。

---

## 5. 无法确认项及验证方法

| 项 | 为什么无法确认 | 验证方法 |
|---|---|---|
| 桌面版 1.0.5 实际挂载的 bundle 是否含 `cordis-host-runner` / `cordis-client-runner` / `ui-cordis` | 仓库里的证据是 web 包 composition（`packages/bundle/web-app/cordis.patch.yml:121-122, 198-199, 289-290`），实际安装目录可能带用户 patch | 打开部署后的 `cordis.yml`（或 `dsh web --print-config` 之类）搜索这三行；或在浏览器控制台看 `window.__DSH_BOOT__` 是否含 `@deepseek-ai/dsh-client-ui-cordis` |
| preset 本地插件（`./plugins/hanhua/index.js`，host 平面）能否 `ctx.get('dynamicCordisRunner')` 取到 host 平面的 runner | 未实测预设 realm 与 host realm 的服务可见性（该插件已经能注入 host 的 `tools/systemPrompt/fs/web`，所以大概率可以） | 在插件 `apply` 里 `ctx.logger.info(Object.keys(ctx.fiber.inject))`，或临时加一个工具返回 `typeof ctx.get('dynamicCordisRunner')` |
| 第三方包能否注册自己的 Remote namespace（方案 A 的 RPC） | client 侧 namespace 清单是硬编码的（`packages/api/remotes/src/client/index.ts:168-174`）；未找到面向第三方包的公开注册文档 | 读 `packages/api/remotes/README.md` 与 Typert 协议文档；或用一个实验 bundle 直接 `await ctx.remote.$mount(contr)` 试挂 |
| `preset/plugins/hanhua`（相对路径行）的 `dsh.client` 是否会被 client-modules 扫描到 | 扫描按 Loader row 的模块位置定位最近 `package.json`（`packages/client/modules/src/index.ts:790-816`），相对路径行属未验证场景 | 给该包加 `dsh.client` 后启动 web，请求 `/plugins/hanhua-engine/client.js` 看是否 200；或看 console 是否报 "declares dsh.client but exports no ./client bundle" |
| `engine/host.js` 在 0.1.6 里 `ctx.get('fs'/'web'/'sandboxPolicy'/'subprocess'/'agents')` 是否都还解析得到 | 属 host 半/服务审计范围（本任务只覆盖 client 半与 RPC 通道）；host 沙箱代码本身【旧】【新】相同（`packages/extensions/cordis-host-runner/src/sandbox.ts` 未出现在差异清单中） | 实际装载一次 host 半，看 load report；或逐个核对新内核里这些服务的 provider 包 |
| 会话流里 `tool.view.cordis` 是否真的完全没有渲染位 | 结论来自源码（children 声明挂在 `cordis_run` 卡片上）；未在真实 GUI 里跑 | 用方案 B 装载后，检查会话中是否出现 Cordis 面板中的已运行条目，且会话流里没有快捷面板卡片 |
| `preset/agent.cordis.yml` 本身在 0.1.6 是否还能挂载 | 它是 0.1.1-rc.2 `standard` 的副本；新内核 `standard` 已改动（见下方提示），差异不在本任务写入范围 | 见「跨任务提示」 |

### 跨任务提示（越界发现，交给 preset/composition 审计任务）
- `preset/agent.cordis.yml` 是【旧】`standard` 预设的整份拷贝（对比【新】`packages/preset/agent-presets/presets/standard/agent.cordis.yml`）。
  新内核 `standard` 多出 `command-goal`、`tool-plugin-manager` 等行；
  而【旧】里的 `@deepseek-ai/dsh-workflow-worker-thread` 在新内核仍存在，`tool-subagent-report` 相关行已被移除。
- 【新】的 shipped preset 根是 `packages/preset/agent-presets/presets/`（`discovery.ts:60` `SHIPPED_PRESET_ROOT = new URL('../presets/', import.meta.url)`）；
  `apps/cli/config/agent-presets/` 目录里那份 `cordis/agent.cordis.yml` 与【旧】**逐字节相同**、且没有 `apps/cli/src` 引用它，属遗留副本，不要照抄。

---

## 6. 附：本次审计用到的关键证据清单

**新内核（0.1.6-alpha.2）**
- `packages/extensions/cordis-client-runner/src/client/evaluator.ts:43-52, 78-112, 151-155, 166-221`
- `packages/extensions/cordis-client-runner/src/client/runtime.ts:343-400, 409-437, 443-459`
- `packages/extensions/cordis-client-runner/src/client/guard.ts:96-143, 119-124, 194-239`
- `packages/extensions/cordis-client-runner/src/client/slot-catalog.ts:67-75, 2196-2248, 3137-3183`
- `packages/extensions/cordis-client-runner/src/client/index.ts:174-182, 291-292`
- `packages/extensions/cordis-client-runner/README.md:12, 32, 36, 71`
- `packages/extensions/cordis-host-runner/src/index.ts:151-202, 248-312, 740-766, 1035-1041, 1229-1232`
- `packages/extensions/cordis-host-runner/src/guard.ts:594-617`
- `packages/extensions/cordis-host-runner/README.md:12`
- `packages/extensions/tool-cordis/src/index.ts:22-81`；`…/src/prompt.ts:1-4`
- `packages/extensions/ui-cordis/src/client/slots.ts:31-35`；`…/src/client/index.ts:86, 117-145`
- `packages/client/ui-settings/src/client/contract/slots.ts:54, 123-126`
- `packages/client/ui-settings-general/src/client/index.ts:112-128, 158-170`；`…/client/SettingsRoot.tsx:101`
- `packages/client/ui-renderer/src/client/registry.ts:119-120, 209-271, 735-746`；`…/src/client/index.ts:89-97`
- `packages/client/modules/README.md:12, 34, 46, 50`；`…/src/index.ts:790-816`
- `packages/api/remotes/src/client/index.ts:168-174`
- `packages/bundle/web-app/cordis.patch.yml:121-122, 198-199, 210-211, 289-290`
- `packages/preset/agent-presets/presets/cordis/agent.cordis.yml:32, 34, 260-261, 282-283`
- `apps/cli/tests/web-agent-presets.e2e.ts:362-368, 422`
- `apps/cli/tests/profiles/web/tests/creator-plugin-manager.expected.e2e.ts:75-78`
- `apps/cli/config/examples/cordis/cordis.yml:15-19`（示例 composition：host runner 属**可选**插入行）

**旧内核（0.1.1-rc.2）**
- `packages/extensions/tool-cordis/src/index.ts:42, 61, 97, 149, 241, 330, 352`
- `packages/extensions/cordis-client-runner/src/client/evaluator.ts`（与新版逐字节相同）
- `packages/extensions/cordis-client-runner/src/client/runtime.ts:98-100, 371-376`
- `packages/bundle/web-app/cordis.patch.yml:108-109, 176-177, 179-180, 191-192, 223-224`

**被审项目**
- `DSH-hanhua-mode/engine/client.js:5-11, 30-32, 50-54, 108-138`
- `DSH-hanhua-mode/engine/host.js:1613-1630`（`harness.handle('workbench.*')`）
- `DSH-hanhua-mode/preset/agent.cordis.yml:24-33, 254-257`
- `DSH-hanhua-mode/preset/plugins/hanhua/package.json:1-8`、`…/index.js:1589-1593`
- `DSH-hanhua-mode/docs/使用手册.md:3-14`
