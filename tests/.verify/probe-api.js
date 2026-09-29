// 探测在线 API（OpenAI 兼容）的文本与视觉（多模态）能力
const cfg = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8'))
const url = cfg.apiUrl
const key = cfg.apiKey

async function call(model, content, maxTokens) {
  const body = { model, temperature: 0.1, max_tokens: maxTokens, messages: [{ role: 'user', content }] }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, text: text.slice(0, 600) }
}

;(async () => {
  try {
    const r1 = await call(cfg.model || 'glm-4-flash', 'ping: reply with the single word pong', 8)
    console.log('TEXT', JSON.stringify(r1))
  } catch (e) { console.log('TEXT_ERR', String(e)) }
  // 1x1 红色 PNG
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  for (const m of ['glm-4v-flash', 'glm-4v-plus']) {
    try {
      const r = await call(m, [{ type: 'text', text: 'What color? one word.' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + png } }], 16)
      console.log('VISION ' + m, JSON.stringify(r))
    } catch (e) { console.log('VISION_ERR ' + m, String(e)) }
  }
})()
