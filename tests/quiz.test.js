const test = require('node:test');
const assert = require('node:assert/strict');
const quiz = require('../extension/quiz.js');
const { StudyController } = require('../extension/content.js');

test('practice route excludes assessment pages', () => {
  assert.equal(quiz.isPracticeUrl('https://labsafe.lzjtu.edu.cn/lab-study-front/questionBank/exercises/34?practiseSubjectType=1'), true);
  assert.equal(quiz.isPracticeUrl('https://labsafe.lzjtu.edu.cn/lab-study-front/examTask/34'), false);
  assert.equal(quiz.isPracticeUrl('https://other.test/lab-study-front/questionBank/exercises/34'), false);
});

test('single and multiple answer feedback is parsed without confusing my answer', () => {
  assert.deepEqual(quiz.parseAnswer('正确答案：B 我的答案：A'), ['B']);
  assert.deepEqual(quiz.parseAnswer('正确答案：C 我的答案：A,B'), ['C']);
  assert.deepEqual(quiz.parseAnswer('正确答案：A、C、D 我的答案：B'), ['A', 'C', 'D']);
  assert.equal(quiz.parseAnswer('我的答案：A,B'), null);
});

test('question identity stays stable across question numbering and whitespace', () => {
  const a = quiz.questionKey('化学安全题库', ' 贮存易燃易爆，强氧化性物质时，最高温度不能高于（） ');
  const b = quiz.questionKey('化学安全题库', '贮存易燃易爆，强氧化性物质时，最高温度不能高于（）');
  assert.equal(a, b);
  assert.notEqual(a, quiz.questionKey('消防安全题库', '贮存易燃易爆，强氧化性物质时，最高温度不能高于（）'));
});

test('question parsing preserves options and rejects an unconfirmed answer', () => {
  const choices = [
    { textContent: 'A、20℃' }, { textContent: 'B、10℃' },
    { textContent: 'C、30℃' }, { textContent: 'D、0℃' },
  ];
  const before = quiz.parseQuestionText('1. 多选题 贮存易燃易爆，强氧化性物质时，最高温度不能高于（）', choices, '');
  assert.equal(before.stem, '贮存易燃易爆，强氧化性物质时，最高温度不能高于（）');
  assert.equal(before.kind, 'multiple');
  assert.equal(before.correct, null);
  assert.equal(before.options.C, '30℃');
  const after = quiz.parseQuestionText('1. 多选题 贮存易燃易爆，强氧化性物质时，最高温度不能高于（）', choices, '正确答案：C 我的答案：A,B');
  assert.deepEqual(after.correct, ['C']);
});

test('practice page enters the practice controller instead of video handling', async () => {
  const href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/questionBank/exercises/34?practiseSubjectType=1';
  const controller = new StudyController({
    document: { querySelectorAll: () => [], documentElement: {} },
    window: { location: { href }, setTimeout: () => 1, clearTimeout: () => {} },
  });
  controller.autoFlow = true;
  controller.autoContext = { rate: 1, completedKeys: new Set(), completedPeriodIds: new Set(), deferredKeys: new Set(), deferredPeriodIds: new Set() };
  controller._continuePractice = () => ({ state: 'running', mode: 'practice' });
  assert.deepEqual(await controller._continueAutoRoute(), { state: 'running', mode: 'practice' });
});

test('multiple choice can select an answer before the submit control appears', () => {
  const inputA = { click() {} };
  const inputC = { click() {} };
  const labels = [
    { textContent: 'A、20℃', querySelector: () => inputA },
    { textContent: 'C、30℃', querySelector: () => inputC },
  ];
  const container = { querySelectorAll: () => [] };
  const action = quiz.questionAction({ kind: 'multiple', correct: null, options: { A: '20℃', C: '30℃' }, labels, container }, { correct: ['C'] });
  assert.deepEqual(action.controls, [labels[1]]);
  assert.equal(action.type, 'select');
});

