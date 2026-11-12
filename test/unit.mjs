// 单元测试：解析 / 后处理 / 文件名 / 模板
// 运行：node --test test/unit.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseJson3, parseXml, parseBilibili, parseAuto } from '../extension/lib/parser.js';
import { toParagraphs, dedupe, formatDuration } from '../extension/lib/postprocess.js';
import { toFilename } from '../extension/lib/filename.js';
import { buildTxt } from '../extension/lib/template.js';

// ---------- 真实格式样本 ----------

const YT_JSON3 = JSON.stringify({
  wireMagic: 'pb3',
  events: [
    { tStartMs: 0, dDurationMs: 1200, segs: [{ utf8: '大家好' }] },
    { tStartMs: 1200, dDurationMs: 2000, segs: [{ utf8: '今天聊聊字幕导出' }] },
    { tStartMs: 3200, dDurationMs: 1800, segs: [{ utf8: '先从难点说起' }] },
  ],
});

// YouTube 自动字幕的滚动重复：后一条包含前一条
const YT_JSON3_ROLLING = JSON.stringify({
  events: [
    { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'this is' }] },
    { tStartMs: 1000, dDurationMs: 1000, segs: [{ utf8: 'this is a test' }] },
    { tStartMs: 2000, dDurationMs: 1000, segs: [{ utf8: 'a test of the system' }] },
  ],
});

const BILI_BODY = JSON.stringify({
  font_size: 0.4,
  body: [
    { from: 1.2, to: 3.4, content: '第一句字幕' },
    { from: 3.4, to: 6.0, content: '第二句字幕' },
  ],
});

const SRV3_XML =
  '<timedtext format="3"><body>' +
  '<p t="0" d="1500"><s>hello </s><s>world</s></p>' +
  '<p t="1500" d="2000">second line</p>' +
  '</body></timedtext>';

const LEGACY_XML =
  '<transcript><text start="0.5" dur="1.5">legacy one</text>' +
  '<text start="2.0" dur="1.0">legacy two</text></transcript>';

// ---------- parser ----------

test('parseJson3：基本解析', () => {
  const s = parseJson3(YT_JSON3);
  assert.equal(s.length, 3);
  assert.equal(s[0].text, '大家好');
  assert.equal(s[0].start, 0);
  assert.equal(s[1].start, 1.2);
});

test('parseBilibili：基本解析', () => {
  const s = parseBilibili(BILI_BODY);
  assert.equal(s.length, 2);
  assert.equal(s[0].text, '第一句字幕');
  assert.equal(s[0].start, 1.2);
  assert.equal(s[1].end, 6.0);
});

test('parseXml：srv3 格式', () => {
  const s = parseXml(SRV3_XML);
  assert.equal(s.length, 2);
  assert.equal(s[0].text, 'hello world');
  assert.equal(s[0].start, 0);
  assert.equal(s[1].start, 1.5);
});

test('parseXml：旧版 text 格式', () => {
  const s = parseXml(LEGACY_XML);
  assert.equal(s.length, 2);
  assert.equal(s[0].text, 'legacy one');
  assert.equal(s[0].start, 0.5);
});

test('parseAuto：自动识别格式', () => {
  assert.equal(parseAuto(YT_JSON3).length, 3);
  assert.equal(parseAuto(BILI_BODY).length, 2);
  assert.equal(parseAuto(SRV3_XML).length, 2);
});

test('parseAuto：空输入返回空数组', () => {
  assert.deepEqual(parseAuto(''), []);
  assert.deepEqual(parseAuto(null), []);
  assert.deepEqual(parseAuto('随便一段没有格式的文本'), []);
});

// ---------- postprocess ----------

test('dedupe：去掉滚动字幕的重复', () => {
  const input = parseJson3(YT_JSON3_ROLLING);
  const out = dedupe(input);
  // "this is" 被 "this is a test" 覆盖，"a test of the system" 保留
  assert.ok(out.length <= 3);
  assert.equal(out[out.length - 1].text, 'a test of the system');
});

test('toParagraphs：中文句子合并成段', () => {
  const s = parseJson3(YT_JSON3);
  const paras = toParagraphs(s);
  assert.ok(paras.length >= 1);
  assert.ok(paras[0].includes('大家好'));
  assert.ok(paras.join('').includes('先从难点说起'));
});

test('toParagraphs：大间隔强制分段', () => {
  const s = [
    { start: 0, end: 2, text: '前面这句' },
    { start: 30, end: 32, text: '很久之后这句' },
  ];
  const paras = toParagraphs(s);
  assert.equal(paras.length, 2);
  assert.equal(paras[0], '前面这句');
  assert.equal(paras[1], '很久之后这句');
});

test('toParagraphs：空输入', () => {
  assert.deepEqual(toParagraphs([]), []);
  assert.deepEqual(toParagraphs(null), []);
});

test('formatDuration：分秒与时分秒', () => {
  assert.equal(formatDuration(65), '1:05');
  assert.equal(formatDuration(3665), '1:01:05');
  assert.equal(formatDuration(0), '0:00');
});

// ---------- filename ----------

test('toFilename：替换 Windows 非法字符', () => {
  assert.equal(toFilename('a/b:c*d?e"f<g>h|i'), 'a_b_c_d_e_f_g_h_i');
});

test('toFilename：中文标题保持原样', () => {
  assert.equal(toFilename('【教程】如何搭建 RAG 系统'), '【教程】如何搭建 RAG 系统');
});

test('toFilename：空标题兜底', () => {
  assert.equal(toFilename(''), '未命名视频');
  assert.equal(toFilename(null), '未命名视频');
  assert.equal(toFilename('   '), '未命名视频');
});

test('toFilename：超长按字节截断', () => {
  const long = '中'.repeat(300);
  const out = toFilename(long, 200);
  assert.ok(new TextEncoder().encode(out).length <= 200);
  assert.ok(out.length > 0);
});

test('toFilename：Windows 保留名', () => {
  assert.equal(toFilename('CON'), '_CON');
  assert.equal(toFilename('nul'), '_nul');
});

// ---------- template ----------

test('buildTxt：带元信息头', () => {
  const txt = buildTxt(
    {
      title: '测试视频',
      url: 'https://example.com/v/1',
      author: '张三',
      lang: 'zh',
      source: 'AI 字幕（平台 ASR）',
      duration: 125,
    },
    ['第一段', '第二段'],
    true
  );
  assert.ok(txt.includes('标题：测试视频'));
  assert.ok(txt.includes('时长：2:05'));
  assert.ok(txt.includes('字幕来源：AI 字幕（平台 ASR）'));
  assert.ok(txt.includes('第一段\n\n第二段'));
});

test('buildTxt：不带元信息头', () => {
  const txt = buildTxt({ title: 'x' }, ['只有正文'], false);
  assert.ok(!txt.includes('标题：'));
  assert.ok(txt.startsWith('只有正文'));
});
