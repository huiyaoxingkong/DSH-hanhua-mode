// 瑙嗚 OCR 鎺㈤拡锛氭妸鍥剧墖浜ょ粰澶氭ā鎬佹ā鍨嬶紝瑕佹眰杩斿洖 JSON锛堟枃鏈?妗嗭級
const fs = require('fs')
const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const img = process.argv[3]
const model = process.argv[4] || 'glm-4v-flash'
const b64 = fs.readFileSync(img).toString('base64')
const prompt = [
  'You are an OCR engine for manga/game images. Transcribe EVERY visible text (speech bubbles, captions, stylized/outlined art text, logos, UI).',
  'Return ONLY a JSON array. Each item: {"text":"<verbatim>","lang":"<ja|zh|en|ko|other>","style":"bubble|art|ui|caption","box":[x,y,w,h]} with box in pixels.',
  'Do not translate. Do not add commentary.',
].join('\n')
const body = {
  model, temperature: 0.1, max_tokens: 1024,
  messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + b64 } }] }],
}
;(async () => {
  const t0 = Date.now()
  const res = await fetch(cfg.apiUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey }, body: JSON.stringify(body) })
  const j = await res.json()
  console.log('status', res.status, 'ms', Date.now() - t0, 'usage', JSON.stringify(j.usage || {}))
  console.log('content:', (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || JSON.stringify(j).slice(0, 800))
})()
