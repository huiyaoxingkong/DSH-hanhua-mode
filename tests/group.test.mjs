/**
 * 图片字体分组单测（engine/src/group.js）
 * 覆盖两条规则（atlas / sequence）的关键边界：分行重叠、词组间隙、高度比、序号连续性、
 * 拼接分隔符，以及脏数据、确定性、不修改入参。
 * 用法：node tests/group.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupImageFonts, groupParseIndexName, groupSplitFileName, GROUP_DEFAULT_OPTIONS } from '../engine/src/group.js'

// 造一条 OCR 碎片；box 是图内坐标 [x, y, w, h]
const mk = (id, file, box, text, extra) => Object.assign({
  id, file, page: null, pageEntry: null, box, text, kind: 'text', engine: 'ocr-local', ink: 0.2,
}, extra || {})

const ids = (list) => list.map((m) => m.id)

test('默认选项：缺省即可用', () => {
  assert.deepEqual(GROUP_DEFAULT_OPTIONS, { mode: 'auto', minParts: 2, sameLineOverlap: 0.5, phraseGap: 2.5, maxHeightRatio: 2.5, indexStrip: true })
})

test('规则 1 · atlas 成组：同一张图同一行的 4 个碎片合成一个词组', () => {
  const at = { page: 3, pageEntry: 'ui_menu' }
  const items = [
    mk('a1', 'ui/menu.png', [100, 200, 60, 40], 'New', at),
    mk('a2', 'ui/menu.png', [166, 200, 70, 40], 'Ga', at),
    mk('a3', 'ui/menu.png', [244, 200, 60, 40], 'me', at),
    mk('a4', 'ui/menu.png', [312, 200, 80, 40], '', at),      // 空文本成员照样参与
  ]
  const r = groupImageFonts(items)
  assert.equal(r.groups.length, 1)
  const g = r.groups[0]
  assert.equal(g.kind, 'atlas')
  assert.deepEqual(ids(g.members), ['a1', 'a2', 'a3', 'a4'])   // 左 → 右（不是传入顺序）
  for (let i = 0; i < items.length; i++) assert.equal(g.members[i], items[i], 'members 保持原对象引用')
  assert.deepEqual(g.boxes, [[100, 200, 60, 40], [166, 200, 70, 40], [244, 200, 60, 40], [312, 200, 80, 40]])
  assert.deepEqual(g.unionBox, [100, 200, 292, 40])           // 并集 = x1,y1 → x2=392,y2=240
  assert.equal(g.anchorIndex, 0)
  assert.equal(g.file, 'ui/menu.png')
  assert.equal(g.page, 3)
  assert.equal(g.pageEntry, 'ui_menu')
  assert.equal(g.joinSeparator, ' ')
  assert.equal(g.naiveSource, 'New Ga me')                    // 空文本跳过，拉丁之间补空格
  assert.equal(g.id, 'g:a1+4')
  assert.deepEqual(r.singles, [])
  assert.deepEqual(r.stats, { input: 4, grouped: 4, groups: 1, singles: 0, byKind: { atlas: 1, sequence: 0 } })
})

test('规则 1 · 词组切分：段内间隙 6px、段间间隙 200px → 同一行切成两个组', () => {
  const at = { page: 0, pageEntry: 'lbl' }
  const items = [
    mk('b1', 'ui/hud.png', [100, 100, 60, 40], 'HP', at),
    mk('b2', 'ui/hud.png', [166, 100, 60, 40], 'MAX', at),     // 间隙 6 ≤ 2.5×40=100 → 同段
    mk('b3', 'ui/hud.png', [426, 100, 60, 40], 'MP', at),      // 间隙 200 > 100 → 断段
    mk('b4', 'ui/hud.png', [492, 100, 60, 40], 'MIN', at),     // 间隙 6 → 同段
  ]
  const r = groupImageFonts(items)
  assert.deepEqual(r.groups.map((g) => ids(g.members)), [['b1', 'b2'], ['b3', 'b4']])
  assert.deepEqual(r.groups.map((g) => g.unionBox), [[100, 100, 126, 40], [426, 100, 126, 40]])
  assert.deepEqual(r.groups.map((g) => g.naiveSource), ['HP MAX', 'MP MIN'])
  assert.equal(r.singles.length, 0)
  assert.equal(r.stats.byKind.atlas, 2)
})

test('规则 1 · 不同行不混：上下两行各成一组', () => {
  const at = { page: 1, pageEntry: 'p1' }
  const items = [
    mk('c1', 'ui/menu.png', [100, 100, 60, 40], 'New', at),
    mk('c2', 'ui/menu.png', [166, 100, 60, 40], 'Game', at),
    mk('c3', 'ui/menu.png', [100, 300, 60, 40], 'Load', at),
    mk('c4', 'ui/menu.png', [166, 300, 60, 40], 'Save', at),
  ]
  const r = groupImageFonts(items)
  assert.deepEqual(r.groups.map((g) => ids(g.members)), [['c1', 'c2'], ['c3', 'c4']])
  assert.deepEqual(r.groups.map((g) => g.unionBox[1]), [100, 300])
})

test('规则 1 · 高度差异过大不成组：120px 标题块不在任何组里，正文行照常成组', () => {
  const at = { page: 2, pageEntry: 'hud' }
  const items = [
    mk('d1', 'ui/hud.png', [40, 100, 300, 120], 'TITLE', at),  // 120/40 = 3 > maxHeightRatio
    mk('d2', 'ui/hud.png', [400, 100, 60, 40], 'Go', at),
    mk('d3', 'ui/hud.png', [466, 100, 60, 40], 'On', at),
  ]
  const r = groupImageFonts(items)
  assert.deepEqual(r.groups.map((g) => ids(g.members)), [['d2', 'd3']])
  const inGroup = new Set(r.groups.flatMap((g) => ids(g.members)))
  assert.ok(!inGroup.has('d1'), '标题块不能在任何一个组里')
  assert.deepEqual(ids(r.singles), ['d1'])
})

test('规则 2 · sequence 成组：btn_newgame_0..3.png 按序号排序、全拉丁用空格拼', () => {
  const items = [
    mk('e1', 'ui/btn_newgame_1.png', [10, 20, 40, 30], 'Ga'),
    mk('e0', 'ui/btn_newgame_0.png', [10, 20, 40, 30], 'New'),
    mk('e3', 'ui/btn_newgame_3.png', [10, 20, 40, 30], ''),
    mk('e2', 'ui/btn_newgame_2.png', [10, 20, 40, 30], 'me'),
  ]
  const r = groupImageFonts(items)
  assert.equal(r.groups.length, 1)
  const g = r.groups[0]
  assert.equal(g.kind, 'sequence')
  assert.deepEqual(ids(g.members), ['e0', 'e1', 'e2', 'e3'])   // 按序号升序，与传入顺序无关
  assert.deepEqual(g.boxes, [[10, 20, 40, 30], [10, 20, 40, 30], [10, 20, 40, 30], [10, 20, 40, 30]])
  assert.equal(g.file, 'ui/btn_newgame_0.png')                // file 取第一个成员
  assert.equal(g.page, null)
  assert.equal(g.pageEntry, null)
  assert.deepEqual(g.unionBox, [10, 20, 40, 30])              // 锚点框 = members[0].box
  assert.equal(g.anchorIndex, 0)
  assert.equal(g.joinSeparator, ' ')
  assert.equal(g.naiveSource, 'New Ga me')
  assert.equal(g.id, 'g:e0+4')
  assert.deepEqual(r.stats, { input: 4, grouped: 4, groups: 1, singles: 0, byKind: { atlas: 0, sequence: 1 } })
})

test('规则 2 · 序号不连续则拆段', () => {
  const r = groupImageFonts([
    mk('f1', 'fx/a_1.png', [0, 0, 20, 20], 'A'),
    mk('f2', 'fx/a_2.png', [0, 0, 20, 20], 'B'),
    mk('f4', 'fx/a_4.png', [0, 0, 20, 20], 'D'),
    mk('f5', 'fx/a_5.png', [0, 0, 20, 20], 'E'),
  ])
  assert.deepEqual(r.groups.map((g) => ids(g.members)), [['f1', 'f2'], ['f4', 'f5']])
  assert.deepEqual(r.singles, [])

  const r2 = groupImageFonts([            // 3,5,6 → 3 落 singles，[5,6] 成组
    mk('h3', 'fx/b_3.png', [0, 0, 20, 20], 'X'),
    mk('h5', 'fx/b_5.png', [0, 0, 20, 20], 'Y'),
    mk('h6', 'fx/b_6.png', [0, 0, 20, 20], 'Z'),
  ])
  assert.deepEqual(r2.groups.map((g) => ids(g.members)), [['h5', 'h6']])
  assert.deepEqual(ids(r2.singles), ['h3'])

  const r3 = groupImageFonts([            // 连续段可以从任意起点开始：7,8,9 成组
    mk('k7', 'fx/c_7.png', [0, 0, 20, 20], 'P'),
    mk('k8', 'fx/c_8.png', [0, 0, 20, 20], 'Q'),
    mk('k9', 'fx/c_9.png', [0, 0, 20, 20], 'R'),
  ])
  assert.deepEqual(r3.groups.map((g) => ids(g.members)), [['k7', 'k8', 'k9']])
})

test('规则 2 · CJK 分隔符：碎片为「新」「游」「戏」→ 空串拼接', () => {
  const items = [
    mk('g0', 'fx2/cn_0.png', [0, 0, 32, 32], '新'),
    mk('g1', 'fx2/cn_1.png', [0, 0, 32, 32], '游'),
    mk('g2', 'fx2/cn_2.png', [0, 0, 32, 32], '戏'),
  ]
  const r = groupImageFonts(items)
  assert.equal(r.groups.length, 1)
  assert.equal(r.groups[0].joinSeparator, '')
  assert.equal(r.groups[0].naiveSource, '新游戏')
})

test('规则 2 · 文件名里没有序号的小图绝不入组', () => {
  const items = [
    mk('t', 'ui/title.png', [0, 0, 80, 24], 'Title'),
    mk('l', 'ui/logo.png', [0, 0, 80, 24], 'Logo'),
    mk('b', 'ui/bg.png', [0, 0, 80, 24], ''),
  ]
  const r = groupImageFonts(items)
  assert.deepEqual(r.groups, [])
  assert.deepEqual(ids(r.singles), ['b', 'l', 't'])           // singles 也按稳定键（file）排序
  assert.deepEqual(r.stats, { input: 3, grouped: 0, groups: 0, singles: 3, byKind: { atlas: 0, sequence: 0 } })
})

test('规则 2 · kind 必须一致：text/art 混排的同序号段不成组', () => {
  const r = groupImageFonts([
    mk('m0', 'kx/k_0.png', [0, 0, 20, 20], 'A', { kind: 'text' }),
    mk('m1', 'kx/k_1.png', [0, 0, 20, 20], 'B', { kind: 'art' }),
    mk('m2', 'kx/k_2.png', [0, 0, 20, 20], 'C', { kind: 'text' }),
  ])
  assert.deepEqual(r.groups, [])                              // 按 kind 切开后：text=[0,2] 不连续，art 只有 1 个
  assert.equal(r.singles.length, 3)
})

test('规则 2 · page 非 null 的小图不参与序号组（独立小图必须 page:null）', () => {
  const r = groupImageFonts([
    mk('n0', 'ui/ic_0.png', [0, 0, 20, 20], 'A', { page: 0 }),
    mk('n1', 'ui/ic_1.png', [0, 0, 20, 20], 'B', { page: 0 }),
  ])
  assert.deepEqual(r.groups, [])
  assert.equal(r.singles.length, 2)
})

test('mode:auto · atlas 优先：同图碎片先成组，剩下的独立小图再走序号规则', () => {
  const items = [
    mk('u0', 'ui/btn_0.png', [10, 10, 30, 30], 'Go'),
    mk('u1', 'ui/btn_0.png', [46, 10, 30, 30], 'On'),          // 同一张图同一行 → atlas
    mk('u2', 'ui/btn_1.png', [10, 10, 30, 30], 'Now'),
    mk('u3', 'ui/btn_2.png', [10, 10, 30, 30], 'End'),
  ]
  const r = groupImageFonts(items)
  assert.deepEqual(r.groups.map((g) => g.kind), ['atlas', 'sequence'])
  assert.deepEqual(ids(r.groups[0].members), ['u0', 'u1'])
  assert.deepEqual(ids(r.groups[1].members), ['u2', 'u3'])
  assert.deepEqual(r.stats, { input: 4, grouped: 4, groups: 2, singles: 0, byKind: { atlas: 1, sequence: 1 } })
})

test('minParts / mode:none / mode:filename / 空输入', () => {
  const at = { page: 3, pageEntry: 'ui_menu' }
  const items = [
    mk('s1', 'ui/menu.png', [100, 200, 60, 40], 'New', at),
    mk('s2', 'ui/menu.png', [166, 200, 70, 40], 'Ga', at),
    mk('s3', 'ui/menu.png', [244, 200, 60, 40], 'me', at),
    mk('s4', 'ui/menu.png', [312, 200, 80, 40], '', at),
  ]
  const r = groupImageFonts(items, { minParts: 5 })
  assert.deepEqual(r.groups, [])
  assert.equal(r.singles.length, 4)
  assert.deepEqual(r.stats, { input: 4, grouped: 0, groups: 0, singles: 4, byKind: { atlas: 0, sequence: 0 } })

  const none = groupImageFonts(items, { mode: 'none' })
  assert.deepEqual(none.groups, [])
  assert.equal(none.singles[0], items[0], 'mode:none 时 singles 原样返回（同引用、保持传入顺序）')

  const byName = groupImageFonts(items, { mode: 'filename' })
  assert.deepEqual(byName.groups, [], 'mode:filename 时 atlas 规则不跑')
  assert.equal(byName.singles.length, 4)

  assert.deepEqual(groupImageFonts([]), { groups: [], singles: [], stats: { input: 0, grouped: 0, groups: 0, singles: 0, byKind: { atlas: 0, sequence: 0 } } })
  assert.deepEqual(groupImageFonts(null).groups, [])
  assert.deepEqual(groupImageFonts(undefined, { mode: 'none' }).singles, [])
})

test('脏数据：box 不是 4 个数、text 为 null、file 为空 → 不抛异常，全部落 singles', () => {
  const base = { page: null, pageEntry: null, kind: 'text', engine: 'e', ink: 0 }
  const items = [
    Object.assign({ id: 'x1', file: 'a.png', box: [1, 2], text: 'ok' }, base),
    Object.assign({ id: 'x2', file: 'a.png', box: [0, 0, 10, 10], text: null }, base),
    Object.assign({ id: 'x3', file: '', box: [0, 0, 10, 10], text: 'ok' }, base),
    Object.assign({ id: 'x4', file: 'a.png', box: [0, 0, 0, 10], text: 'ok' }, base),   // 宽为 0
    null,
    Object.assign({ id: 'x6', file: 'a.png', box: [0, 0, 10, 10], text: 'ok' }, base),   // 唯一合法的一条，单独也成不了组
  ]
  const r = groupImageFonts(items)                            // 不抛异常
  assert.deepEqual(r.groups, [])
  assert.deepEqual(r.singles.map((m) => (m ? m.id : null)).sort(), ['x1', 'x2', 'x3', 'x4', 'x6', null].sort())
  assert.deepEqual(r.stats, { input: 6, grouped: 0, groups: 0, singles: 6, byKind: { atlas: 0, sequence: 0 } })
})

test('确定性 + 不可变：打乱输入两次调用结果一致，且不改入参', () => {
  const at = { page: 3, pageEntry: 'm' }
  const items = [
    mk('p1', 'ui/menu.png', [100, 200, 60, 40], 'New', at),
    mk('p2', 'ui/menu.png', [166, 200, 70, 40], 'Ga', at),
    mk('q0', 'sq/word_0.png', [5, 5, 30, 30], 'He'),
    mk('q1', 'sq/word_1.png', [5, 5, 30, 30], 'llo'),
    mk('bad', '', [0, 0, 4, 4], 'x'),                         // 脏数据也要有稳定位置
    Object.assign({ id: 'nul', file: 'ui/menu.png', box: [1, 2], text: 'y' }, at),
  ]
  const before = JSON.stringify(items)
  const a = groupImageFonts(items)
  const b = groupImageFonts([items[4], items[2], items[0], items[5], items[3], items[1]])
  assert.equal(JSON.stringify(items), before, '不得修改传入的 items')
  assert.equal(JSON.stringify(a), JSON.stringify(b), '同一批碎片换顺序传进来，结果必须一致')
  assert.ok(a.groups.length >= 2)
  assert.equal(a.stats.input, 6)
  assert.equal(a.stats.singles, 2)
})

test('文件名解析：结尾序号（前导零/括号/空格）与「没有序号」的区分', () => {
  assert.deepEqual(groupParseIndexName('btn_newgame_0', true), { stem: 'btn_newgame', index: 0 })
  assert.deepEqual(groupParseIndexName('btn_newgame_04', true), { stem: 'btn_newgame', index: 4 })
  assert.deepEqual(groupParseIndexName('word-1', true), { stem: 'word', index: 1 })
  assert.deepEqual(groupParseIndexName('word 2', true), { stem: 'word', index: 2 })
  assert.deepEqual(groupParseIndexName('word(3)', true), { stem: 'word', index: 3 })
  assert.equal(groupParseIndexName('title', true), null)
  assert.equal(groupParseIndexName('level2', true), null, '没有分隔符的尾数字不是序号')
  assert.equal(groupParseIndexName('bg', true), null)
  assert.equal(groupParseIndexName('word_2', false), null, 'indexStrip:false 时不剥序号')
  assert.deepEqual(groupSplitFileName('a\\b\\c_1.png'), { dir: 'a/b', base: 'c_1.png', name: 'c_1' })
  assert.deepEqual(groupSplitFileName('c_1.png'), { dir: '', base: 'c_1.png', name: 'c_1' })
  assert.deepEqual(groupSplitFileName('c_1'), { dir: '', base: 'c_1', name: 'c_1' })
})
