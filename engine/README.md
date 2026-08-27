# 动态插件源码说明

本目录是「游戏汉化引擎」动态 Cordis 插件（`hanhu-1`）的源码成品，两半可以整体粘贴到 `cordis_define` 的 `code.host` / `code.client` 中运行。

- `host.js` — Host 半：引擎主体。函数体形式（`return { apply(ctx) {...} }`），运行在 DSH 宿主进程。
  - 模块：扫描（适配器注册表）→ 解析（JSON/CSV/PO/INI/TXT/YAML/RenPy + RPG Maker MV/MZ + RGSS Marshal + krkr）→ 翻译（词典优先/缓存/在线 API）→ QA → 导出（按格式重建 + 字节级写回）。
  - 依赖服务：`fs`、`web`、`sandboxPolicy`、`subprocess`（均 `ctx.get` 可选获取，缺失时给出明确错误）。
  - 会话工作区：从工具执行上下文 `exec.agent.session.header.cwd` 获取；写入时携带 `sandboxPolicy.resolve({session})`。
  - 二进制写盘：自实现 base64 编码器 + node 子进程 `writeFileSync`（沙箱 `btoa` 是 UTF-8 语义，不能用于二进制）。
  - GBK/Shift-JIS 编码：node 子进程 + iconv-lite（路径可配置 `iconvPath`）。
- `client.js` — Client 半：浏览器「汉化工作台」。无 JSX，全部 `React.createElement`。
  - 注册 `settings.section`（id=`hanhua-workbench`）整页面板与 `tool.view.cordis`（key=`self`）运行卡快捷面板。
  - 通过 `host.call('workbench.*')` 与 Host 半通信。

## 版本演进（重要修复备忘）

1. 工具输出 schema 必须是 `{type:'json'}`（`string` 会拒绝结构化返回值）。
2. `FsDirEntry.type` 的值是 `'directory'`（不是 `'dir'`）。
3. 会话工作区必须取 `exec.agent.session.header.cwd`（宿主级 `sandboxPolicy.workspaceRoot` 是进程工作目录）。
4. 写盘必须传 `sandboxPolicy.resolve({session})`，否则写不进会话工作区。
5. `parseFiles` 的 `root` 参数校验后要赋值给 `state.root`。
6. Marshal：文件头 `04 08` 要跳过/写出；`o/u/U/e/S/I` 的类名与 ivar 键是带 `0x3A` 前缀的符号（`readSym`），不能直接 `readName`。
7. 沙箱 `btoa` = UTF-8 编码后 base64；二进制必须用自实现 `bytesToB64`。
8. krkr 引号属性值切片：值域是 `[start+1, end)`，替换后剩余从 `end+1` 开始。
9. `subprocess.spawn` 必须带 `graceMs`。

## 与预设版的关系

`../preset/plugins/hanhua/index.js` 是同一引擎的**静态插件版**（ESM 导出 `name/inject/apply`，`ctx.tools.register` 注册工具、返回 JSON 字符串、注入 `subprocess/sandboxPolicy`），供「汉化模式」预设永久挂载。两份源码需同步演进。
