// 汉化引擎 Client 半（汉化工作台面板），v2
// 注册：设置页「汉化工作台」(settings.section，常驻设置页) —— 唯一入口。
// v9 变更（0.1.6-alpha.2）：cordis_run 工具已退役，会话流里不再有该卡片，
// tool.view.cordis(key='self') 的快捷面板永远没有渲染位，故删除该注册与 QuickPanel；
// 常驻的设置页面板不受影响。装载方式见 docs/WORKBENCH-0.1.6.md。
// v2 新增：OCR（图文/漫画/图片艺术字）、媒体能力探测、token 账本三个卡片，
//          以及 visionModel / ocrEngine / ocrBudget / typesetFont 等配置项。
// 本文件同时是 GitHub 仓库 engine/client.js 的源码成品（并复制到 preset/plugins/hanhua/engine/）。

return {
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return
    const h = React.createElement

    styles.insert('\n.hb-root { display: flex; flex-direction: column; gap: 14px; padding: 4px 2px 24px; max-width: 880px; }\n.hb-card { border: 1px solid var(--border-subtle, rgba(128,128,128,.25)); border-radius: 10px; padding: 14px 16px; background: var(--bg-subtle, rgba(255,255,255,.02)); }\n.hb-card-title { font-weight: 600; margin-bottom: 10px; }\n.hb-actions { display: flex; gap: 8px; flex-wrap: wrap; margin: 8px 0; }\n.hb-btn { border: 1px solid var(--border-subtle, rgba(128,128,128,.35)); background: var(--bg-subtle, transparent); color: var(--text-primary, #e8e8e8); border-radius: 8px; padding: 6px 12px; cursor: pointer; font-size: 13px; }\n.hb-btn:hover:not(:disabled) { border-color: #7c9cff; color: #7c9cff; }\n.hb-btn:disabled { opacity: .5; cursor: default; }\n.hb-input { width: 100%; box-sizing: border-box; border: 1px solid var(--border-subtle, rgba(128,128,128,.35)); background: var(--bg-subtle, transparent); color: var(--text-primary, #e8e8e8); border-radius: 6px; padding: 5px 8px; font-size: 13px; }\n.hb-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }\n.hb-label { flex: 0 0 110px; font-size: 12px; opacity: .85; }\n.hb-msg { font-size: 12px; margin-top: 6px; color: #9db4ff; }\n.hb-warn { font-size: 12px; color: #ffb27a; }\n.hb-table { width: 100%; border-collapse: collapse; font-size: 12px; }\n.hb-table td, .hb-table th { border-bottom: 1px solid rgba(128,128,128,.2); padding: 4px 6px; text-align: left; vertical-align: top; }\n.hb-tag { display: inline-block; font-size: 11px; border-radius: 4px; padding: 0 6px; border: 1px solid rgba(128,128,128,.4); margin-right: 4px; }\n')

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
      const [ocrInfo, setOcrInfo] = React.useState(null)
      const [usage, setUsage] = React.useState(null)
      const [abilities, setAbilities] = React.useState(null)
      const [msg, setMsg] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [term, setTerm] = React.useState({ source: '', target: '' })
      const [keyInput, setKeyInput] = React.useState('')

      const refresh = async () => {
        const s = await host.call('workbench.state')
        const c = await host.call('workbench.config.get')
        const g = await host.call('workbench.glossary.list')
        setSt(s); setCfg(c); setGloss(Array.isArray(g) ? g : [])
        try { setUsage(await host.call('workbench.usage')) } catch (e) { /* 旧宿主半没有该 RPC */ }
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
        { name: 'OCR', title: '\u5bf9\u56fe\u7247/\u6f2b\u753b\u9875\u505a OCR\uff08\u672c\u5730\u5f15\u64ce\u4f18\u5148\uff09', fn: () => host.call('workbench.ocr', {}), after: (r) => setOcrInfo(r) },
        { name: '\u7ffb\u8bd1', fn: () => host.call('workbench.translate', {}), after: (r) => setPreview((r && r.preview) || []) },
        { name: '\u5bfc\u51fa', fn: () => host.call('workbench.export', { mode: 'inplace' }) },
      ]

      const saveConfig = () => {
        if (!cfg) return
        const payload = {
          root: cfg.root, apiUrl: cfg.apiUrl, model: cfg.model, visionModel: cfg.visionModel,
          targetLang: cfg.targetLang, sourceLang: cfg.sourceLang,
          rgssEncoding: cfg.rgssEncoding, krkrEncoding: cfg.krkrEncoding, iconvPath: cfg.iconvPath,
          apiChunk: parseInt(cfg.apiChunk, 10) || 40,
          ocrEngine: cfg.ocrEngine, ocrLang: cfg.ocrLang, ocrBudget: parseInt(cfg.ocrBudget, 10) || 0,
          typesetFont: cfg.typesetFont,
        }
        if (keyInput) payload.apiKey = keyInput
        run('\u4fdd\u5b58\u914d\u7f6e', () => host.call('workbench.config.set', payload), () => setKeyInput(''))
      }

      const probeMedia = () => run('\u80fd\u529b\u63a2\u6d4b', () => host.call('workbench.media.probe', {}), (r) => setAbilities(r))
      const resetUsage = () => run('\u91cd\u7f6e\u8d26\u672c', () => host.call('workbench.usage', { action: 'reset' }), (r) => setUsage(r))

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
            h(Row, null, h('label', { className: 'hb-label' }, '\u89c6\u89c9\u6a21\u578b'), h(Input, { value: cfg.visionModel || '', placeholder: 'glm-4v-flash\uff08\u56fe\u7247\u827a\u672f\u5b57\u515c\u5e95\uff09', onChange: (v) => setCfg(Object.assign({}, cfg, { visionModel: v })) })),
            h(Row, null, h('label', { className: 'hb-label' }, 'OCR \u5f15\u64ce'), h(Input, { value: cfg.ocrEngine || '', placeholder: 'auto / windows / vision / tesseract', onChange: (v) => setCfg(Object.assign({}, cfg, { ocrEngine: v })) })),
            h(Row, null, h('label', { className: 'hb-label' }, 'OCR \u8bed\u8a00'), h(Input, { value: cfg.ocrLang || '', placeholder: 'auto / zh-Hans-CN / ja-JP', onChange: (v) => setCfg(Object.assign({}, cfg, { ocrLang: v })) })),
            h(Row, null, h('label', { className: 'hb-label' }, '\u89c6\u89c9\u9884\u7b97'), h(Input, { value: cfg.ocrBudget !== undefined && cfg.ocrBudget !== null ? String(cfg.ocrBudget) : '8', placeholder: '8\uff08\u6bcf\u6b21\u6700\u591a\u51e0\u5f20\u56fe\u8d70\u89c6\u89c9\uff0c0=\u53ea\u7528\u672c\u5730\u5f15\u64ce\uff09', onChange: (v) => setCfg(Object.assign({}, cfg, { ocrBudget: v })) })),
            h(Row, null, h('label', { className: 'hb-label' }, '\u6392\u7248\u5b57\u4f53'), h(Input, { value: cfg.typesetFont || '', placeholder: '\u7559\u7a7a\u81ea\u52a8\u6311\u4e2d\u6587\u5b57\u4f53', onChange: (v) => setCfg(Object.assign({}, cfg, { typesetFont: v })) })),
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
        h(Card, { title: 'OCR\uff08\u56fe\u7247 / \u6f2b\u753b / \u827a\u672f\u5b57\uff09' },
          h('div', { className: 'hb-actions' },
            h(Btn, { label: '\u8bc6\u522b\u56fe\u7247', disabled: busy, onClick: () => run('OCR', () => host.call('workbench.ocr', {}), (r) => setOcrInfo(r)) }),
            h(Btn, { label: '\u80fd\u529b\u63a2\u6d4b', disabled: busy, onClick: probeMedia })),
          ocrInfo ? h('div', null,
            h('div', null, '\u9875\u9762 ' + (ocrInfo.summary ? ocrInfo.summary.pages : 0) + ' \u00b7 \u533a\u57df ' + (ocrInfo.summary ? ocrInfo.summary.regions : 0) + ' \u00b7 \u8bc6\u522b ' + (ocrInfo.summary ? ocrInfo.summary.recognized : 0) + ' \u00b7 \u6761\u76ee ' + (ocrInfo.summary ? ocrInfo.summary.entries : 0)),
            h('div', null, '\u672c\u5730 OCR \u547d\u4e2d ' + (ocrInfo.summary ? ocrInfo.summary.localHits : 0) + ' \u00b7 \u89c6\u89c9\u8865\u507f ' + (ocrInfo.summary ? ocrInfo.summary.visionRegions : 0) + ' \u00b7 \u9884\u7b97\u8df3\u8fc7 ' + (ocrInfo.summary ? ocrInfo.summary.visionSkipped : 0)),
            (ocrInfo.hints || []).map((t, i) => h('div', { className: 'hb-warn', key: 'h' + i }, t)),
            (ocrInfo.preview || []).slice(0, 12).map((p, i) => h('div', { key: 'o' + i }, '\u00b7 ' + (p.file || '') + (p.page ? ' [' + p.page + ']' : '') + '  ' + String(p.source || '').slice(0, 60)))) : null,
          abilities ? h('div', null,
            h('div', null, 'OS ' + abilities.os + ' \u00b7 Python ' + (abilities.python ? '\u2713' : '\u2717') + ' \u00b7 Pillow ' + (abilities.pillow || '-') + ' \u00b7 Windows OCR ' + (abilities.windowsOcr ? '\u2713 (' + (abilities.ocrLangs || []).join('/') + ')' : '\u2717') + ' \u00b7 ffmpeg ' + (abilities.ffmpeg ? '\u2713' : '\u2717') + ' \u00b7 tesseract ' + (abilities.tesseract ? '\u2713' : '\u2717')),
            (abilities.hints || []).map((t, i) => h('div', { className: 'hb-warn', key: 'a' + i }, t))) : null),
        h(Card, { title: '\u8bd1\u6587\u9884\u89c8 (' + preview.length + ')' },
          preview.length ? h('table', { className: 'hb-table' },
            h('thead', null, h('tr', null, h('th', null, '\u539f\u6587'), h('th', null, '\u8bd1\u6587'), h('th', null, '\u65b9\u5f0f'), h('th', null, 'QA'))),
            h('tbody', null, preview.map((p, i) => h('tr', { key: 'p' + i },
              h('td', null, p.source), h('td', null, p.target),
              h('td', null, h('span', { className: 'hb-tag' }, p.method)),
              h('td', null, p.warnings ? String(p.warnings) + ' \u9879' : ''))))) : h('div', null, '\u8fd8\u6ca1\u6709\u8bd1\u6587\u2014\u2014\u70b9\u51fb\u201c\u7ffb\u8bd1\u201d\u6216\u201c\u4e00\u952e\u5168\u6d41\u7a0b\u201d')),
        h(Card, { title: 'Token \u8d26\u672c' },
          h('div', { className: 'hb-actions' },
            h(Btn, { label: '\u5237\u65b0', disabled: busy, onClick: () => run('\u5237\u65b0\u8d26\u672c', () => host.call('workbench.usage', {}), (r) => setUsage(r)) }),
            h(Btn, { label: '\u91cd\u7f6e', disabled: busy, onClick: resetUsage })),
          usage && usage.usage ? h('div', null,
            h('div', null, '\u7ffb\u8bd1 API ' + usage.usage.apiCalls + ' \u6b21 \u00b7 \u8f93\u5165 ' + usage.usage.apiPromptTokens + ' \u00b7 \u8f93\u51fa ' + usage.usage.apiCompletionTokens + ' token'),
            h('div', null, '\u89c6\u89c9 OCR ' + usage.usage.visionCalls + ' \u6b21 / ' + usage.usage.visionImages + ' \u5f20 \u00b7 ' + (usage.usage.visionPromptTokens + usage.usage.visionCompletionTokens) + ' token \u00b7 \u5408\u8ba1 ' + usage.usage.totalTokens),
            h('div', null, '\u7701\u4e0b\u6765\uff1a\u8bd1\u6587\u7f13\u5b58 ' + usage.usage.saved.translationCacheHits + ' \u00b7 \u8bed\u5883\u53bb\u91cd ' + usage.usage.saved.contextDedupHits + ' \u00b7 \u65e0\u9700\u7ffb\u8bd1\u8df3\u8fc7 ' + usage.usage.saved.skippedNoTranslate + ' \u00b7 \u672c\u5730 OCR ' + usage.usage.saved.localOcrHits + ' \u00b7 OCR \u7f13\u5b58 ' + usage.usage.saved.ocrCacheHits)) : h('div', null, '\u6682\u65e0\u6570\u636e')))
    }

    slots.inject('settings.section', () => slots.register(
      { name: 'settings.section', id: 'hanhua-workbench', order: 50, label: '\u6c49\u5316\u5de5\u4f5c\u53f0' },
      () => h(Workbench),
    ))
  },
}
