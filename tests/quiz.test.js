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
  assert.deepEqual(quiz.parseAnswer('正确答案：ABC 我的答案：C'), ['A', 'B', 'C']);
  assert.equal(quiz.parseAnswer('我的答案：A,B'), null);
  assert.deepEqual(quiz.parseAnswer('正确答案：对 我的答案：对'), ['对']);
  assert.deepEqual(quiz.parseAnswer('正确答案：错 我的答案：对'), ['错']);
});

test('judgment question uses 对/错 options and a revealed truth answer', () => {
  const labels = [{ textContent: '对' }, { textContent: '错' }];
  const parsed = quiz.parseQuestionText('221. 判断题 液体表面的蒸汽遇火发生闪灭的现象是闪点。', labels,
    '正确答案：对 我的答案：对');
  assert.equal(parsed.kind, 'judgment');
  assert.deepEqual(parsed.options, { 对: '对', 错: '错' });
  assert.deepEqual(parsed.correct, ['对']);
  const action = quiz.questionAction({ ...parsed, correct: null, labels }, { correct: ['错'] });
  assert.deepEqual(action.controls, [labels[1]]);
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
  const choice = { checked: false };
  const submit = { click: () => { submitted += 1; }, textContent: '提交答案', querySelectorAll: () => [], getAttribute: () => null };
  const question = {
    kind: 'multiple', stem: '虚构多选题（）', options: { A: '选项甲', B: '选项乙' }, correct: null,
    labels: [{ textContent: 'A、选项甲', querySelector: () => choice, click: () => { selected += 1; choice.checked = true; } },
      { textContent: 'B、选项乙', querySelector: () => ({ checked: false }), click: () => {} }],
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

test('known multiple answer selects every checkbox before submitting after page rerenders', async () => {
  const originalChrome = globalThis.chrome;
  const originalReader = quiz.questionContainers;
  const originalControls = quiz.exactControls;
  const href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/questionBank/exercises/34';
  const stem = '已收录的多选题';
  const key = quiz.questionKey('34', stem);
  const storage = { [quiz.STORAGE_KEY]: { [key]: { correct: ['A', 'B', 'C'] } } };
  let selected = new Set();
  let submitted = null;
  quiz.questionContainers = () => {
    const snapshot = new Set(selected);
    const labels = ['A', 'B', 'C', 'D'].map((letter) => ({
      textContent: `${letter}、选项${letter}`,
      querySelector: () => ({ checked: snapshot.has(letter) }),
      click: () => {
        selected = new Set(snapshot);
        selected.has(letter) ? selected.delete(letter) : selected.add(letter);
      },
    }));
    return [{ kind: 'multiple', stem, options: { A: '选项A', B: '选项B', C: '选项C', D: '选项D' },
      correct: null, labels, container: {} }];
  };
  quiz.exactControls = (_root, label) => label === '提交答案' && selected.size
    ? [{ click: () => { submitted = [...selected].sort(); } }] : [];
  globalThis.chrome = { storage: { local: {
    get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((item) => [item, storage[item]])),
    set: async (values) => Object.assign(storage, values),
  } } };
  const controller = new StudyController({ document: { querySelectorAll: () => [], documentElement: {} },
    window: { location: { href }, setTimeout: () => 1, clearTimeout: () => {} } });
  controller.autoFlow = true;
  controller.state = 'running';
  try {
    for (let index = 0; index < 8 && !submitted && controller.state === 'running'; index += 1) {
      await controller._continuePractice();
    }
    assert.deepEqual(submitted, ['A', 'B', 'C']);
    assert.equal(controller.state, 'running');
  } finally {
    quiz.questionContainers = originalReader;
    quiz.exactControls = originalControls;
    globalThis.chrome = originalChrome;
  }
});

test('already selected multiple answer waits for its submit control to render', async () => {
  const originalChrome = globalThis.chrome;
  const originalReader = quiz.questionContainers;
  const originalControls = quiz.exactControls;
  let submitReady = false;
  let submitted = 0;
  const question = { kind: 'multiple', stem: '预选中的多选题', options: { A: '甲', B: '乙' }, correct: null,
    labels: [
      { textContent: 'A、甲', querySelector: () => ({ checked: true }), click: () => {} },
      { textContent: 'B、乙', querySelector: () => ({ checked: false }), click: () => {} },
    ], container: {} };
  quiz.questionContainers = () => [question];
  quiz.exactControls = (_root, label) => label === '提交答案' && submitReady
    ? [{ click: () => { submitted += 1; } }] : [];
  globalThis.chrome = { storage: { local: { get: async () => ({}), set: async () => {} } } };
  const href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/questionBank/exercises/34';
  const controller = new StudyController({ document: { querySelectorAll: () => [], documentElement: {} },
    window: { location: { href }, setTimeout: () => 1, clearTimeout: () => {} } });
  controller.autoFlow = true;
  controller.state = 'running';
  try {
    await controller._continuePractice();
    assert.equal(controller.state, 'running');
    assert.equal(submitted, 0);
    submitReady = true;
    await controller._continuePractice();
    assert.equal(submitted, 1);
  } finally {
    quiz.questionContainers = originalReader;
    quiz.exactControls = originalControls;
    globalThis.chrome = originalChrome;
  }
});

test('bank card controls remain associated with their own bank title', () => {
  const first = { textContent: '在线练习', querySelectorAll: () => [], getAttribute: () => null, parentElement: { textContent: '化学安全题库 在线练习' } };
  const second = { textContent: '在线练习', querySelectorAll: () => [], getAttribute: () => null, parentElement: { textContent: '消防安全题库 在线练习' } };
  const document = { querySelectorAll: () => [first, second] };
  assert.deepEqual(quiz.bankCards(document).map((item) => item.name), ['化学安全题库', '消防安全题库']);
});

test('opening a bank does not mark it complete before its last page is recorded', async () => {
  const originalChrome = globalThis.chrome;
  const originalCards = quiz.bankCards;
  const storage = {};
  let opened = 0;
  quiz.bankCards = () => [
    { name: '化学安全题库', control: { click: () => { opened += 1; } } },
    { name: '消防安全题库', control: { click: () => {} } },
  ];
  globalThis.chrome = { storage: { local: {
    get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, storage[key]])),
    set: async (values) => Object.assign(storage, values),
  } } };
  const href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/questionBank';
  const controller = new StudyController({ document: { querySelectorAll: () => [], documentElement: {} },
    window: { location: { href }, setTimeout: () => 1, clearTimeout: () => {} } });
  controller.autoFlow = true;
  controller.state = 'running';
  try {
    await controller._continuePracticeBank();
    assert.equal(opened, 1);
    assert.deepEqual(storage[quiz.BANK_KEY] || [], []);
    assert.deepEqual(storage[quiz.BANK_LIST_KEY], ['化学安全题库', '消防安全题库']);
    assert.equal(storage.labsafeActivePracticeBankV1, '化学安全题库');
  } finally {
    quiz.bankCards = originalCards;
    globalThis.chrome = originalChrome;
  }
});

