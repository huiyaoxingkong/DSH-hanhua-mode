// ═══════════════════════════════════════════════════════════════════════════
// 汉化引擎 · 动态包信封尾部（canonical dynamic tail）
//
// 只给 engine/host.js 用（动态包跑在 vm 里，由 dynamicCordisRunner 装载）。
//   · 工具本身由静态插件在 agent 层注册，这里刻意**不**把工具写进全局注册表：
//     动态包的注册落在全局层，会让同进程其它会话也看到 hanhua_* 工具（stop/重启才消失）。
//     toolDefs 保留下来只作为「工具契约」的自检与参考。
//   · 工作台 RPC 用 harness.handle 注册，供浏览器面板调用。
// ═══════════════════════════════════════════════════════════════════════════

const toolDefs = TOOL_SPECS.map((spec) => harness.defineTool({
  name: spec.name,
  description: spec.description,
  parameters: { type: 'object', properties: spec.properties || {}, required: spec.required || [] },
  output: { schema: { type: 'json' }, render: function (_a, v) { return [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] } },
  execute: async (args, exec) => withExec(exec, async () => Object.assign({ ok: true }, await spec.run(args || {}, exec))),
}))
void toolDefs

for (const rpcName of Object.keys(WORKBENCH_RPC)) harness.handle(rpcName, WORKBENCH_RPC[rpcName])
