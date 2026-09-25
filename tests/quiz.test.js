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

test('multiple choice uses the question-local submit control after selecting known answers', () => {
  const inputA = { click() {} };
  const inputC = { click() {} };
  const labels = [
    { textContent: 'A、20℃', querySelector: () => inputA },
    { textContent: 'C、30℃', querySelector: () => inputC },
  ];
  const submit = { textContent: '提交答案', querySelectorAll: () => [], getAttribute: () => null };
  const container = { querySelectorAll: () => [submit] };
  const action = quiz.questionAction({ kind: 'multiple', correct: null, options: { A: '20℃', C: '30℃' }, labels, container }, { correct: ['C'] });
  assert.deepEqual(action.controls, [inputC]);
  assert.equal(action.submit, submit);
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
    labels: [{ textContent: 'A、选项甲', querySelector: () => choice }],
    container: { querySelectorAll: () => [submit] },
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