test('returning to bank cards opens the next unfinished bank and preserves completed names', async () => {
  const originalChrome = globalThis.chrome;
  const originalCards = quiz.bankCards;
  const storage = { [quiz.BANK_KEY]: ['化学安全题库'] };
  let firstClicks = 0;
  let secondClicks = 0;
  quiz.bankCards = () => [
    { name: '化学安全题库', control: { click: () => { firstClicks += 1; } } },
    { name: '消防安全题库', control: { click: () => { secondClicks += 1; } } },
  ];
  globalThis.chrome = { storage: { local: {
    get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, storage[key]])),
    set: async (values) => Object.assign(storage, values),
  } } };
  const href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/questionBank';
  const controller = new StudyController({ document: { querySelectorAll: () => [], documentElement: {} },
    window: { location: { href }, setTimeout: () => 1, clearTimeout: () => {} } });
  controller.autoFlow = true;
  controller.state = 'running';
  try {
    await controller._continuePracticeBank();
    assert.equal(firstClicks, 0);
    assert.equal(secondClicks, 1);
    assert.deepEqual(storage[quiz.BANK_KEY], ['化学安全题库']);
    assert.equal(storage.labsafeActivePracticeBankV1, '消防安全题库');
  } finally {
    quiz.bankCards = originalCards;
    globalThis.chrome = originalChrome;
  }
});