test('practice controller submits a multiple choice question once and records revealed truth', async () => {
  const originalChrome = globalThis.chrome;
  const originalReader = quiz.questionContainers;
  const storage = {};
  let selected = 0;
  let submitted = 0;
  const choice = { click: () => { selected += 1; } };
  const submit = { click: () => { submitted += 1; }, textContent: '提交答案', querySelectorAll: () => [], getAttribute: () => null };
  const question = {
    kind: 'multiple', stem: '虚构多选题（）', options: { A: '选项甲', B: '选项乙' }, correct: null,
    labels: [{ textContent: 'A、选项甲', querySelector: () => choice, click: () => { selected += 1; } }],
    container: { querySelectorAll: () => selected ? [submit] : [] },
  };
  quiz.questionContainers = () => [question];
  globalThis.chrome = { storage: { local: {
    get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, storage[key]])),
    set: async (values) => Object.assign(storage, values),
  } } };
  const href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/questionBank/exercises/34';
  const controller = new StudyController({
    document: { querySelectorAll: () => [], documentElement: {} },
    window: { location: { href }, setTimeout: () => 1, clearTimeout: () => {} },
  });
  controller.autoFlow = true;
  controller.state = 'running';
  try {
    await controller._continuePractice();
    assert.equal(selected, 1);
    assert.equal(submitted, 0);
    await controller._continuePractice();
    assert.equal(submitted, 1);
    await controller._continuePractice();
    assert.equal(submitted, 1);
    question.correct = ['B'];
    await controller._continuePractice();
    const saved = Object.values(storage[quiz.STORAGE_KEY]);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].bankId, '34');
    assert.deepEqual(saved[0].correct, ['B']);
  } finally {
    quiz.questionContainers = originalReader;
    globalThis.chrome = originalChrome;
  }
});

test('bank card controls remain associated with their own bank title', () => {
  const first = { textContent: '在线练习', querySelectorAll: () => [], getAttribute: () => null, parentElement: { textContent: '化学安全题库 在线练习' } };
  const second = { textContent: '在线练习', querySelectorAll: () => [], getAttribute: () => null, parentElement: { textContent: '消防安全题库 在线练习' } };
  const document = { querySelectorAll: () => [first, second] };
  assert.deepEqual(quiz.bankCards(document).map((item) => item.name), ['化学安全题库', '消防安全题库']);
});

test('practice exit is bounded when the page never changes', async () => {
  const originalChrome = globalThis.chrome;
  const originalReader = quiz.questionContainers;
  const originalControls = quiz.exactControls;
  let exits = 0;
  const question = { kind: 'single', stem: '虚构已完成题', options: { A: '甲', B: '乙' }, correct: ['A'] };
  quiz.questionContainers = () => [question];
  quiz.exactControls = (_root, label) => label === '退出' ? [{ click: () => { exits += 1; } }] : [];
  globalThis.chrome = { storage: { local: { get: async () => ({}), set: async () => {} } } };
  const href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/questionBank/exercises/34';
  const controller = new StudyController({
    document: { querySelectorAll: () => [], documentElement: {} },
    window: { location: { href }, setTimeout: () => 1, clearTimeout: () => {} },
  });
  controller.autoFlow = true;
  controller.state = 'running';
  try {
    for (let index = 0; index < 7 && controller.state === 'running'; index += 1) await controller._continuePractice();
    assert.equal(controller.state, 'needsAttention');
    assert.equal(exits, 5);
  } finally {
    quiz.questionContainers = originalReader;
    quiz.exactControls = originalControls;
    globalThis.chrome = originalChrome;
  }
});

test('question list marker may be CSS-generated and absent from DOM text', () => {
  const labels = [
    { textContent: 'A、20℃', parentElement: null },
    { textContent: 'B、10℃', parentElement: null },
  ];
  const body = {};
  const container = {
    innerText: '多选题 贮存易燃易爆物质的温度是（） A、20℃ B、10℃ 提交答案',
    parentElement: body,
    querySelectorAll: (selector) => selector.includes('wrapper') ? labels : [group],
  };
  const group = { parentElement: container, querySelectorAll: () => labels };
  const document = { body, querySelectorAll: () => [group] };
  const parsed = quiz.questionContainers(document);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].kind, 'multiple');
  assert.equal(parsed[0].stem, '贮存易燃易爆物质的温度是（）');
});

