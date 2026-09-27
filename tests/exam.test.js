const test = require('node:test');
const assert = require('node:assert/strict');
const exam = require('../extension/exam.js');

function question(kind, stem, options) {
  const selected = new Set();
  const labels = Object.keys(options).map((key) => ({
    textContent: key === '对' || key === '错' ? key : `${key}. ${options[key]}`,
    get innerText() { return this.textContent; },
    querySelector: () => ({ get checked() { return selected.has(key); } }),
    getAttribute: () => null,
    getBoundingClientRect: () => ({ width: 1, height: 1 }),
    click() { if (kind === 'multiple') selected.has(key) ? selected.delete(key) : selected.add(key);
      else { selected.clear(); selected.add(key); } },
  }));
  return { kind, stem, options, labels, selected };
}

test('matches stored answers by full stem and option text even when letters move', async () => {
  const current = question('multiple', '安全操作？', { A: '戴手套', B: '戴护目镜', C: '不防护' });
  const records = { a: { kind: 'multiple', stem: '安全操作？',
    options: { A: '戴护目镜', B: '不防护', C: '戴手套' }, correct: ['A', 'C'] } };
  const view = { location: { href: 'https://labsafe.lzjtu.edu.cn/lab-study-front/exam/test' } };
  const result = await exam.fillCurrentPage({}, view, records, { parse: () => [current], wait: async () => {} });
  assert.deepEqual([...current.selected].sort(), ['A', 'B']);
  assert.deepEqual(result, { visible: 1, matched: 1, filled: 1, skipped: 0 });
});

test('skips unknown and contradictory answers without clicking', async () => {
  const current = question('single', '哪一项正确？', { A: '左', B: '右' });
  const view = { location: { href: 'exam' } };
  const records = {
    a: { kind: 'single', stem: current.stem, options: current.options, correct: ['A'] },
    b: { kind: 'single', stem: current.stem, options: current.options, correct: ['B'] },
  };
  const result = await exam.fillCurrentPage({}, view, records, { parse: () => [current], wait: async () => {} });
  assert.equal(current.selected.size, 0);
  assert.equal(result.skipped, 1);
});

test('fills judgment answer from the matching stored question', async () => {
  const current = question('judgment', '应关闭电源。', { A: '对', B: '错' });
  const records = { a: { kind: 'judgment', stem: current.stem,
    options: { 对: '对', 错: '错' }, correct: ['对'] } };
  const result = await exam.fillCurrentPage({}, { location: { href: 'exam' } }, records,
    { parse: () => [current], wait: async () => {} });
  assert.deepEqual([...current.selected], ['A']);
  assert.equal(result.filled, 1);
});

test('refuses to change a question with an already selected conflicting answer', async () => {
  const current = question('multiple', '安全操作？', { A: '戴手套', B: '戴护目镜', C: '不防护' });
  current.selected.add('C');
  const records = { a: { kind: 'multiple', stem: current.stem,
    options: current.options, correct: ['A', 'B'] } };
  const result = await exam.fillCurrentPage({}, { location: { href: 'exam' } }, records,
    { parse: () => [current], wait: async () => {} });
  assert.deepEqual([...current.selected], ['C']);
  assert.equal(result.skipped, 1);
});

test('parses the observed exam item with number, kind, and score before its stem', () => {
  const visible = { getAttribute: () => null, getBoundingClientRect: () => ({ width: 10, height: 10 }) };
  const labels = ['对', '错'].map((value) => ({ ...visible, textContent: value }));
  const title = { textContent: '1. 判断题 （1分） 不论误食酸或碱，都可以灌注牛奶。' };
  const item = { ...visible, querySelector: () => title, querySelectorAll: () => labels };
  const document = { querySelectorAll: () => [item] };
  const parsed = exam.examQuestions(document, {});
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].kind, 'judgment');
  assert.equal(parsed[0].stem, '不论误食酸或碱,都可以灌注牛奶。');
  assert.deepEqual(parsed[0].options, { 对: '对', 错: '错' });
});

test('manual exam action advances through pages and never clicks submit', async () => {
  const pages = [question('judgment', '第一题。', { 对: '对', 错: '错' }),
    question('single', '第二题？', { A: '甲', B: '乙' })];
  const records = {
    a: { kind: 'judgment', stem: '第一题。', options: { 对: '对', 错: '错' }, correct: ['对'] },
    b: { kind: 'single', stem: '第二题？', options: { A: '甲', B: '乙' }, correct: ['B'] },
  };
  let page = 0;
  let nextClicks = 0;
  const result = await exam.fillForward({}, { location: { href: 'exam' } }, records, {
    parse: () => [pages[page]], wait: async () => {},
    next: () => page === 0 ? { click() { page = 1; nextClicks += 1; } } : null,
  });
  assert.equal(nextClicks, 1);
  assert.deepEqual([...pages[0].selected], ['对']);
  assert.deepEqual([...pages[1].selected], ['B']);
  assert.equal(result.pages, 2);
  assert.equal(result.filled, 2);
});

test('unchanged next page stops instead of looping indefinitely', async () => {
  const current = question('single', '第一题？', { A: '甲', B: '乙' });
  let clicks = 0;
  const result = await exam.fillForward({}, { location: { href: 'exam' } }, {}, {
    parse: () => [current], wait: async () => {}, next: () => ({ click() { clicks += 1; } }),
  });
  assert.equal(clicks, 1);
  assert.match(result.stoppedReason, /未变化/);
});