test('bank picker modal advances to the next bank and keeps the completed set', async () => {
  const originalChrome = globalThis.chrome;
  const storage = { [quiz.BANK_KEY]: ['化学安全题库'] };
  let firstClicks = 0;
  let secondClicks = 0;
  const candidates = [
    { innerText: '1.化学安全题库', click: () => { firstClicks += 1; } },
    { innerText: '2.消防安全题库', click: () => { secondClicks += 1; } },
  ];
  globalThis.chrome = { storage: { local: {
    get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, storage[key]])),
    set: async (values) => Object.assign(storage, values),
  } } };
  const href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/examTask/75';
  const controller = new StudyController({ document: { querySelectorAll: () => [], documentElement: {} },
    window: { location: { href }, setTimeout: () => 1, clearTimeout: () => {} } });
  controller._hasPracticeBankModal = () => true;
  controller._practiceBankCandidates = () => candidates;
  controller.autoFlow = true;
  controller.state = 'running';
  try {
    await controller._continuePracticeBank();
    assert.equal(firstClicks, 0);
    assert.equal(secondClicks, 1);
    assert.deepEqual(storage[quiz.BANK_KEY], ['化学安全题库']);
    assert.deepEqual(storage[quiz.BANK_LIST_KEY], ['化学安全题库', '消防安全题库']);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('unchanged next page at the end exits to select another bank', async () => {
  const originalChrome = globalThis.chrome;
  const originalReader = quiz.questionContainers;
  const originalControls = quiz.exactControls;
  const storage = { [quiz.BANK_KEY]: [], [quiz.BANK_LIST_KEY]: ['化学安全题库', '消防安全题库'],
    labsafeActivePracticeBankV1: '化学安全题库' };
  let nextClicks = 0;
  let exitClicks = 0;
  quiz.questionContainers = () => [{ kind: 'judgment', stem: '最后一题', options: { 对: '对', 错: '错' }, correct: ['对'] }];
  quiz.exactControls = (_root, label) => label === '下一页' ? [{ click: () => { nextClicks += 1; } }]
    : label === '退出' ? [{ click: () => { exitClicks += 1; } }] : [];
  globalThis.chrome = { storage: { local: {
    get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, storage[key]])),
    set: async (values) => Object.assign(storage, values),
  } } };
  const href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/questionBank/exercises/34';
  const controller = new StudyController({ document: { querySelectorAll: () => [], documentElement: {} },
    window: { location: { href }, setTimeout: () => 1, clearTimeout: () => {} } });
  controller.autoFlow = true;
  controller.state = 'running';
  try {
    for (let index = 0; index < 7 && !exitClicks; index += 1) await controller._continuePractice();
    assert.equal(nextClicks, 5);
    assert.equal(exitClicks, 1);
    assert.equal(controller.state, 'running');
    assert.deepEqual(storage[quiz.BANK_KEY], ['化学安全题库']);
  } finally {
    quiz.questionContainers = originalReader;
    quiz.exactControls = originalControls;
    globalThis.chrome = originalChrome;
  }
});

test('last completed bank stays on the practice page until the course check time', async () => {
  const originalChrome = globalThis.chrome;
  const originalReader = quiz.questionContainers;
  const originalControls = quiz.exactControls;
  const storage = { [quiz.BANK_KEY]: ['化学安全题库'],
    [quiz.BANK_LIST_KEY]: ['化学安全题库', '消防安全题库'], labsafeActivePracticeBankV1: '消防安全题库' };
  let exitClicks = 0;
  quiz.questionContainers = () => [{ kind: 'judgment', stem: '最后一题', options: { 对: '对', 错: '错' }, correct: ['对'] }];
  quiz.exactControls = (_root, label) => label === '退出' ? [{ click: () => { exitClicks += 1; } }] : [];
  globalThis.chrome = { storage: { local: {
    get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, storage[key]])),
    set: async (values) => Object.assign(storage, values),
  } } };
  const href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/questionBank/exercises/35';
  const controller = new StudyController({ document: { querySelectorAll: () => [], documentElement: {} },
    window: { location: { href }, setTimeout: () => 1, clearTimeout: () => {} } });
  controller.autoFlow = true;
  controller.state = 'running';
  controller.autoContext = { practiceCheckAt: Date.now() + 60000 };
  try {
    await controller._continuePractice();
    assert.equal(exitClicks, 0);
    assert.deepEqual(storage[quiz.BANK_KEY], ['化学安全题库', '消防安全题库']);
    controller.autoContext.practiceCheckAt = Date.now() - 1;
    await controller._continuePractice();
    assert.equal(exitClicks, 1);
  } finally {
    quiz.questionContainers = originalReader;
    quiz.exactControls = originalControls;
    globalThis.chrome = originalChrome;
  }
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