test('option label remains actionable when its native input has no visible box', () => {
  const input = { getBoundingClientRect: () => ({ width: 0, height: 0 }) };
  const label = { textContent: 'A、20℃', querySelector: () => input };
  const action = quiz.questionAction({ kind: 'single', correct: null, options: { A: '20℃', B: '10℃' }, labels: [label] }, null);
  assert.deepEqual(action.controls, [label]);
});

test('multiple choice wrappers are found even without a checkbox group element', () => {
  const body = {};
  const labels = [
    { textContent: 'A、20℃' },
    { textContent: 'B、10℃' },
  ];
  const container = {
    innerText: '多选题 最高温度不能高于（） A、20℃ B、10℃ 提交答案',
    parentElement: body,
    querySelectorAll: (selector) => selector.includes('wrapper') ? labels : [],
  };
  for (const label of labels) label.parentElement = container;
  const document = {
    body,
    querySelectorAll: (selector) => selector === '.ivu-radio-wrapper, .ivu-checkbox-wrapper' ? labels : [],
  };
  assert.equal(quiz.questionContainers(document).length, 1);
});

test('diagnosis reports practice structure and attention without copying question text', () => {
  const href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/questionBank/exercises/23';
  const wrapper = { textContent: 'A、敏感题干' };
  const document = {
    body: { innerText: '敏感题干' }, documentElement: {},
    querySelectorAll: (selector) => selector === '.ivu-radio-wrapper, .ivu-checkbox-wrapper' ? [wrapper] : [],
  };
  const controller = new StudyController({ document, window: { location: { href } } });
  controller.state = 'needsAttention';
  controller.reason = '练习题目结构无法识别。';
  const diagnosis = controller.diagnose();
  assert.equal(diagnosis.practice.wrapperCount, 1);
  assert.equal(diagnosis.reason, '练习题目结构无法识别。');
  assert.equal(JSON.stringify(diagnosis).includes('敏感题干'), false);
});

test('checkbox state is read from the native input even when that input is hidden', () => {
  const input = { checked: false };
  const label = { className: 'ivu-checkbox-wrapper', querySelector: () => input };
  assert.equal(quiz.choiceState(label), false);
  input.checked = true;
  assert.equal(quiz.choiceState(label), true);
});

test('a dropped first checkbox click is retried only while still unchecked', async () => {
  const originalChrome = globalThis.chrome;
  const originalReader = quiz.questionContainers;
  const originalControls = quiz.exactControls;
  let clickCount = 0;
  let checked = false;
  let submitCount = 0;
  const input = { get checked() { return checked; } };
  const label = { textContent: 'A、甲', querySelector: () => input, click: () => {
    clickCount += 1;
    if (clickCount > 1) checked = true;
  } };
  const question = { kind: 'multiple', stem: '虚构多选题', options: { A: '甲', B: '乙' }, correct: null, labels: [label], container: {} };
  quiz.questionContainers = () => [question];
  quiz.exactControls = (_root, name) => name === '提交答案' && checked ? [{ click: () => { submitCount += 1; } }] : [];
  globalThis.chrome = { storage: { local: { get: async () => ({}), set: async () => {} } } };
  const href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/questionBank/exercises/23';
  const controller = new StudyController({ document: { querySelectorAll: () => [], documentElement: {} },
    window: { location: { href }, setTimeout: () => 1, clearTimeout: () => {} } });
  controller.autoFlow = true;
  controller.state = 'running';
  try {
    await controller._continuePractice();
    assert.equal(clickCount, 1);
    controller.practicePendingSince = Date.now() - 3000;
    await controller._continuePractice();
    assert.equal(clickCount, 2);
    await controller._continuePractice();
    assert.equal(submitCount, 1);
  } finally {
    quiz.questionContainers = originalReader;
    quiz.exactControls = originalControls;
    globalThis.chrome = originalChrome;
  }
});
