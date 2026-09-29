// ═══════════════════════════════════════════════════════════════════════════
// 汉化引擎 · 工作台 RPC（canonical rpc）
//
// 动态包（engine/host.js）用 harness.handle 注册这些名字；浏览器面板
// （engine/client.js）通过 host.call('workbench.*') 调用。静态插件不直接注册它们，
// 它只负责把动态包装起来（hanhua_workbench action=install）。
// 约定：handler 返回可 JSON 化的值；错误直接抛，由 runner 转成 RPC 错误。
// ═══════════════════════════════════════════════════════════════════════════

const WORKBENCH_RPC = {
  'workbench.state': async () => ({
    summary: state.summary, root: state.root,
    entries: state.entries.length, translated: state.translated.length,
    busy: state.busy, lastError: state.lastError,
  }),
  'workbench.config.get': async () => { await loadMeta(); return maskConfig(config) },
  'workbench.config.set': async (args) => { const r = await configAction(Object.assign({ action: 'set' }, args || {})); return r.config },
  'workbench.glossary.list': async () => { await loadMeta(); return glossary.slice(0, 500) },
  'workbench.glossary.add': async (args) => { await glossaryAction(Object.assign({ action: 'add' }, args || {})); return glossary.slice(0, 500) },
  'workbench.glossary.remove': async (args) => { await glossaryAction(Object.assign({ action: 'remove' }, args || {})); return glossary.slice(0, 500) },
  'workbench.scan': async (args) => { const r = await scanRoot(args && args.root, args || {}); return { root: r.root, total: r.total, files: r.files.slice(0, 200), kinds: r.kinds } },
  'workbench.parse': async (args) => { const r = await parseFiles((args && args.files) || null, args && args.root); return { total: r.total, truncated: r.truncated, perFile: r.perFile, preview: r.entries.slice(0, 20), errors: (r.errors || []).slice(0, 20) } },
  'workbench.ocr': async (args, exec) => { const r = await ocrAction(args || {}, exec); return { summary: r.summary, images: (r.images || []).slice(0, 50), preview: (r.preview || []).slice(0, 20) } },
  'workbench.translate': async (args) => {
    const r = await translateEntries(args || {})
    return {
      summary: r.summary,
      usage: r.usage,
      preview: state.translated.filter((x) => x.method !== 'passthrough' && x.method !== 'skip').slice(0, 20).map((x) => ({ source: x.source, target: x.target, method: x.method, warnings: x.warnings.length })),
    }
  },
  'workbench.export': async (args) => exportEntries(args || {}),
  'workbench.usage': async () => usageAction({ action: 'get' }),
  'workbench.media.probe': async () => mediaAction({ action: 'probe' }),
  'workbench.pipeline': async (args) => {
    const steps = {}
    try { steps.scan = await scanRoot(args && args.root, args || {}) } catch (e) { return { ok: false, error: 'scan: ' + msg(e) } }
    try { steps.parse = await parseFiles(null) } catch (e) { return { ok: false, error: 'parse: ' + msg(e) } }
    try { steps.ocr = await ocrAction({}, null) } catch (e) { steps.ocr = { ok: false, error: msg(e) } }
    try { steps.translate = await translateEntries({}) } catch (e) { return { ok: false, error: 'translate: ' + msg(e) } }
    try { steps.export = await exportEntries({}) } catch (e) { return { ok: false, error: 'export: ' + msg(e) } }
    return { ok: true, steps }
  },
}