test('judgment questions with CSS numbering are recognized from 对/错 radio wrappers', () => {
  const body = {};
  const labels = [{ textContent: '对' }, { textContent: '错' }];
  const container = {
    innerText: '判断题 液体表面蒸汽遇火发生闪灭的现象是闪点。 对 错',
    parentElement: body,
    querySelectorAll: (selector) => selector.includes('wrapper') ? labels : [],
  };
  for (const label of labels) label.parentElement = container;
  const document = { body, querySelectorAll: (selector) => selector === '.ivu-radio-wrapper, .ivu-checkbox-wrapper' ? labels : [] };
  const questions = quiz.questionContainers(document);
  assert.equal(questions.length, 1);
  assert.equal(questions[0].stem, '液体表面蒸汽遇火发生闪灭的现象是闪点。');
  assert.equal(questions[0].kind, 'judgment');
});

test('controller records an answered judgment item and continues to the next one', async () => {
  const originalChrome = globalThis.chrome;
  const originalReader = quiz.questionContainers;
  const storage = {};
  let nextClicks = 0;
  const answered = { kind: 'judgment', stem: '已揭示的判断题', options: { 对: '对', 错: '错' }, correct: ['对'] };
  const next = { kind: 'judgment', stem: '下一道判断题', options: { 对: '对', 错: '错' }, correct: null,
    labels: [{ textContent: '对', click: () => { nextClicks += 1; } }, { textContent: '错', click: () => {} }] };
  quiz.questionContainers = () => [answered, next];
  globalThis.chrome = { storage: { local: {
    get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, storage[key]])),
    set: async (values) => Object.assign(storage, values),
  } } };
  const href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/questionBank/exercises/23';
  const controller = new StudyController({ document: { querySelectorAll: () => [], documentElement: {} },
    window: { location: { href }, setTimeout: () => 1, clearTimeout: () => {} } });
  controller.autoFlow = true;
  controller.state = 'running';
  try {
    await controller._continuePractice();
    assert.equal(nextClicks, 1);
    assert.equal(Object.values(storage[quiz.STORAGE_KEY]).length, 1);
    next.correct = ['错'];
    await controller._continuePractice();
    assert.equal(Object.values(storage[quiz.STORAGE_KEY]).length, 2);
  } finally {
    quiz.questionContainers = originalReader;
    globalThis.chrome = originalChrome;
  }
});

test('diagnosis reports practice structure and attention without copying question text', () => {
  const href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/questionBank/exercises/23';
  const wrapper = { textContent: 'A、敏感题干' };
  const returnControl = { tagName: 'SPAN', textContent: '↶ 返回', getBoundingClientRect: () => ({ width: 30, height: 20 }) };
  const document = {
    body: { innerText: '敏感题干' }, documentElement: {},
    querySelectorAll: (selector) => selector === '.ivu-radio-wrapper, .ivu-checkbox-wrapper' ? [wrapper]
      : selector === '*' ? [wrapper, returnControl] : [],
  };
  const controller = new StudyController({ document, window: { location: { href } } });
  controller.state = 'needsAttention';
  controller.reason = '练习题目结构无法识别。';
  const diagnosis = controller.diagnose();
  assert.equal(diagnosis.practice.wrapperCount, 1);
  assert.equal(diagnosis.reason, '练习题目结构无法识别。');
  assert.equal(diagnosis.returnCandidates[0].labelKind, 'suffix');
  assert.deepEqual(diagnosis.returnCandidates[0].prefixCodes, ['21b6', '20']);
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
