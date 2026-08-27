// 汉化引擎 Client 半（汉化工作台面板），v8
// 注册：设置页「汉化工作台」(settings.section) + cordis_run 卡快捷面板 (tool.view.cordis key=self)
// 本文件同时是 GitHub 仓库 engine/client.js 的源码成品。

return {
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return
    const h = React.createElement

    styles.insert('\n.hb-root { display: flex; flex-direction: column; gap: 14px; padding: 4px 2px 24px; max-width: 880px; }\n.hb-card { border: 1px solid var(--border-subtle, rgba(128,128,128,.25)); border-radius: 10px; padding: 14px 16px; background: var(--bg-subtle, rgba(255,255,255,.02)); }\n.hb-card-title { font-weight: 600; margin-bottom: 10px; }\n.hb-actions { display: flex; gap: 8px; flex-wrap: wrap; margin: 8px 0; }\n.hb-btn { border: 1px solid var(--border-subtle, rgba(128,128,128,.35)); background: var(--bg-subtle, transparent); color: var(--text-primary, #e8e8e8); border-radius: 8px; padding: 6px 12px; cursor: pointer; font-size: 13px; }\n.hb-btn:hover:not(:disabled) { border-color: #7c9cff; color: #7c9cff; }\n.hb-btn:disabled { opacity: .5; cursor: default; }\n.hb-input { width: 100%; box-sizing: border-box; border: 1px solid var(--border-subtle, rgba(128,128,128,.35)); background: var(--bg-subtle, transparent); color: var(--text-primary, #e8e8e8); border-radius: 6px; padding: 5px 8px; font-size: 13px; }\n.hb-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }\n.hb-label { flex: 0 0 110px; font-size: 12px; opacity: .85; }\n.hb-msg { font-size: 12px; margin-top: 6px; color: #9db4ff; }\n.hb-warn { font-size: 12px; color: #ffb27a; }\n.hb-quick { padding: 10px 12px; border: 1px solid rgba(124,156,255,.35); border-radius: 10px; background: rgba(124,156,255,.06); display: flex; flex-direction: column; gap: 8px; }\n.hb-quick-title { font-weight: 600; }\n.hb-table { width: 100%; border-collapse: collapse; font-size: 12px; }\n.hb-table td, .hb-table th { border-bottom: 1px solid rgba(128,128,128,.2); padding: 4px 6px; text-align: left; vertical-align: top; }\n.hb-tag { display: inline-block; font-size: 11px; border-radius: 4px; padding: 0 6px; border: 1px solid rgba(128,128,128,.4); margin-right: 4px; }\n')

    const Btn = (props) => h('button', { className: 'hb-btn', disabled: !!props.disabled, onClick: props.onClick, title: props.title || '' }, props.label)
    const Card = (props) => h('div', { className: 'hb-card' }, h('div', { className: 'hb-card-title' }, props.title), props.children)
    const Row = (props) => h('div', { className: 'hb-row' }, props.children)
    const Input = (props) => h('input', { className: 'hb-input', type: props.type || 'text', value: props.value || '', placeholder: props.placeholder || '', onChange: (e) => props.onChange(e.target.value) })
    const errMsg = (e) => String((e && e.message) || e)

    function Workbench() {
      const [st, setSt] = React.useState(null)
      const [cfg, setCfg] = React.useState(null)
      const [gloss, setGloss] = React.useState([])
      const [preview, setPreview] = React.useState([])
      const [msg, setMsg] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [term, setTerm] = React.useState({ source: '', target: '' })
      const [keyInput, setKeyInput] = React.useState('')

      const refresh = async () => {
        const s = await host.call('workbench.state')
        const c = await host.call('workbench.config.get')
        const g = await host.call('workbench.glossary.list')
        setSt(s); setCfg(c); setGloss(Array.isArray(g) ? g : [])
      }
      React.useEffect(() => { refresh().catch((e) => setMsg(errMsg(e))) }, [])

      const run = async (name, fn, after) => {
        setBusy(true); setMsg('\u8fd0\u884c\u4e2d: ' + name + ' ...')
        try {
          const r = await fn()
          if (r && r.ok === false) throw new Error(r.error || '\u5931\u8d25')
          setMsg('\u5b8c\u6210: ' + name)
          if (after) after(r)
          await refresh()
        } catch (e) { setMsg('\u9519\u8bef: ' + errMsg(e)) }
        finally { setBusy(false) }
      }

      const actions = [
        { name: '\u626b\u63cf', fn: () => host.call('workbench.scan', {}) },
        { name: '\u89e3\u6790', fn: () => host.call('workbench.parse', {}) },
        { name: '\u7ffb\u8bd1', fn: () => host.call('workbench.translate', {}), after: (r) => setPreview((r && r.preview) || []) },
        { name: '\u5bfc\u51fa', fn: () => host.call('workbench.export', { mode: 'inplace' }) },
      ]

      const saveConfig = () => {
        if (!cfg) return
        const payload = { root: cfg.root, apiUrl: cfg.apiUrl, model: cfg.model, targetLang: cfg.targetLang, sourceLang: cfg.sourceLang, rgssEncoding: cfg.rgssEncoding, krkrEncoding: cfg.krkrEncoding, iconvPath: cfg.iconvPath, apiChunk: parseInt(cfg.apiChunk, 10) || 40 }
        if (keyInput) payload.apiKey = keyInput
        run('\u4fdd\u5b58\u914d\u7f6e', () => host.call('workbench.config.set', payload), () => setKeyInput(''))
      }

      const addTerm = () => run('\u6dfb\u52a0\u8bcd\u6761', () => host.call('workbench.glossary.add', { source: term.source, target: term.target }), () => setTerm({ source: '', target: '' }))
      const removeTerm = (i) => run('\u5220\u9664\u8bcd\u6761', () => host.call('workbench.glossary.remove', { index: i }))

      return h('div', { className: 'hb-root' },
        h(Card, { title: '\u6c49\u5316\u5f15\u64ce\u72b6\u6001' },
          st ? h('div', null,
            h('div', null, '\u9879\u76ee\u6839\u76ee\u5f55: ' + (st.root || '\u672a\u8bbe\u7f6e\uff0c\u8bf7\u5728\u4e0b\u65b9\u914d\u7f6e\u4e2d\u586b\u5199')),
            h('div', null, '\u626b\u63cf ' + st.summary.scanned + ' \u00b7 \u89e3\u6790 ' + st.entries + ' \u00b7 \u8bd1\u6587 ' + st.translated + ' \u00b7 \u5df2\u5bfc\u51fa ' + st.summary.exported + ' \u00b7 QA \u63d0\u793a ' + st.summary.qaWarnings),
            st.lastError ? h('div', { className: 'hb-warn' }, '\u63d0\u793a: ' + st.lastError) : null,
            h('div', { className: 'hb-actions' },
              actions.map((a) => h(Btn, { key: a.name, label: a.name, disabled: busy, onClick: () => run(a.name, a.fn, a.after) })),
              h(Btn, { label: '\u4e00\u952e\u5168\u6d41\u7a0b', disabled: busy, onClick: () => run('\u5168\u6d41\u7a0b', () => host.call('workbench.pipeline', {})) })),
            msg ? h('div', { className: 'hb-msg' }, msg) : null) : h('div', null, '\u52a0\u8f7d\u4e2d\u2026')),
        h(Card, { title: '\u7ffb\u8bd1\u914d\u7f6e' },
          cfg ? h('div', null,
            h(Row, null, h('label', { className: 'hb-label' }, '\u9879\u76ee\u6839\u76ee\u5f55'), h(Input, { value: cfg.root || '', placeholder: 'D:\\Games\\...', onChange: (v) => setCfg(Object.assign({}, cfg, { root: v })) })),
            h(Row, null, h('label', { className: 'hb-label' }, 'API \u63a5\u53e3'), h(Input, { value: cfg.apiUrl || '', placeholder: 'https://api.openai.com/v1/chat/completions', onChange: (v) => setCfg(Object.assign({}, cfg, { apiUrl: v })) })),
            h(Row, null, h('label', { className: 'hb-label' }, 'API Key'), h(Input, { type: 'password', value: keyInput, placeholder: cfg.apiKey ? '\u5df2\u914d\u7f6e: ' + cfg.apiKey : '\u586b\u5199\u65b0\u5bc6\u94a5', onChange: setKeyInput })),
            h(Row, null, h('label', { className: 'hb-label' }, '\u6a21\u578b'), h(Input, { value: cfg.model || '', onChange: (v) => setCfg(Object.assign({}, cfg, { model: v })) })),
            h(Row, null, h('label', { className: 'hb-label' }, '\u76ee\u6807\u8bed\u8a00'), h(Input, { value: cfg.targetLang || '', onChange: (v) => setCfg(Object.assign({}, cfg, { targetLang: v })) })),
            h(Row, null, h('label', { className: 'hb-label' }, 'RGSS \u7f16\u7801'), h(Input, { value: cfg.rgssEncoding || '', placeholder: 'auto / gbk / shift_jis / utf-8', onChange: (v) => setCfg(Object.assign({}, cfg, { rgssEncoding: v })) })),
            h(Row, null, h('label', { className: 'hb-label' }, 'krkr \u7f16\u7801'), h(Input, { value: cfg.krkrEncoding || '', placeholder: 'auto / gbk / shift_jis', onChange: (v) => setCfg(Object.assign({}, cfg, { krkrEncoding: v })) })),
            h(Row, null, h('label', { className: 'hb-label' }, 'API \u6bcf\u6279\u6761\u6570'), h(Input, { value: cfg.apiChunk !== undefined && cfg.apiChunk !== null ? String(cfg.apiChunk) : '40', placeholder: '40\uff08\u8d8a\u5927\u8d8a\u7701\u63d0\u793a\u8bcd token\uff09', onChange: (v) => setCfg(Object.assign({}, cfg, { apiChunk: v })) })),
            h(Row, null, h('label', { className: 'hb-label' }, 'iconv \u8def\u5f84'), h(Input, { value: cfg.iconvPath || '', placeholder: 'iconv-lite \u7edd\u5bf9\u8def\u5f84', onChange: (v) => setCfg(Object.assign({}, cfg, { iconvPath: v })) })),
            h(Btn, { label: '\u4fdd\u5b58\u914d\u7f6e', disabled: busy, onClick: saveConfig })) : h('div', null, '\u52a0\u8f7d\u4e2d\u2026')),
        h(Card, { title: '\u8bcd\u5178 / \u672f\u8bed\u8868 (' + gloss.length + ')' },
          h(Row, null,
            h(Input, { value: term.source, placeholder: '\u539f\u6587\uff08\u5982 Potion\uff09', onChange: (v) => setTerm(Object.assign({}, term, { source: v })) }),
            h(Input, { value: term.target, placeholder: '\u8bd1\u6587\uff08\u5982 \u836f\u6c34\uff09', onChange: (v) => setTerm(Object.assign({}, term, { target: v })) }),
            h(Btn, { label: '\u6dfb\u52a0', disabled: busy, onClick: addTerm })),
          h('table', { className: 'hb-table' },
            h('thead', null, h('tr', null, h('th', null, '\u539f\u6587'), h('th', null, '\u8bd1\u6587'), h('th', null, '\u7c7b\u578b'), h('th', null, ''))),
            h('tbody', null, gloss.slice(0, 100).map((g, i) => h('tr', { key: 'g' + i },
              h('td', null, g.source), h('td', null, g.target),
              h('td', null, g.regex ? h('span', { className: 'hb-tag' }, '\u6b63\u5219') : null),
              h('td', null, h('button', { className: 'hb-btn', disabled: busy, onClick: () => removeTerm(i) }, '\u5220\u9664'))))))),
        h(Card, { title: '\u8bd1\u6587\u9884\u89c8 (' + preview.length + ')' },
          preview.length ? h('table', { className: 'hb-table' },
            h('thead', null, h('tr', null, h('th', null, '\u539f\u6587'), h('th', null, '\u8bd1\u6587'), h('th', null, '\u65b9\u5f0f'), h('th', null, 'QA'))),
            h('tbody', null, preview.map((p, i) => h('tr', { key: 'p' + i },
              h('td', null, p.source), h('td', null, p.target),
              h('td', null, h('span', { className: 'hb-tag' }, p.method)),
              h('td', null, p.warnings ? String(p.warnings) + ' \u9879' : ''))))) : h('div', null, '\u8fd8\u6ca1\u6709\u8bd1\u6587\u2014\u2014\u70b9\u51fb\u201c\u7ffb\u8bd1\u201d\u6216\u201c\u4e00\u952e\u5168\u6d41\u7a0b\u201d')))
    }

    function QuickPanel() {
      const [st, setSt] = React.useState(null)
      const [msg, setMsg] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      React.useEffect(() => { host.call('workbench.state').then(setSt).catch((e) => setMsg(errMsg(e))) }, [])
      const run = async () => {
        setBusy(true); setMsg('\u6c49\u5316\u6d41\u6c34\u7ebf\u8fd0\u884c\u4e2d\u2026')
        try {
          const r = await host.call('workbench.pipeline', {})
          if (r.ok === false) throw new Error(r.error || '\u5931\u8d25')
          const s = r.steps
          setMsg('\u5b8c\u6210: \u626b\u63cf ' + s.scan.total + ' \u6587\u4ef6 \u00b7 \u8bd1\u6587 ' + s.translate.summary.total + ' \u6761 \u00b7 \u5bfc\u51fa ' + s.export.ok + ' \u4e2a\u6587\u4ef6')
          host.call('workbench.state').then(setSt)
        } catch (e) { setMsg('\u9519\u8bef: ' + errMsg(e)) }
        finally { setBusy(false) }
      }
      return h('div', { className: 'hb-quick' },
        h('div', { className: 'hb-quick-title' }, '\ud83c\udfae \u6c49\u5316\u6a21\u5f0f\u5df2\u5c31\u7eea'),
        st ? h('div', null, '\u626b\u63cf ' + st.summary.scanned + ' \u00b7 \u89e3\u6790 ' + st.entries + ' \u00b7 \u8bd1\u6587 ' + st.translated + ' \u00b7 QA ' + st.summary.qaWarnings) : null,
        h(Btn, { label: busy ? '\u8fd0\u884c\u4e2d\u2026' : '\ud83d\ude80 \u8fd0\u884c\u6c49\u5316\u6d41\u6c34\u7ebf', disabled: busy, onClick: run }),
        msg ? h('div', { className: 'hb-msg' }, msg) : null)
    }

    slots.inject('settings.section', () => slots.register(
      { name: 'settings.section', id: 'hanhua-workbench', order: 50, label: '\u6c49\u5316\u5de5\u4f5c\u53f0' },
      () => h(Workbench),
    ))
    slots.inject('tool.view.cordis', () => slots.register(
      { name: 'tool.view.cordis', key: 'self' },
      () => h(QuickPanel),
    ))
  },
}
