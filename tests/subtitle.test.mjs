/**
 * 字幕格式库单测（engine/src/subtitle.js）
 * 重点：解析/回写**只动字幕正文**，时间轴、样式、注释、顺序、换行风格原样保留。
 * 用法：node tests/subtitle.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSubtitle, applySubtitle, detectSubtitleFormat, TAG_OPEN } from '../engine/src/subtitle.js'

const SRT = [
  '1',
  '00:00:01,000 --> 00:00:03,500',
  'Good morning, hero.',
  '',
  '2',
  '00:00:04,000 --> 00:00:07,200',
  'The dragon has returned',
  'to the valley.',
  '',
].join('\r\n')

const VTT = [
  'WEBVTT',
  '',
  'NOTE keep me',
  '',
  'cue-7',
  '00:00:01.000 --> 00:00:03.000 align:start',
  'Welcome to the hamlet.',
  '',
  '00:00:03.500 --> 00:00:06.000',
  'Take this blade, <b>hero</b>.',
  '',
].join('\n')

const ASS = [
  '[Script Info]',
  'ScriptType: v4.00+',
  '',
  '[V4+ Styles]',
  'Format: Name, Fontname, Fontsize, PrimaryColour',
  'Style: Default,Arial,48,&H00FFFFFF',
  '',
  '[Events]',
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  'Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\an8}The dragon sleeps here.',
  'Dialogue: 0,0:00:03.50,0:00:06.00,Default,,0,0,0,,{\\pos(640,600)}Draw your blade,\\Nbrave one.',
  'Comment: 0,0:00:07.00,0:00:09.00,Default,,0,0,0,,do not translate me',
  '',
].join('\n')

const LRC = '[00:01.00]First line\n[00:04.50]Second line\n'

test('SRT：解析出 2 条（多行正文合成一条），时间轴换行风格保留', () => {
  const r = parseSubtitle(SRT, 'srt')
  assert.equal(r.format, 'srt')
  assert.equal(r.entries.length, 2)
  assert.equal(r.entries[0].startMs, 1000)
  assert.equal(r.entries[0].endMs, 3500)
  assert.equal(r.entries[1].text, 'The dragon has returned\nto the valley.')
})

test('SRT：无补丁时回写等于原文（逐字节）', () => {
  const r = parseSubtitle(SRT, 'srt')
  assert.equal(applySubtitle(SRT, []), SRT)
  void r
})

test('SRT：只替换正文，时间轴/序号/CRLF 全部保留', () => {
  const r = parseSubtitle(SRT, 'srt')
  const out = applySubtitle(SRT, [
    { ref: r.entries[0].ref, target: '早上好，勇者。' },
    { ref: r.entries[1].ref, target: '巨龙已经归来\n来到山谷。' },
  ])
  assert.ok(out.includes('00:00:01,000 --> 00:00:03,500'))
  assert.ok(out.includes('早上好，勇者。'))
  assert.ok(out.includes('巨龙已经归来\n来到山谷。'))
  assert.ok(!out.includes('Good morning'))
  assert.ok(out.includes('\r\n'), 'CRLF 风格应保留')
  assert.equal(out.split('1\r\n00:00:01').length, 2)
})

test('VTT：NOTE 与 cue id 保留，正文替换且不吞内联标签', () => {
  const r = parseSubtitle(VTT, 'vtt')
  assert.equal(r.format, 'vtt')
  const out = applySubtitle(VTT, r.entries.map((e) => ({ ref: e.ref, target: e.text.replace('Welcome to the hamlet.', '欢迎来到小村。').replace('Take this blade, <b>hero</b>.', '拿着这把剑，<b>勇者</b>。') })))
  assert.ok(out.startsWith('WEBVTT\n\nNOTE keep me\n\ncue-7\n'))
  assert.ok(out.includes('欢迎来到小村。'))
  assert.ok(out.includes('拿着这把剑，<b>勇者</b>。'))
})

test('ASS：标签变成 ⟦n⟧ 占位符，回写时还原，Comment/样式/Format 不动', () => {
  const r = parseSubtitle(ASS, 'ass')
  assert.equal(r.format, 'ass')
  assert.equal(r.entries.length, 2, 'Comment 行不产出条目')
  assert.ok(r.entries[0].text.includes(TAG_OPEN), '标签应被占位符保护: ' + r.entries[0].text)
  assert.ok(!r.entries[0].text.includes('{\\an8}'))
  const out = applySubtitle(ASS, [
    { ref: r.entries[0].ref, target: r.entries[0].text.replace('The dragon sleeps here.', '巨龙在此沉睡。'), tokens: r.entries[0].tokens },
    { ref: r.entries[1].ref, target: r.entries[1].text.replace('Draw your blade,', '拔出你的剑，').replace('brave one.', '勇敢的人。'), tokens: r.entries[1].tokens },
  ])
  assert.ok(out.includes('{\\an8}巨龙在此沉睡。'), out.split('\n').filter((l) => l.startsWith('Dialogue')).join(' | '))
  assert.ok(out.includes('{\\pos(640,600)}拔出你的剑，\\N勇敢的人。'))
  assert.ok(out.includes('Comment: 0,0:00:07.00,0:00:09.00,Default,,0,0,0,,do not translate me'))
  assert.ok(out.includes('Style: Default,Arial,48,&H00FFFFFF'))
  assert.ok(out.includes('ScriptType: v4.00+'))
})

test('LRC：只替换时间标签后的正文', () => {
  const r = parseSubtitle(LRC, 'lrc')
  assert.equal(r.entries.length, 2)
  const out = applySubtitle(LRC, [{ ref: r.entries[0].ref, target: '第一行' }])
  assert.ok(out.includes('[00:01.00]第一行'))
  assert.ok(out.includes('[00:04.50]Second line'))
})

test('MicroDVD / SAMI：能解析出正文（尽力而为）', () => {
  const sub = '{0}{25}Hello there|second line\n{26}{50}Bye\n'
  const rs = parseSubtitle(sub, 'sub', { fps: 25 })
  assert.equal(rs.entries.length, 2)
  assert.equal(rs.entries[0].text, 'Hello there\nsecond line')
  assert.equal(rs.entries[0].startMs, 0)
  const out = applySubtitle(sub, [{ ref: rs.entries[1].ref, target: '再见' }])
  assert.ok(out.includes('{26}{50}再见'))

  const smi = '<SAMI>\n<BODY>\n<SYNC Start=1000><P Class=ENCC>Hello world<BR>line two\n<SYNC Start=4000><P Class=ENCC>&nbsp;\n</BODY>\n</SAMI>\n'
  const rs2 = parseSubtitle(smi, 'smi')
  assert.ok(rs2.entries.length >= 1)
  assert.ok(rs2.entries[0].text.includes('Hello world'))
})

test('格式探测：按扩展名与内容特征判断', () => {
  assert.equal(detectSubtitleFormat('srt', ''), 'srt')
  assert.equal(detectSubtitleFormat('', VTT), 'vtt')
  assert.equal(detectSubtitleFormat('', ASS), 'ass')
  assert.equal(detectSubtitleFormat('', LRC), 'lrc')
  assert.equal(detectSubtitleFormat('', '{0}{1}hi'), 'sub')
  assert.equal(detectSubtitleFormat('', '<SAMI><SYNC Start=1>'), 'smi')
})
