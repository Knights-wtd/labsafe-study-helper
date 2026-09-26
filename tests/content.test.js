const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isAllowedUrl,
  isSafetyVideoUrl,
  isArticleStudyUrl,
  isCatalogUrl,
  hasRecognizedCatalogTable,
  chooseVideo,
  chooseNext,
  chooseReturnHome,
  chooseArticleReturn,
  readStudyProgress,
  readCatalogRows,
  chooseCourseRow,
  chooseCatalogNextPage,
  sanitizeText,
  StudyController,
} = require('../extension/content.js');

class FakeElement {
  constructor(tagName, text = '', options = {}) {
    this.tagName = tagName.toUpperCase();
    this.textContent = text;
    this.attrs = options.attrs || {};
    this.rect = options.rect || { width: 100, height: 30 };
    this.style = options.style || {};
    this.disabled = Boolean(options.disabled);
    this.listeners = new Map();
    this.clickCount = 0;
    this.playCount = 0;
    this.pauseCount = 0;
    this.playbackRate = 1;
    this.paused = true;
    this.ended = false;
    this.currentTime = 0;
    this.parentElement = options.parentElement || null;
  }
  getAttribute(name) { return this.attrs[name] ?? null; }
  getAttributeNames() { return Object.keys(this.attrs); }
  getBoundingClientRect() { return this.rect; }
  getClientRects() { return this.rect.width > 0 && this.rect.height > 0 ? [this.rect] : []; }
  addEventListener(type, fn) {
    const list = this.listeners.get(type) || [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  removeEventListener(type, fn) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter((item) => item !== fn));
  }
  emit(type) { for (const fn of this.listeners.get(type) || []) fn({ target: this }); }
  click() { this.clickCount += 1; }
  play() { this.playCount += 1; this.paused = false; return Promise.resolve(); }
  pause() { this.pauseCount += 1; this.paused = true; this.emit('pause'); }
}

class FakeDocument {
  constructor(elements = [], visibleText = '') {
    this.elements = elements;
    this.body = { innerText: visibleText };
    this.documentElement = {};
  }
  querySelectorAll(selector) {
    if (selector === 'video') return this.elements.filter((item) => item.tagName === 'VIDEO');
    if (selector === 'button, a, [role="button"], *') return this.elements;
    if (selector.startsWith('button, a')) return this.elements.filter((item) => ['BUTTON', 'A'].includes(item.tagName));
    if (selector === 'iframe, frame') return [];
    return [];
  }
}

class CatalogElement {
  constructor(tagName, text = '', options = {}) {
    this.tagName = tagName.toUpperCase();
    this.textContent = text;
    this.innerText = text;
    this.attrs = options.attrs || {};
    this.style = options.style || {};
    this.hidden = Boolean(options.hidden);
    this.disabled = Boolean(options.disabled);
    this.clickCount = 0;
    this.rect = options.rect || { width: 100, height: 24 };
    this.children = options.children || [];
    this.parentElement = null;
    for (const child of this.children) child.parentElement = this;
    this.childrenBySelector = options.childrenBySelector || {};
  }
  getAttribute(name) { return this.attrs[name] ?? null; }
  getBoundingClientRect() { return this.rect; }
  getClientRects() { return this.rect.width > 0 && this.rect.height > 0 ? [this.rect] : []; }
  querySelectorAll(selector) { return this.childrenBySelector[selector] || []; }
  click() { this.clickCount += 1; }
}

function catalogFixture(rows, options = {}) {
  const header = new CatalogElement('tr', '', {
    childrenBySelector: {
      'th, [role="columnheader"]': ['名称', '学习模块', '学习进度', '操作'].map((label) => new CatalogElement('th', label)),
    },
  });
  const tableRows = [header, ...rows];
  const table = new CatalogElement('table', '', {
    childrenBySelector: { 'tr, [role="row"]': tableRows },
  });
  const doc = {
    querySelectorAll(selector) {
      if (selector === 'table, [role="table"], [role="grid"]') return options.tables || [table];
      if (selector === 'tr, [role="row"]') return tableRows;
      return [];
    },
  };
  return { document: doc, table, rows: tableRows.slice(1) };
}

function markUnlearnedTabSelected(document) {
  const original = document.querySelectorAll.bind(document);
  const activeTab = new CatalogElement('div', '未学');
  activeTab.className = 'el-tabs__item is-active';
  const activePage = new CatalogElement('button', '1');
  document.querySelectorAll = (selector) => {
    if (selector === '.el-tabs__item, .ivu-tabs-tab, [role="tab"]') return [activeTab];
    if (selector === '.el-tabs__item.is-active, [role="tab"][aria-selected="true"]') return [activeTab];
    if (selector === '.el-pagination .number.active') return [activePage];
    if (selector === '.el-pagination .number') return [activePage];
    return original(selector);
  };
  return { document, activePage, activeTab };
}

function attachCatalogPager(document, activePage, next) {
  const original = document.querySelectorAll.bind(document);
  const pager = new CatalogElement('div', '');
  pager.className = 'el-pagination';
  activePage.className = 'number active';
  activePage.parentElement = pager;
  if (next) {
    next.className = 'btn-next';
    next.parentElement = pager;
  }
  document.querySelectorAll = (selector) => {
    if (selector === '.el-pagination, .ivu-page') return [pager];
    if (selector === '.el-pagination .number.active') return [activePage];
    if (selector === '.el-pagination .number, .ivu-page .ivu-page-item') return [activePage];
    if (selector === '.el-pagination .btn-next, .el-pagination [aria-label="下一页"], .ivu-page .ivu-page-next') return next ? [next] : [];
    return original(selector);
  };
}

function splitCatalogFixture(rows, options = {}) {
  const headerRow = new CatalogElement('tr', '', {
    childrenBySelector: {
      'th, [role="columnheader"]': ['名称', '学习模块', '学习进度', '操作'].map((label) => new CatalogElement('th', label)),
    },
  });
  const headerTable = new CatalogElement('table', '', {
    childrenBySelector: { 'tr, [role="row"]': [headerRow] },
  });
  const bodyTable = new CatalogElement('table', '', {
    childrenBySelector: { 'tr, [role="row"]': rows },
  });
  const headerWrapper = new CatalogElement('div', '', {
    childrenBySelector: { 'table, [role="table"], [role="grid"]': [headerTable] },
  });
  headerWrapper.className = 'el-table__header-wrapper';
  const bodyWrapper = new CatalogElement('div', '', {
    childrenBySelector: { 'table, [role="table"], [role="grid"]': [bodyTable] },
  });
  bodyWrapper.className = 'el-table__body-wrapper';
  const root = new CatalogElement('div', '', {
    childrenBySelector: {
      '.el-table__header-wrapper, .ivu-table-header': options.headerWrappers || [headerWrapper],
      '.el-table__body-wrapper, .ivu-table-body': options.bodyWrappers || [bodyWrapper],
    },
  });
  root.className = 'el-table';
  const document = {
    querySelectorAll(selector) {
      if (selector === '.el-table, .ivu-table') return options.roots || [root];
      if (selector === '.el-table__header-wrapper, .ivu-table-header') return options.headerWrappers || [headerWrapper];
      if (selector === '.el-table__body-wrapper, .ivu-table-body') return options.bodyWrappers || [bodyWrapper];
      if (selector === 'table, [role="table"], [role="grid"]') return [headerTable, bodyTable];
      return [];
    },
  };
  return { document, root, headerWrapper, bodyWrapper, headerTable, bodyTable };
}

function catalogRow(title, module, progress, options = {}) {
  const tag = options.tag === undefined ? '必学' : options.tag;
  const button = options.button || new CatalogElement('button', options.action || '去学习', {
    disabled: options.disabled,
    attrs: options.buttonAttrs,
    style: options.buttonStyle,
  });
  const cells = [title, module, progress].map((label) => new CatalogElement('td', label));
  cells.push(new CatalogElement('td', tag, {
    childrenBySelector: { 'button, a, [role="button"]': options.buttons || [button] },
  }));
  for (const control of options.buttons || [button]) control.parentElement = cells[3];
  const row = new CatalogElement('tr', `${tag} ${title} ${module} ${progress}`, {
    hidden: options.hidden,
    style: options.style,
    childrenBySelector: {
      'td, [role="cell"], [role="gridcell"]': cells,
      'button, a, [role="button"]': options.buttons || [button],
    },
  });
  return { row, button, title, module };
}

function fakeWindow(document) {
  const observers = [];
  const timers = new Map();
  const intervals = new Map();
  let nextTimerId = 1;
  return {
    document,
    location: { href: 'https://labsafe.lzjtu.edu.cn/lab-study-front/course/1' },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); }
      observe() {}
      disconnect() { this.disconnected = true; }
      trigger() { this.callback(); }
    },
    getComputedStyle: (element) => element.style,
    observers,
    timers,
    intervals,
    setTimeout(callback) { const id = nextTimerId++; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
    runTimers() {
      const pending = Array.from(timers.values());
      timers.clear();
      for (const callback of pending) callback();
    },
    setInterval(callback) { const id = nextTimerId++; intervals.set(id, callback); return id; },
    clearInterval(id) { intervals.delete(id); },
    runIntervals() { for (const callback of Array.from(intervals.values())) callback(); },
  };
}

test('isAllowedUrl permits only HTTPS on the exact learning host and path', () => {
  assert.equal(isAllowedUrl('https://labsafe.lzjtu.edu.cn/lab-study-front/course/1'), true);
  assert.equal(isAllowedUrl('https://labsafe.lzjtu.edu.cn.evil.test/lab-study-front/course/1'), false);
  assert.equal(isAllowedUrl('http://labsafe.lzjtu.edu.cn/lab-study-front/course/1'), false);
  assert.equal(isAllowedUrl('https://labsafe.lzjtu.edu.cn/other/course/1'), false);
  assert.equal(isAllowedUrl('https://user@labsafe.lzjtu.edu.cn/lab-study-front/course/1'), false);
  assert.equal(isAllowedUrl('https://labsafe.lzjtu.edu.cn:8443/lab-study-front/course/1'), false);
});

test('readStudyProgress parses visible Chinese time labels and supported formats', () => {
  assert.deepEqual(readStudyProgress(new FakeDocument([], '已学习：07:56，要求学习：12:00')),
    { learnedSeconds: 476, requiredSeconds: 720 });
  assert.deepEqual(readStudyProgress(new FakeDocument([], '已学习 1：02：03, 要求学习 00:12:00')),
    { learnedSeconds: 3723, requiredSeconds: 720 });
  assert.deepEqual(readStudyProgress(new FakeDocument([], 'Learned: 07:56; Required study: 12:00')),
    { learnedSeconds: 476, requiredSeconds: 720 });
});

test('readStudyProgress rejects missing, malformed, or ambiguous visible counters', () => {
  assert.equal(readStudyProgress(new FakeDocument([], '欢迎学习')), null);
  assert.equal(readStudyProgress(new FakeDocument([], '已学习：7:99，要求学习：12:00')), null);
  assert.equal(readStudyProgress(new FakeDocument([], '已学习：07:56，已学习：08:00，要求学习：12:00')), null);
});

test('article route is limited to the exact examTask study route family', () => {
  assert.equal(isArticleStudyUrl('https://labsafe.lzjtu.edu.cn/lab-study-front/examTask/75/5/1/4'), true);
  assert.equal(isArticleStudyUrl('https://labsafe.lzjtu.edu.cn/lab-study-front/examTask/75/5/1/4?x=1'), true);
  assert.equal(isArticleStudyUrl('https://labsafe.lzjtu.edu.cn/lab-study-front/examTask/75/5/1'), false);
  assert.equal(isArticleStudyUrl('https://labsafe.lzjtu.edu.cn/lab-study-front/examTask/75/5/1/4/extra'), false);
  assert.equal(isArticleStudyUrl('http://labsafe.lzjtu.edu.cn/lab-study-front/examTask/75/5/1/4'), false);
});

test('catalog route matches only the exam task overview path', () => {
  assert.equal(isCatalogUrl('https://labsafe.lzjtu.edu.cn/lab-study-front/examTask/75'), true);
  assert.equal(isCatalogUrl('https://labsafe.lzjtu.edu.cn/lab-study-front/examTask/75?tab=todo'), true);
  assert.equal(isCatalogUrl('https://labsafe.lzjtu.edu.cn/lab-study-front/examTask/75/5/1/4'), false);
  assert.equal(isCatalogUrl('https://labsafe.lzjtu.edu.cn/lab-study-front/examTask/not-id'), false);
});

test('safety video route accepts varying course ids and study-length query values', () => {
  assert.equal(isSafetyVideoUrl('https://labsafe.lzjtu.edu.cn/lab-study-front/security/safetyVideo/7/1?requireStudyLength=300&studyLength=240'), true);
  assert.equal(isSafetyVideoUrl('https://labsafe.lzjtu.edu.cn/lab-study-front/security/safetyVideo/88/23'), true);
  assert.equal(isSafetyVideoUrl('https://labsafe.lzjtu.edu.cn/lab-study-front/security/safetyVideo/7'), false);
  assert.equal(isSafetyVideoUrl('https://example.com/lab-study-front/security/safetyVideo/7/1'), false);
});

test('the real safety video page completes from its visible timer and uses its 返回 button', async () => {
  const video = new FakeElement('video');
  const back = new FakeElement('button', '返回');
  const document = new FakeDocument([video, back], '已学习 04:35 要求学习 05:00');
  const view = fakeWindow(document);
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/security/safetyVideo/7/1?requireStudyLength=300&studyLength=240';
  const messages = [];
  const controller = new StudyController({ document, window: view,
    runtime: { sendMessage: async (message) => { messages.push(message); return { ok: true }; } } });
  await controller.autoContinue({ rate: 1, pendingKey: 'course-ab12' });
  assert.equal(controller.status().mode, 'video');
  document.body.innerText = '已学习 05:00 要求学习 05:00';
  view.runIntervals();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(back.clickCount, 1);
  assert.equal(messages[0].type, 'COURSE_COMPLETED');
  assert.equal(messages[0].periodId, 'safety-video-7-1');
});

test('personal center opens a unique 去学习 entry and then continues in the course catalog', async () => {
  const entry = new FakeElement('button', '去学习');
  const person = new FakeDocument([entry], '个人中心 去学习');
  const course = catalogRow('课程甲', '微课堂', '已学习：00:00:00 / 00:08:00');
  const catalog = catalogFixture([course.row]);
  const view = fakeWindow(person);
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/person';
  const controller = new StudyController({ document: person, window: view,
    runtime: { sendMessage: async () => ({ ok: true }) } });
  entry.click = () => {
    entry.clickCount += 1;
    controller.document = catalog.document;
    view.document = catalog.document;
    view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/examTask/75';
  };
  await controller.autoContinue({ rate: 1 });
  assert.equal(entry.clickCount, 1);
  view.runTimers();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.status().mode, 'catalog');
  assert.equal(course.button.clickCount, 1);
});

test('an allowed page with a unique video, study timer and 返回 is recognized without a fixed route', async () => {
  const video = new FakeElement('video');
  const back = new FakeElement('button', '返回');
  const document = new FakeDocument([video, back], '已学习 00:05 要求学习 00:05');
  const view = fakeWindow(document);
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/security/customVideo/93?course=12';
  const messages = [];
  const controller = new StudyController({ document, window: view,
    runtime: { sendMessage: async (message) => { messages.push(message); return { ok: true }; } } });
  await controller.autoContinue({ rate: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.status().mode, 'video');
  assert.equal(back.clickCount, 1);
  assert.match(messages[0].periodId, /^route-[a-z0-9]+$/);
});

test('a changed catalog URL waits for its recognized table body before choosing a course', async () => {
  const course = catalogRow('课程甲', '微课堂', '已学习：00:00:00 / 00:08:00');
  const fixture = splitCatalogFixture([]);
  const view = fakeWindow(fixture.document);
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/learning/tasks/75';
  const controller = new StudyController({ document: fixture.document, window: view,
    runtime: { sendMessage: async () => ({ ok: true }) } });
  await controller.autoContinue({ rate: 1 });
  assert.equal(controller.status().state, 'running');
  fixture.bodyTable.childrenBySelector['tr, [role="row"]'] = [course.row];
  view.runTimers();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(course.button.clickCount, 1);
});

test('an unfamiliar allowed page waits for its video and timer to render before classifying it', async () => {
  const video = new FakeElement('video');
  const back = new FakeElement('button', '返回');
  const document = new FakeDocument([], '页面加载中');
  const view = fakeWindow(document);
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/security/newVideo/93';
  const controller = new StudyController({ document, window: view,
    runtime: { sendMessage: async () => ({ ok: true }) } });
  await controller.autoContinue({ rate: 1 });
  assert.equal(controller.status().state, 'running');
  document.elements = [video, back];
  document.body.innerText = '已学习 00:01 要求学习 05:00';
  view.runTimers();
  assert.equal(controller.status().mode, 'video');
});

test('person to catalog to safety video to catalog completes the serial learning loop', async () => {
  const entry = new FakeElement('button', '去学习');
  const person = new FakeDocument([entry], '个人中心 去学习');
  const course = catalogRow('课程甲', '微课堂', '已学习：00:00:00 / 00:05:00');
  const catalog = catalogFixture([course.row]);
  const video = new FakeElement('video');
  const back = new FakeElement('button', '返回');
  const player = new FakeDocument([video, back], '已学习 00:01 要求学习 05:00');
  const view = fakeWindow(person);
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/person';
  const messages = [];
  const controller = new StudyController({ document: person, window: view,
    runtime: { sendMessage: async (message) => { messages.push(message.type); return { ok: true }; } } });
  entry.click = () => {
    entry.clickCount += 1;
    controller.document = catalog.document;
    view.document = catalog.document;
    view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/examTask/75';
  };
  course.button.click = () => {
    course.button.clickCount += 1;
    controller.document = player;
    view.document = player;
    view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/security/safetyVideo/7/1?requireStudyLength=300';
  };
  back.click = () => {
    back.clickCount += 1;
    controller.document = catalog.document;
    view.document = catalog.document;
    view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/examTask/75';
  };
  await controller.autoContinue({ rate: 1 });
  view.runTimers();
  await new Promise((resolve) => setImmediate(resolve));
  view.runTimers();
  assert.equal(course.button.clickCount, 1);
  assert.equal(controller.status().mode, 'video');
  player.body.innerText = '已学习 05:00 要求学习 05:00';
  view.runIntervals();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(back.clickCount, 1);
  controller._onMutation();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.status().state, 'completed');
  assert.deepEqual(messages, ['COURSE_PICKED', 'COURSE_COMPLETED', 'FLOW_COMPLETE']);
});

test('article return selector requires one visible exact 返回 control', () => {
  const back = new FakeElement('button', '返回');
  assert.equal(chooseArticleReturn(new FakeDocument([back])), back);
  const decorated = new FakeElement('span', '↶ 返回');
  assert.equal(chooseArticleReturn(new FakeDocument([decorated])), decorated);
  const fontIcon = new FakeElement('span', '\ue600 返回');
  assert.equal(chooseArticleReturn(new FakeDocument([fontIcon])), fontIcon);
  const top = new FakeElement('button', '返回');
  const bottom = new FakeElement('button', '返回');
  top.className = bottom.className = 'btn ivu-btn';
  const topLabel = new FakeElement('span', '返回', { parentElement: top });
  const bottomLabel = new FakeElement('span', '返回', { parentElement: bottom });
  assert.equal(chooseArticleReturn(new FakeDocument([top, topLabel, bottom, bottomLabel])), top);
  assert.equal(chooseArticleReturn(new FakeDocument([decorated, new FakeElement('span', '← 返回')])), null);
  assert.equal(chooseArticleReturn(new FakeDocument([back, new FakeElement('a', '返回')])), null);
  assert.equal(chooseArticleReturn(new FakeDocument([new FakeElement('button', '返回课程主页')])), null);
  assert.equal(chooseArticleReturn(new FakeDocument([new FakeElement('button', '确认返回')])), null);
  assert.equal(chooseArticleReturn(new FakeDocument([new FakeElement('button', '返回', { style: { display: 'none' } })])), null);
});

test('article mode completes from visible counter without requiring a video', () => {
  const back = new FakeElement('span', '↶ 返回');
  const document = new FakeDocument([back], '已学习 00:15 要求学习 02:00');
  const view = fakeWindow(document);
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/examTask/75/5/1/4';
  const controller = new StudyController({ document, window: view });
  assert.equal(controller.start(1).state, 'running');
  assert.equal(controller.status().mode, 'article');
  assert.equal(controller.status().learnedSeconds, 15);
  document.body.innerText = '已学习 02:00 要求学习 02:00';
  view.runIntervals();
  assert.equal(back.clickCount, 1);
  assert.equal(controller.status().state, 'completed');
});

test('article pause and stop cancel counter polling and never return automatically', () => {
  for (const action of ['pause', 'stop']) {
    const back = new FakeElement('button', '返回');
    const document = new FakeDocument([back], '已学习 00:15 要求学习 02:00');
    const view = fakeWindow(document);
    view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/examTask/75/5/1/4';
    const controller = new StudyController({ document, window: view });
    controller.start(1);
    document.body.innerText = '已学习 02:00 要求学习 02:00';
    controller[action]();
    view.runIntervals();
    assert.equal(back.clickCount, 0, action);
    assert.equal(view.intervals.size, 0, action);
  }
});

test('article mode pauses with attention when its visible study timer remains stalled', () => {
  const back = new FakeElement('button', '返回');
  const document = new FakeDocument([back], '已学习 00:15 要求学习 02:00');
  const view = fakeWindow(document);
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/examTask/75/5/1/4';
  const controller = new StudyController({ document, window: view });
  controller.start(1);
  for (let index = 0; index < 60; index += 1) view.runIntervals();
  assert.equal(controller.status().state, 'needsAttention');
  assert.match(controller.status().reason, /计时未增长/);
  assert.equal(back.clickCount, 0);
});

test('AUTO_CONTINUE selects only an eligible catalog row after background acknowledges COURSE_PICKED', async () => {
  const first = catalogRow('课程甲', '微课堂', '已学习：00:01:00 / 00:08:00');
  const second = catalogRow('课程乙', '微课堂', '已学习：00:02:00 / 00:08:00');
  const fixture = catalogFixture([first.row, second.row]);
  const { activePage } = markUnlearnedTabSelected(fixture.document);
  attachCatalogPager(fixture.document, activePage);
  const view = fakeWindow(fixture.document);
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/examTask/75';
  const messages = [];
  const runtime = { sendMessage: async (message) => { messages.push(message); return { ok: true }; } };
  const completedFirstKey = chooseCourseRow(fixture.document).courseKey;
  const controller = new StudyController({ document: fixture.document, window: view, runtime });
  const result = await controller.autoContinue({ rate: 4, completedKeys: [completedFirstKey], completedPeriodIds: [], pendingKey: null });
  assert.equal(result.state, 'running', result.reason);
  assert.equal(first.button.clickCount, 0);
  assert.equal(second.button.clickCount, 1);
  assert.equal(messages[0].type, 'COURSE_PICKED');
  assert.match(messages[0].courseKey, /^course-/);
});

test('AUTO_CONTINUE fails closed when COURSE_PICKED is rejected and does not click the row', async () => {
  const row = catalogRow('课程甲', '微课堂', '已学习：00:01:00 / 00:08:00');
  const fixture = catalogFixture([row.row]);
  const { activePage } = markUnlearnedTabSelected(fixture.document);
  attachCatalogPager(fixture.document, activePage);
  const view = fakeWindow(fixture.document);
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/examTask/75';
  const controller = new StudyController({ document: fixture.document, window: view, runtime: { sendMessage: async () => ({ ok: false }) } });
  assert.equal((await controller.autoContinue({ rate: 1 })).state, 'needsAttention');
  assert.equal(row.button.clickCount, 0);
});

test('catalog waits for a transient COURSE_PICKED rejection, then clicks only after acknowledgement', async () => {
  const row = catalogRow('课程甲', '微课堂', '已学习：00:01:00 / 00:08:00');
  const fixture = catalogFixture([row.row]);
  const { activePage } = markUnlearnedTabSelected(fixture.document);
  attachCatalogPager(fixture.document, activePage);
  const view = fakeWindow(fixture.document);
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/examTask/75';
  let attempts = 0;
  const controller = new StudyController({ document: fixture.document, window: view, runtime: {
    sendMessage: async () => (++attempts === 1 ? { ok: false, reason: 'tab-unavailable' } : { ok: true, session: {} }),
  } });
  const continuing = controller.autoContinue({ rate: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(row.button.clickCount, 0);
  assert.equal(view.timers.size, 1);
  view.runTimers();
  assert.equal((await continuing).state, 'running');
  assert.equal(attempts, 2);
  assert.equal(row.button.clickCount, 1);
});

test('catalog stops without clicking when a missing session cannot be recovered', async () => {
  const row = catalogRow('课程甲', '微课堂', '已学习：00:01:00 / 00:08:00');
  const fixture = catalogFixture([row.row]);
  const { activePage } = markUnlearnedTabSelected(fixture.document);
  attachCatalogPager(fixture.document, activePage);
  const view = fakeWindow(fixture.document);
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/examTask/75';
  let attempts = 0;
  const controller = new StudyController({ document: fixture.document, window: view, runtime: {
    sendMessage: async () => { attempts += 1; return { ok: false, reason: 'session-missing' }; },
  } });
  const status = await controller.autoContinue({ rate: 1 });
  assert.equal(status.state, 'needsAttention');
  assert.match(status.reason, /会话已丢失/);
  assert.equal(attempts, 3); // COURSE_PICKED, FLOW_RECOVER, then FLOW_ATTENTION.
  assert.equal(row.button.clickCount, 0);
});

test('catalog recovers one lost background session before choosing its next course', async () => {
  const row = catalogRow('课程甲', '微课堂', '已学习：00:01:00 / 00:08:00');
  const fixture = catalogFixture([row.row]);
  const { activePage } = markUnlearnedTabSelected(fixture.document);
  attachCatalogPager(fixture.document, activePage);
  const view = fakeWindow(fixture.document);
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/examTask/75';
  const messages = [];
  const runIds = [];
  const controller = new StudyController({ document: fixture.document, window: view, runtime: {
    sendMessage: async (message) => {
      messages.push(message.type);
      runIds.push(message.runId);
      if (message.type === 'FLOW_RECOVER') return { ok: true, session: { phase: 'running' } };
      return messages.filter((type) => type === 'COURSE_PICKED').length === 1
        ? { ok: false, reason: 'session-missing' } : { ok: true, session: {} };
    },
  } });
  const status = await controller.autoContinue({ rate: 1, runId: 'run-current' });
  assert.equal(status.state, 'running');
  assert.deepEqual(messages, ['COURSE_PICKED', 'FLOW_RECOVER', 'COURSE_PICKED']);
  assert.deepEqual(runIds, ['run-current', 'run-current', 'run-current']);
  assert.equal(row.button.clickCount, 1);
});

test('AUTO_CONTINUE preserves session context while starting an exact course player route', async () => {
  const video = new FakeElement('video');
  const document = new FakeDocument([video], '已学习：00:01，要求学习：00:08');
  const view = fakeWindow(document);
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/coursePlayer?periodId=88';
  const controller = new StudyController({ document, window: view, runtime: { sendMessage: async () => ({ ok: true }) } });
  const result = await controller.autoContinue({ rate: 4, completedKeys: ['course-abcd1234'], completedPeriodIds: [], pendingKey: 'course-efgh5678' });
  assert.equal(result.state, 'running');
  assert.equal(result.mode, 'video');
  assert.equal(video.playbackRate, 4);
  assert.equal(controller.autoFlow, true);
  assert.equal(controller.autoContext.pendingKey, 'course-efgh5678');
  assert.equal(controller.autoContext.completedKeys.has('course-abcd1234'), true);
});

test('automatic player announces COURSE_COMPLETED once the visible timer meets the requirement', async () => {
  const video = new FakeElement('video');
  const home = new FakeElement('button', '返回课程主页');
  const document = new FakeDocument([video, home], '已学习：00:08，要求学习：00:08');
  const view = fakeWindow(document);
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/coursePlayer?periodId=88';
  const messages = [];
  const controller = new StudyController({ document, window: view, runtime: { sendMessage: async (message) => { messages.push(message.type); return { ok: true }; } } });
  await controller.autoContinue({ rate: 2, pendingKey: 'course-abc12345' });
  assert.deepEqual(messages, ['COURSE_COMPLETED']);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(home.clickCount, 1);
  assert.equal(controller.status().state, 'completed');
  assert.equal(controller.autoContext.completedKeys.has('course-abc12345'), true);
});

test('a previously confirmed player period is not replayed and marks its pending catalog key complete', async () => {
  const video = new FakeElement('video');
  const home = new FakeElement('button', '返回课程主页');
  const document = new FakeDocument([video, home], '已学习：00:08，要求学习：00:08');
  const view = fakeWindow(document);
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/coursePlayer?periodId=88';
  const messages = [];
  const controller = new StudyController({ document, window: view, runtime: { sendMessage: async (message) => { messages.push(message); return { ok: true }; } } });
  const status = await controller.autoContinue({ rate: 4, completedPeriodIds: ['88'], pendingKey: 'course-abc12345' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(status.state, 'completed');
  assert.equal(video.playCount, 0);
  assert.equal(home.clickCount, 1);
  assert.equal(messages[0].type, 'COURSE_COMPLETED');
  assert.equal(messages[0].periodId, '88');
  assert.equal(controller.autoContext.completedKeys.has('course-abc12345'), true);
});

test('a known completed article path is returned without replaying its material', async () => {
  const back = new FakeElement('button', '返回');
  const document = new FakeDocument([back], '已学习 00:15 要求学习 02:00');
  const view = fakeWindow(document);
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/examTask/75/5/1/4';
  const messages = [];
  const controller = new StudyController({ document, window: view, runtime: { sendMessage: async (message) => { messages.push(message); return { ok: true }; } } });
  const status = await controller.autoContinue({ rate: 1, completedPeriodIds: ['article-75-5-1-4'], pendingKey: 'course-article123' });
  assert.equal(status.state, 'completed');
  assert.equal(view.intervals.size, 0);
  assert.equal(back.clickCount, 1);
  assert.equal(messages[0].type, 'COURSE_COMPLETED');
  assert.equal(messages[0].periodId, 'article-75-5-1-4');
});

test('a known completed period is not skipped when background confirmation fails', async () => {
  const video = new FakeElement('video');
  const home = new FakeElement('button', '返回课程主页');
  const document = new FakeDocument([video, home], '已学习：00:08，要求学习：00:08');
  const view = fakeWindow(document);
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/coursePlayer?periodId=88';
  const controller = new StudyController({ document, window: view, runtime: { sendMessage: async () => ({ ok: false }) } });
  const status = await controller.autoContinue({ rate: 4, completedPeriodIds: ['88'], pendingKey: 'course-abc12345' });
  assert.equal(status.state, 'needsAttention');
  assert.equal(home.clickCount, 0);
  assert.equal(video.playCount, 0);
  assert.equal(controller.autoContext.completedKeys.has('course-abc12345'), false);
});

test('automatic article observes its counter without entering the video replacement wait', async () => {
  const back = new FakeElement('button', '返回');
  const document = new FakeDocument([back], '已学习 00:15 要求学习 02:00');
  const view = fakeWindow(document);
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/examTask/75/5/1/4';
  const controller = new StudyController({ document, window: view, runtime: { sendMessage: async () => ({ ok: true }) } });
  await controller.autoContinue({ rate: 1 });
  view.observers[0].trigger();
  assert.equal(controller.status().state, 'running');
  assert.equal(controller.status().mode, 'article');
  assert.equal(view.timers.size, 0);
});

test('SPA return from a completed article resumes catalog flow after FLOW_COMPLETE acknowledgement', async () => {
  const back = new FakeElement('button', '返回');
  const article = new FakeDocument([back], '已学习 02:00 要求学习 02:00');
  const view = fakeWindow(article);
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/examTask/75/5/1/4';
  const messages = [];
  const runtime = { sendMessage: async (message) => { messages.push(message.type); return { ok: true }; } };
  const controller = new StudyController({ document: article, window: view, runtime });
  await controller.autoContinue({ rate: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.status().state, 'completed');
  assert.equal(back.clickCount, 1);

  const catalog = catalogFixture([]);
  markUnlearnedTabSelected(catalog.document);
  controller.document = catalog.document;
  view.document = catalog.document;
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/examTask/75';
  controller._onMutation();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(messages, ['COURSE_COMPLETED', 'FLOW_COMPLETE']);
  assert.equal(controller.status().state, 'completed');
});

test('catalog proceeds and picks a row when the site renders no unlearned tab', async () => {
  const row = catalogRow('课程甲', '微课堂', '已学习：00:01:00 / 00:08:00');
  const fixture = catalogFixture([row.row]);
  const view = fakeWindow(fixture.document);
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/examTask/75';
  const messages = [];
  const controller = new StudyController({ document: fixture.document, window: view, runtime: { sendMessage: async (message) => { messages.push(message.type); return { ok: true }; } } });
  const status = await controller.autoContinue({ rate: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(status.state, 'running');
  assert.equal(row.button.clickCount, 1);
  assert.deepEqual(messages, ['COURSE_PICKED']);
});

test('catalog stops with attention when the unlearned tab is ambiguous', async () => {
  const row = catalogRow('课程甲', '微课堂', '已学习：00:01:00 / 00:08:00');
  const fixture = catalogFixture([row.row]);
  const original = fixture.document.querySelectorAll.bind(fixture.document);
  const tabA = new CatalogElement('div', '未学习');
  const tabB = new CatalogElement('div', '未学 (3)');
  fixture.document.querySelectorAll = (selector) => {
    if (selector === '.el-tabs__item, .ivu-tabs-tab, [role="tab"]') return [tabA, tabB];
    return original(selector);
  };
  const view = fakeWindow(fixture.document);
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/examTask/75';
  const messages = [];
  const controller = new StudyController({ document: fixture.document, window: view, runtime: { sendMessage: async (message) => { messages.push(message.type); return { ok: true }; } } });
  const status = await controller.autoContinue({ rate: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(status.state, 'needsAttention');
  assert.match(status.reason, /未学/);
  assert.equal(row.button.clickCount, 0);
  assert.ok(messages.includes('FLOW_ATTENTION'));
});

test('catalog clicks an inactive unlearned tab and waits before selecting rows', async () => {
  const row = catalogRow('课程甲', '微课堂', '已学习：00:01:00 / 00:08:00');
  const fixture = catalogFixture([row.row]);
  const original = fixture.document.querySelectorAll.bind(fixture.document);
  const tab = new CatalogElement('div', '未学');
  fixture.document.querySelectorAll = (selector) => {
    if (selector === '.el-tabs__item, .ivu-tabs-tab, [role="tab"]') return [tab];
    return original(selector);
  };
  const view = fakeWindow(fixture.document);
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/examTask/75';
  const controller = new StudyController({ document: fixture.document, window: view, runtime: { sendMessage: async () => ({ ok: true }) } });
  const status = await controller.autoContinue({ rate: 1 });
  assert.equal(status.state, 'running');
  assert.equal(tab.clickCount, 1);
  assert.equal(row.button.clickCount, 0, 'waits for the tab switch to settle first');
});

test('a single-page catalog without pagination completes without page controls', async () => {
  const fixture = catalogFixture([]);
  const view = fakeWindow(fixture.document);
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/examTask/75';
  const messages = [];
  const controller = new StudyController({ document: fixture.document, window: view, runtime: { sendMessage: async (message) => { messages.push(message.type); return { ok: true }; } } });
  const status = await controller.autoContinue({ rate: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(status.state, 'completed');
  assert.deepEqual(messages, ['FLOW_COMPLETE']);
});

function dialogDocument({ withButton = true, buttonText = '确定' } = {}) {
  const video = new FakeElement('video');
  const home = new FakeElement('button', '返回课程主页');
  const confirm = new CatalogElement('button', buttonText);
  const box = new CatalogElement('div', '视频已经播放完毕，请选择其他视频！');
  box.className = 'el-message-box';
  if (withButton) box.childrenBySelector['button, [role="button"]'] = [confirm];
  const document = {
    querySelectorAll(selector) {
      if (selector === 'video') return [video];
      if (selector === 'div') return [box];
      if (selector === 'button, a, [role="button"], *') return withButton ? [home, confirm] : [home];
      if (selector === 'iframe, frame') return [];
      return [];
    },
    body: { innerText: '已学习：02:34，要求学习：24:00。视频已经播放完毕，请选择其他视频！' },
    documentElement: {},
  };
  return { document, video, home, confirm, box };
}

test('the platform finished-video dialog is confirmed before returning to the catalog', async () => {
  const { document, video, home, confirm, box } = dialogDocument();
  let dismissed = false;
  confirm.click = () => {
    confirm.clickCount += 1;
    dismissed = true;
  };
  const baseQuery = document.querySelectorAll.bind(document);
  document.querySelectorAll = (selector) => {
    if (selector === 'div') return dismissed ? [] : [box];
    return baseQuery(selector);
  };
  const view = fakeWindow(document);
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/coursePlayer?periodId=4';
  const controller = new StudyController({ document, window: view, runtime: { sendMessage: async () => ({ ok: true }) } });
  await controller.autoContinue({ rate: 3.5, pendingKey: 'course-ab12' });
  video.ended = true;
  video.emit('ended');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(confirm.clickCount, 1, 'the dialog confirm button is pressed once');
  assert.equal(home.clickCount, 1);
  assert.equal(controller.status().state, 'switching');
});

test('a platform dialog without a confirmable button stops with attention instead of guessing', async () => {
  const { document, video, home } = dialogDocument({ withButton: false });
  const view = fakeWindow(document);
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/coursePlayer?periodId=4';
  const controller = new StudyController({ document, window: view, runtime: { sendMessage: async () => ({ ok: true }) } });
  await controller.autoContinue({ rate: 3.5, pendingKey: 'course-ab12' });
  video.ended = true;
  video.emit('ended');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.status().state, 'needsAttention');
  assert.match(controller.status().reason, /弹窗/);
  assert.equal(home.clickCount, 0);
});

test('a lingering dialog on the catalog is dismissed before row selection resumes', async () => {
  const row = catalogRow('课程甲', '微课堂', '已学习：00:01:00 / 00:08:00');
  const fixture = catalogFixture([row.row]);
  const confirm = new CatalogElement('button', '确定');
  const box = new CatalogElement('div', '视频已经播放完毕，请选择其他视频！');
  box.className = 'el-message-box';
  box.childrenBySelector['button, [role="button"]'] = [confirm];
  const original = fixture.document.querySelectorAll.bind(fixture.document);
  fixture.document.querySelectorAll = (selector) => {
    if (selector === 'div') return [box];
    return original(selector);
  };
  const view = fakeWindow(fixture.document);
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/examTask/75';
  const controller = new StudyController({ document: fixture.document, window: view, runtime: { sendMessage: async () => ({ ok: true }) } });
  const status = await controller.autoContinue({ rate: 1 });
  assert.equal(status.state, 'running');
  assert.equal(confirm.clickCount, 1);
  assert.equal(row.button.clickCount, 0, 'selection waits for the next mutation after dismissal');
});

function ivuCatalogFixture(rows) {
  const headerRow = new CatalogElement('tr', '', {
    childrenBySelector: {
      'th, [role="columnheader"]': ['名称', '学习模块', '学习进度', '操作'].map((label) => new CatalogElement('th', label)),
    },
  });
  const headerTable = new CatalogElement('table', '', {
    childrenBySelector: { 'tr, [role="row"]': [headerRow] },
  });
  const tipTable = new CatalogElement('table', '', { childrenBySelector: { 'tr, [role="row"]': [] } });
  const bodyTable = new CatalogElement('table', '', {
    childrenBySelector: { 'tr, [role="row"]': rows },
  });
  const header = new CatalogElement('div', '', { childrenBySelector: { 'table, [role="table"], [role="grid"]': [headerTable] } });
  header.className = 'ivu-table-header';
  const tip = new CatalogElement('div', '', { childrenBySelector: { 'table, [role="table"], [role="grid"]': [tipTable] } });
  tip.className = 'ivu-table-tip';
  const body = new CatalogElement('div', '', { childrenBySelector: { 'table, [role="table"], [role="grid"]': [bodyTable] } });
  body.className = 'ivu-table-body';
  const container = new CatalogElement('div', '', {
    childrenBySelector: {
      '.el-table__header-wrapper, .ivu-table-header': [header],
      '.el-table__body-wrapper, .ivu-table-body': [body],
    },
  });
  container.className = 'ivu-table';
  const activePage = new CatalogElement('li', '1');
  activePage.className = 'ivu-page-item ivu-page-item-active';
  const nextPage = new CatalogElement('li', '>');
  nextPage.className = 'ivu-page-next';
  const pager = new CatalogElement('ul', '', {
    childrenBySelector: { '.el-pagination .number, .ivu-page .ivu-page-item': [activePage] },
  });
  pager.className = 'ivu-page';
  activePage.parentElement = pager;
  nextPage.parentElement = pager;
  const document = {
    querySelectorAll(selector) {
      if (selector === '.el-table__header-wrapper, .ivu-table-header') return [header];
      if (selector === '.el-table__body-wrapper, .ivu-table-body') return [body];
      if (selector === '.el-table, .ivu-table') return [container];
      if (selector === 'table, [role="table"], [role="grid"]') return [headerTable, tipTable, bodyTable];
      if (selector === '.el-pagination, .ivu-page') return [pager];
      if (selector === '.ivu-page .ivu-page-item-active') return [activePage];
      if (selector === '.el-pagination .number, .ivu-page .ivu-page-item') return [activePage];
      if (selector === '.el-pagination .btn-next, .el-pagination [aria-label="下一页"], .ivu-page .ivu-page-next') return [nextPage];
      return [];
    },
  };
  return { document, container, header, body, pager, activePage, nextPage };
}

test('readCatalogRows joins iView header and body tables and finds course rows', () => {
  const row = catalogRow('机电、特种设备与其他安全 - 辐射安全', '微课堂', '已学习：00:00:00 / 00:12:00');
  const fixture = ivuCatalogFixture([row.row]);
  const rows = readCatalogRows(fixture.document);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].row, row.row);
  assert.equal(rows[0].button, row.button);
  assert.deepEqual([rows[0].learnedSeconds, rows[0].requiredSeconds], [0, 720]);
});

test('iView catalog flow picks the row and later advances via ivu-page next', async () => {
  const row = catalogRow('实验室安全文化与素养 - 前言', '微课堂', '已学习：00:00:00 / 00:03:00');
  const fixture = ivuCatalogFixture([row.row]);
  const view = fakeWindow(fixture.document);
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/examTask/75';
  const messages = [];
  const controller = new StudyController({ document: fixture.document, window: view, runtime: { sendMessage: async (message) => { messages.push(message.type); return { ok: true }; } } });
  const status = await controller.autoContinue({ rate: 16 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(status.state, 'running', status.reason);
  assert.equal(row.button.clickCount, 1);
  assert.deepEqual(messages, ['COURSE_PICKED']);
});

test('catalog retries while the course table is still rendering', async () => {
  const row = catalogRow('慢渲染课程', '微课堂', '已学习：00:00:00 / 00:05:00');
  const fixture = catalogFixture([row.row]);
  const original = fixture.document.querySelectorAll.bind(fixture.document);
  const roleTable = new CatalogElement('table', '', {
    childrenBySelector: {
      'tr, [role="row"]': [new CatalogElement('tr', '', {
        childrenBySelector: { 'th, [role="columnheader"]': ['角色名称', '操作'].map((label) => new CatalogElement('th', label)) },
      })],
    },
  });
  let slow = true;
  fixture.document.querySelectorAll = (selector) => {
    if (slow && selector === 'table, [role="table"], [role="grid"]') return [roleTable];
    return original(selector);
  };
  const view = fakeWindow(fixture.document);
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/examTask/75';
  const messages = [];
  const controller = new StudyController({ document: fixture.document, window: view, runtime: { sendMessage: async (message) => { messages.push(message.type); return { ok: true }; } } });
  const status = await controller.autoContinue({ rate: 1 });
  assert.equal(status.state, 'running');
  assert.equal(view.timers.size, 1, 'a retry is scheduled while the table is missing');
  slow = false;
  view.runTimers();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(row.button.clickCount, 1, 'picks the row once the table renders');
  assert.deepEqual(messages, ['COURSE_PICKED']);
});

test('a slow course navigation does not pause the session after the old ten-second limit', async () => {
  const row = catalogRow('慢跳转课程', '微课堂', '已学习：00:00:00 / 00:05:00');
  const fixture = catalogFixture([row.row]);
  const view = fakeWindow(fixture.document);
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/examTask/75';
  const controller = new StudyController({ document: fixture.document, window: view,
    runtime: { sendMessage: async () => ({ ok: true }) } });
  await controller.autoContinue({ rate: 1 });
  assert.equal(row.button.clickCount, 1);
  for (let index = 0; index < 25; index += 1) view.runTimers();
  assert.equal(controller.status().state, 'running');
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/person';
  view.runTimers();
  assert.equal(controller.status().state, 'running');
  assert.equal(controller.catalogSelecting, false);
});

test('catalog does not announce completion while an iView table header has an empty loading body', async () => {
  const course = catalogRow('课程甲', '微课堂', '已学习：00:00:00 / 00:08:00');
  const fixture = splitCatalogFixture([]);
  const view = fakeWindow(fixture.document);
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/examTask/75';
  const messages = [];
  const controller = new StudyController({ document: fixture.document, window: view,
    runtime: { sendMessage: async (message) => { messages.push(message.type); return { ok: true }; } } });
  await controller.autoContinue({ rate: 1 });
  assert.equal(controller.status().state, 'running');
  assert.equal(messages.includes('FLOW_COMPLETE'), false);
  fixture.bodyTable.childrenBySelector['tr, [role="row"]'] = [course.row];
  view.runTimers();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(course.button.clickCount, 1);
});

test('catalog gives up with attention after the table never appears', async () => {
  const fixture = catalogFixture([]);
  const original = fixture.document.querySelectorAll.bind(fixture.document);
  fixture.document.querySelectorAll = (selector) => {
    if (selector === 'table, [role="table"], [role="grid"]') return [];
    return original(selector);
  };
  const view = fakeWindow(fixture.document);
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/examTask/75';
  const controller = new StudyController({ document: fixture.document, window: view, runtime: { sendMessage: async () => ({ ok: true }) } });
  const status = await controller.autoContinue({ rate: 1 });
  assert.equal(status.state, 'running');
  for (let index = 0; index < 30; index += 1) view.runTimers();
  assert.equal(controller.status().state, 'needsAttention');
  assert.match(controller.status().reason, /目录表格/);
});

test('a page error requests the five-second automatic restart only once', async () => {
  const document = new FakeDocument([], '');
  const view = fakeWindow(document);
  const messages = [];
  const controller = new StudyController({ document, window: view,
    runtime: { sendMessage: async (message) => { messages.push(message.type); return { ok: true }; } } });
  controller.autoFlow = true;
  controller.autoContext = { runId: 'run-original' };
  controller.state = 'running';
  controller._setAttention('原始错误');
  controller._setAttention('次生错误');
  assert.equal(controller.status().reason, '原始错误');
  view.runTimers();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(messages, ['FLOW_ATTENTION', 'FLOW_AUTO_RESTART']);
});

test('AUTO_CONTINUE wakes a stopped controller instead of silently ignoring it', async () => {
  const video = new FakeElement('video');
  video.ended = true;
  const home = new FakeElement('button', '返回课程主页');
  const document = new FakeDocument([video, home], '已学习：02:34，要求学习：24:00。视频已经播放完毕，请选择其他视频！');
  const view = fakeWindow(document);
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/coursePlayer?periodId=4';
  const controller = new StudyController({ document, window: view, runtime: { sendMessage: async () => ({ ok: true }) } });
  controller.stop();
  const status = await controller.autoContinue({ rate: 3.5, pendingKey: 'course-ab12' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(video.playCount, 0, 'ended video is never replayed');
  assert.equal(home.clickCount, 1, 'the deferred course still returns to the catalog');
  assert.equal(controller.status().state, 'switching');
});

test('player start waits for a slowly appearing video instead of stopping', () => {
  const video = new FakeElement('video');
  const home = new FakeElement('button', '返回课程主页');
  const document = new FakeDocument([home], '已学习：00:01，要求学习：08:00');
  const view = fakeWindow(document);
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/coursePlayer?periodId=9';
  const controller = new StudyController({ document, window: view, runtime: { sendMessage: async () => ({ ok: true }) } });
  const status = controller.start(2);
  assert.equal(status.state, 'running', 'keeps running while the video has not loaded');
  assert.equal(view.timers.size, 1, 'a probe is scheduled');
  document.elements = [video, home];
  view.runTimers();
  assert.equal(video.playCount, 1, 'binds and plays once the video appears');
  assert.equal(video.playbackRate, 2);
});

test('a vanished video with a met timer still completes and returns', async () => {
  const video = new FakeElement('video');
  const home = new FakeElement('button', '返回课程主页');
  const document = new FakeDocument([video, home], '已学习：08:00，要求学习：08:00');
  const view = fakeWindow(document);
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/coursePlayer?periodId=9';
  const messages = [];
  const controller = new StudyController({ document, window: view, runtime: { sendMessage: async (message) => { messages.push(message.type); return { ok: true }; } } });
  await controller.autoContinue({ rate: 1, pendingKey: 'course-ab9999xy' });
  document.elements = [home];
  view.observers[0].trigger();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(home.clickCount, 1, 'completes from the visible timer even without a video element');
  assert.deepEqual(messages, ['COURSE_COMPLETED']);
  assert.equal(controller.autoContext.completedKeys.has('course-ab9999xy'), true);
});

test('a vanished video with the platform prompt defers and returns', async () => {
  const video = new FakeElement('video');
  const home = new FakeElement('button', '返回课程主页');
  const document = new FakeDocument([video, home], '已学习：02:34，要求学习：24:00');
  const view = fakeWindow(document);
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/coursePlayer?periodId=4';
  const messages = [];
  const controller = new StudyController({ document, window: view, runtime: { sendMessage: async (message) => { messages.push(message.type); return { ok: true }; } } });
  await controller.autoContinue({ rate: 3.5, pendingKey: 'course-ab12' });
  document.elements = [home];
  document.body.innerText = '已学习：02:34，要求学习：24:00。视频已经播放完毕，请选择其他视频！';
  view.observers[0].trigger();
  view.runTimers();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(home.clickCount, 1);
  assert.deepEqual(messages, ['COURSE_DEFERRED']);
  assert.equal(controller.status().state, 'switching');
});

test('a stalled article page with course rows clicks into its first unvisited subcourse', async () => {
  const row1 = new CatalogElement('li', '必学 辐射安全');
  const row2 = new CatalogElement('li', '必学 特种设备安全');
  const document = {
    querySelectorAll(selector) {
      if (selector === 'li, tr') return [row1, row2];
      return [];
    },
    body: { innerText: '已学习 00:00:00 要求学习 03:31:00' },
    documentElement: {},
  };
  const view = fakeWindow(document);
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/examTask/75/2/1/431';
  const controller = new StudyController({ document, window: view, runtime: { sendMessage: async () => ({ ok: true }) } });
  await controller.autoContinue({ rate: 1 });
  for (let index = 0; index < 5; index += 1) view.runIntervals();
  assert.equal(row1.clickCount, 0, 'a briefly stalled timer does not click yet');
  for (let index = 0; index < 10; index += 1) view.runIntervals();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(row1.clickCount, 1, 'clicks the first subcourse once stalled');
  assert.equal(row2.clickCount, 0, 'the second subcourse waits');
  assert.equal(view.intervals.size, 0, 'monitor stops while waiting for the route change');
});

test('a stalled module can enter a visible optional subcourse', async () => {
  const optional = new CatalogElement('li', '选学 实验室安全拓展');
  const document = {
    querySelectorAll(selector) { return selector === 'li, tr' ? [optional] : []; },
    body: { innerText: '已学习 00:00:00 要求学习 03:31:00' },
    documentElement: {},
  };
  const view = fakeWindow(document);
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/examTask/75/2/1/431';
  const controller = new StudyController({ document, window: view, runtime: { sendMessage: async () => ({ ok: true }) } });
  await controller.autoContinue({ rate: 1 });
  for (let index = 0; index < 15; index += 1) view.runIntervals();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(optional.clickCount, 1);
});

test('an article page whose timer keeps growing never clicks its course rows', async () => {
  const row1 = new CatalogElement('li', '必学 辐射安全');
  const bodyText = { innerText: '已学习 00:00:01 要求学习 03:31:00' };
  const document = {
    querySelectorAll(selector) {
      if (selector === 'li, tr') return [row1];
      return [];
    },
    body: bodyText,
    documentElement: {},
  };
  const view = fakeWindow(document);
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/examTask/75/2/1/431';
  const controller = new StudyController({ document, window: view, runtime: { sendMessage: async () => ({ ok: true }) } });
  await controller.autoContinue({ rate: 1 });
  for (let index = 0; index < 20; index += 1) {
    bodyText.innerText = `已学习 00:00:0${index % 10} 要求学习 03:31:00`;
    view.runIntervals();
  }
  assert.equal(row1.clickCount, 0, 'a growing timer keeps the page in plain wait mode');
});

test('a visible request-error dialog on an article page is dismissed automatically', async () => {
  const confirm = new CatalogElement('button', '确定');
  const box = new CatalogElement('div', '请求错误');
  box.className = 'el-message-box';
  box.childrenBySelector['button, [role="button"]'] = [confirm];
  let dismissed = false;
  confirm.click = () => {
    confirm.clickCount += 1;
    dismissed = true;
  };
  const document = {
    querySelectorAll(selector) {
      if (selector === 'div') return dismissed ? [] : [box];
      return [];
    },
    body: { innerText: '已学习 00:15 要求学习 02:00' },
    documentElement: {},
  };
  const view = fakeWindow(document);
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/examTask/75/5/1/4';
  const controller = new StudyController({ document, window: view, runtime: { sendMessage: async () => ({ ok: true }) } });
  await controller.autoContinue({ rate: 1 });
  view.runIntervals();
  assert.equal(confirm.clickCount, 1, 'the request-error dialog is confirmed once');
  assert.equal(controller.status().state, 'running');
});

test('module click waits for a real route change instead of the module page itself', async () => {
  const row1 = new CatalogElement('li', '必学 辐射安全');
  const document = {
    querySelectorAll(selector) {
      if (selector === 'li, tr') return [row1];
      return [];
    },
    body: { innerText: '已学习 00:00:00 要求学习 03:31:00' },
    documentElement: {},
  };
  const view = fakeWindow(document);
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/examTask/75/2/1/431';
  const controller = new StudyController({ document, window: view, runtime: { sendMessage: async () => ({ ok: true }) } });
  await controller.autoContinue({ rate: 1 });
  for (let index = 0; index < 15; index += 1) view.runIntervals();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(row1.clickCount, 1);
  view.runTimers();
  assert.ok(controller.catalogWait, 'the wait continues while the URL is unchanged');
  assert.equal(controller.status().state, 'running');
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/coursePlayer?periodId=77';
  view.runTimers();
  assert.ok(!controller.catalogWait, 'the wait resolves after a real route change');
  assert.equal(controller.status().state, 'running');
});

test('catalog handles a course button that changes the route synchronously', async () => {
  const course = catalogRow('课程甲', '微课堂', '已学习：00:00:00 / 00:08:00');
  const fixture = catalogFixture([course.row]);
  const view = fakeWindow(fixture.document);
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/examTask/75';
  course.button.click = () => {
    course.button.clickCount += 1;
    view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/coursePlayer?periodId=99';
  };
  const controller = new StudyController({ document: fixture.document, window: view,
    runtime: { sendMessage: async () => ({ ok: true }) } });
  await controller.autoContinue({ rate: 1 });
  view.runTimers();
  assert.equal(controller.catalogWait, null);
  assert.equal(controller.status().mode, 'video');
});

test('completed article return resumes at a different article route and checks stalled navigation', async () => {
  const back = new FakeElement('button', '返回');
  const document = new FakeDocument([back], '已学习 02:00 要求学习 02:00');
  const view = fakeWindow(document);
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/examTask/75/5/1/4';
  const controller = new StudyController({ document, window: view,
    runtime: { sendMessage: async () => ({ ok: true }) } });
  await controller.autoContinue({ rate: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(back.clickCount, 1);
  assert.equal(controller.status().state, 'completed');
  view.runTimers();
  assert.equal(controller.status().state, 'needsAttention', 'a return click that did nothing must not hang forever');
});

test('a request-error dialog raised by return is confirmed and the return is retried', async () => {
  const video = new FakeElement('video');
  const home = new FakeElement('button', '返回课程主页');
  const confirm = new FakeElement('button', '确定');
  const dialog = new FakeElement('div', '请求错误');
  dialog.className = 'ivu-modal';
  dialog.querySelectorAll = (selector) => selector === 'button, [role="button"]' ? [confirm] : [];
  confirm.parentElement = dialog;
  let active = false;
  const document = new FakeDocument([video, home], '已学习：00:08，要求学习：00:08');
  const originalQuery = document.querySelectorAll.bind(document);
  document.querySelectorAll = (selector) => selector === 'div' && active ? [dialog] : originalQuery(selector);
  const view = fakeWindow(document);
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/coursePlayer?periodId=45';
  home.click = () => {
    home.clickCount += 1;
    if (home.clickCount === 1) active = true;
    else view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/examTask/75';
  };
  confirm.click = () => { confirm.clickCount += 1; active = false; };
  const controller = new StudyController({ document, window: view,
    runtime: { sendMessage: async () => ({ ok: true }) } });
  await controller.autoContinue({ rate: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(home.clickCount, 1);
  controller._onMutation();
  assert.equal(confirm.clickCount, 1);
  view.runTimers();
  view.runTimers();
  assert.equal(home.clickCount, 2);
  assert.equal(view.location.href, 'https://labsafe.lzjtu.edu.cn/lab-study-front/examTask/75');
});

test('platform video pause at required time keeps progress monitoring active', async () => {
  const video = new FakeElement('video');
  const home = new FakeElement('button', '返回课程主页');
  const document = new FakeDocument([video, home], '已学习：00:01，要求学习：00:02');
  const view = fakeWindow(document);
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/coursePlayer?periodId=42';
  const controller = new StudyController({ document, window: view,
    runtime: { sendMessage: async () => ({ ok: true }) } });
  await controller.autoContinue({ rate: 1 });
  video.pause();
  document.body.innerText = '已学习：00:02，要求学习：00:02';
  view.runIntervals();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(home.clickCount, 1);
});

test('finishing a module child keeps the catalog parent pending for later subcourses', async () => {
  const video = new FakeElement('video');
  const home = new FakeElement('button', '返回课程主页');
  const document = new FakeDocument([video, home], '已学习：00:08，要求学习：00:08');
  const view = fakeWindow(document);
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/coursePlayer?periodId=46';
  const messages = [];
  const controller = new StudyController({ document, window: view,
    runtime: { sendMessage: async (message) => { messages.push(message); return { ok: true }; } } });
  await controller.autoContinue({ rate: 1, pendingKey: 'course-ab12', moduleParentPeriodId: 'article-75-2-1-431' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(home.clickCount, 1);
  assert.equal(controller.autoContext.pendingKey, 'course-ab12');
  assert.equal(controller.autoContext.completedKeys.has('course-ab12'), false);
  assert.equal(controller.autoContext.completedPeriodIds.has('46'), true);
  assert.equal(messages[0].type, 'COURSE_COMPLETED');
});

test('player waits for a delayed visible timer and return control', async () => {
  const video = new FakeElement('video');
  const home = new FakeElement('button', '返回课程主页');
  const document = new FakeDocument([video], '视频加载中');
  const view = fakeWindow(document);
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/coursePlayer?periodId=43';
  const controller = new StudyController({ document, window: view,
    runtime: { sendMessage: async () => ({ ok: true }) } });
  await controller.autoContinue({ rate: 1 });
  assert.equal(controller.status().state, 'running');
  document.body.innerText = '已学习：00:02，要求学习：00:02';
  view.runIntervals();
  assert.equal(controller.status().state, 'running');
  document.elements = [video, home];
  view.runIntervals();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(home.clickCount, 1);
});

test('player without a video keeps checking for a late return control after its timer meets the requirement', async () => {
  const home = new FakeElement('button', '返回课程主页');
  const document = new FakeDocument([], '已学习：00:08，要求学习：00:08');
  const view = fakeWindow(document);
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/coursePlayer?periodId=44';
  const controller = new StudyController({ document, window: view,
    runtime: { sendMessage: async () => ({ ok: true }) } });
  await controller.autoContinue({ rate: 1 });
  assert.equal(controller.status().state, 'running');
  document.elements = [home];
  view.runIntervals();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(home.clickCount, 1);
});

test('a stalled module page clicks the go-study button of its first row', async () => {
  const goButton = new CatalogElement('button', '去学习');
  const row1 = new CatalogElement('li', '必学 辐射安全 已学习：00:00:00 / 00:12:00');
  row1.childrenBySelector['button, a, [role="button"]'] = [goButton];
  goButton.parentElement = row1;
  const row2 = new CatalogElement('li', '必学 特种设备安全');
  const document = {
    querySelectorAll(selector) {
      if (selector === 'li, tr') return [row1, row2];
      if (selector === 'button, a, [role="button"]') return [goButton];
      return [];
    },
    body: { innerText: '已学习 00:00:00 要求学习 03:31:00' },
    documentElement: {},
  };
  const view = fakeWindow(document);
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/examTask/75/2/1/431';
  const controller = new StudyController({ document, window: view, runtime: { sendMessage: async () => ({ ok: true }) } });
  await controller.autoContinue({ rate: 1 });
  for (let index = 0; index < 15; index += 1) view.runIntervals();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(goButton.clickCount, 1, 'clicks the go-study button rather than the row');
  assert.equal(row1.clickCount, 0);
  assert.equal(controller.status().state, 'running');
});

test('module subcourse identity survives a changing study counter and skips completed rows', async () => {
  const firstButton = new CatalogElement('button', '去学习');
  const secondButton = new CatalogElement('button', '去学习');
  const first = new CatalogElement('li', '必学 辐射安全 已学习：00:00:00 / 00:12:00');
  const second = new CatalogElement('li', '必学 设备安全 已学习：00:00:00 / 00:15:00');
  firstButton.parentElement = first;
  secondButton.parentElement = second;
  const document = {
    querySelectorAll(selector) {
      if (selector === 'button, a, [role="button"]') return [firstButton, secondButton];
      if (selector === 'li, tr') return [first, second];
      return [];
    },
    body: { innerText: '已学习 00:00:00 要求学习 03:31:00' },
    documentElement: {},
  };
  const view = fakeWindow(document);
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/examTask/75/2/1/431';
  const controller = new StudyController({ document, window: view,
    runtime: { sendMessage: async () => ({ ok: true }) } });
  await controller.autoContinue({ rate: 1 });
  for (let index = 0; index < 15; index += 1) view.runIntervals();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(firstButton.clickCount, 1);
  first.innerText = first.textContent = '必学 辐射安全 已学习：00:01:00 / 00:12:00';
  controller._clearCatalogWait();
  controller.catalogSelecting = false;
  controller._startProgressMonitor();
  for (let index = 0; index < 15; index += 1) view.runIntervals();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(firstButton.clickCount, 1);
  assert.equal(secondButton.clickCount, 1);
});

test('a completed course page waits for its return control to render', async () => {
  const back = new FakeElement('button', '返回');
  const document = new FakeDocument([], '已学习 02:00 要求学习 02:00');
  const view = fakeWindow(document);
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/examTask/75/5/1/4';
  const messages = [];
  const controller = new StudyController({ document, window: view, runtime: { sendMessage: async (message) => { messages.push(message.type); return { ok: true }; } } });
  const status = await controller.autoContinue({ rate: 1, completedPeriodIds: ['article-75-5-1-4'], pendingKey: 'course-x1' });
  assert.equal(status.state, 'running', 'keeps waiting while the return control is missing');
  assert.equal(view.timers.size, 1, 'a retry is scheduled');
  document.elements = [back];
  view.runTimers();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(back.clickCount, 1, 'returns once the control renders');
  assert.equal(controller.status().state, 'completed');
  assert.deepEqual(messages, ['COURSE_COMPLETED']);
});

test('a nested ivu-modal confirm dialog is still dismissed through dedupe', async () => {
  const confirm = new CatalogElement('button', '确定');
  const inner = new CatalogElement('div', '请求错误');
  inner.className = 'ivu-modal-confirm';
  inner.childrenBySelector['button, [role="button"]'] = [confirm];
  const outer = new CatalogElement('div', '');
  outer.className = 'ivu-modal';
  outer.childrenBySelector['button, [role="button"]'] = [confirm];
  inner.parentElement = outer;
  let dismissed = false;
  confirm.click = () => { confirm.clickCount += 1; dismissed = true; };
  const document = {
    querySelectorAll(selector) {
      if (selector === 'div') return dismissed ? [] : [outer, inner];
      if (selector === 'video') return [];
      if (selector === 'button, a, [role="button"], *') return [confirm];
      return [];
    },
    body: { innerText: '已学习：00:15 要求学习：02:00' },
    documentElement: {},
  };
  const view = fakeWindow(document);
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/examTask/75/5/1/4';
  const controller = new StudyController({ document, window: view, runtime: { sendMessage: async () => ({ ok: true }) } });
  await controller.autoContinue({ rate: 1 });
  view.runIntervals();
  assert.equal(confirm.clickCount, 1, 'the nested dialog confirm is clicked once despite two matching containers');
  assert.equal(controller.status().state, 'running');
});

test('two independent dialogs each holding a confirm button stay blocked', async () => {
  const confirmA = new CatalogElement('button', '确定');
  const confirmB = new CatalogElement('button', '确定');
  const boxA = new CatalogElement('div', '请求错误');
  boxA.className = 'ivu-modal';
  boxA.childrenBySelector['button, [role="button"]'] = [confirmA];
  const boxB = new CatalogElement('div', '另一个弹窗');
  boxB.className = 'ivu-modal';
  boxB.childrenBySelector['button, [role="button"]'] = [confirmB];
  const document = {
    querySelectorAll(selector) {
      if (selector === 'div') return [boxA, boxB];
      if (selector === 'button, a, [role="button"], *') return [confirmA, confirmB];
      return [];
    },
    body: { innerText: '已学习：00:15 要求学习：02:00' },
    documentElement: {},
  };
  const view = fakeWindow(document);
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/examTask/75/5/1/4';
  const controller = new StudyController({ document, window: view, runtime: { sendMessage: async () => ({ ok: true }) } });
  await controller.autoContinue({ rate: 1 });
  view.runIntervals();
  assert.equal(confirmA.clickCount, 0, 'ambiguous dialogs are never guessed');
  assert.equal(confirmB.clickCount, 0);
  assert.equal(controller.status().state, 'needsAttention');
});

test('catalog skips a deferred unfinished row and opens another course without claiming completion', async () => {
  const first = catalogRow('欠时课程', '微课堂', '已学习：00:02:34 / 00:24:00');
  const second = catalogRow('下一门课程', '微课堂', '已学习：00:00:00 / 00:08:00');
  const fixture = catalogFixture([first.row, second.row]);
  markUnlearnedTabSelected(fixture.document);
  const deferredKey = chooseCourseRow(fixture.document).courseKey;
  const view = fakeWindow(fixture.document);
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/examTask/75';
  const messages = [];
  const runtime = { sendMessage: async (message) => { messages.push(message.type); return { ok: true }; } };
  const controller = new StudyController({ document: fixture.document, window: view, runtime });
  await controller.autoContinue({ rate: 3.5, deferredKeys: [deferredKey], deferredPeriodIds: ['4'] });
  assert.equal(first.button.clickCount, 0);
  assert.equal(second.button.clickCount, 1);
  assert.deepEqual(messages, ['COURSE_PICKED']);
});

test('catalog never reports all tasks complete while a deferred course remains unfinished', async () => {
  const row = catalogRow('欠时课程', '微课堂', '已学习：00:02:34 / 00:24:00');
  const fixture = catalogFixture([row.row]);
  markUnlearnedTabSelected(fixture.document);
  const deferredKey = chooseCourseRow(fixture.document).courseKey;
  const view = fakeWindow(fixture.document);
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/examTask/75';
  const messages = [];
  const runtime = { sendMessage: async (message) => { messages.push(message.type); return { ok: true }; } };
  const controller = new StudyController({ document: fixture.document, window: view, runtime });
  const status = await controller.autoContinue({ rate: 3.5, deferredKeys: [deferredKey], deferredPeriodIds: ['4'] });
  assert.equal(status.state, 'needsAttention');
  assert.equal(row.button.clickCount, 0);
  assert.deepEqual(messages, ['FLOW_ATTENTION']);
});

test('catalog advances after page content changes and completes only after traversing from page one', async () => {
  const fixture = catalogFixture([]);
  const { activePage } = markUnlearnedTabSelected(fixture.document);
  const next = new CatalogElement('button', '下一页');
  fixture.document.body = { innerText: '目录 第1页' };
  next.click = () => {
    next.clickCount += 1;
    activePage.textContent = '2';
    fixture.document.body.innerText = '目录 第2页';
    fixture.document.querySelectorAll = (selector) => {
      if (selector === '.el-pagination .btn-next, .el-pagination [aria-label="下一页"], .ivu-page .ivu-page-next') return [];
      return originalQuery(selector);
    };
  };
  attachCatalogPager(fixture.document, activePage, next);
  const originalQuery = fixture.document.querySelectorAll.bind(fixture.document);
  const view = fakeWindow(fixture.document);
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/examTask/75';
  const messages = [];
  const controller = new StudyController({ document: fixture.document, window: view, runtime: { sendMessage: async (message) => { messages.push(message.type); return { ok: true }; } } });
  await controller.autoContinue({ rate: 1 });
  assert.equal(next.clickCount, 1);
  assert.equal(controller.status().state, 'running');
  view.runTimers();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(messages, ['FLOW_COMPLETE']);
  assert.equal(controller.status().state, 'completed');
});

test('STOP cancels an outstanding catalog page wait and clears auto mode', async () => {
  const fixture = catalogFixture([]);
  const { activePage } = markUnlearnedTabSelected(fixture.document);
  const next = new CatalogElement('button', '下一页');
  attachCatalogPager(fixture.document, activePage, next);
  const view = fakeWindow(fixture.document);
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/examTask/75';
  const controller = new StudyController({ document: fixture.document, window: view, runtime: { sendMessage: async () => ({ ok: true }) } });
  await controller.autoContinue({ rate: 1 });
  assert.equal(view.timers.size, 1);
  controller.stop();
  assert.equal(view.timers.size, 0);
  assert.equal(controller.autoFlow, false);
  assert.equal(controller.status().state, 'stopped');
});

test('pausing a catalog transition clears its timer and resume rechecks the changed page', async () => {
  const fixture = catalogFixture([]);
  const { activePage } = markUnlearnedTabSelected(fixture.document);
  const next = new CatalogElement('button', '下一页');
  fixture.document.body = { innerText: '目录 第1页' };
  attachCatalogPager(fixture.document, activePage, next);
  const view = fakeWindow(fixture.document);
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/examTask/75';
  const messages = [];
  const controller = new StudyController({ document: fixture.document, window: view, runtime: { sendMessage: async (message) => { messages.push(message.type); return { ok: true }; } } });
  await controller.autoContinue({ rate: 1 });
  assert.equal(view.timers.size, 1);
  controller.pause();
  assert.equal(view.timers.size, 0);
  assert.equal(controller.pausedCatalogWait.previousSignature !== undefined, true);

  activePage.textContent = '2';
  fixture.document.body.innerText = '目录 第2页';
  next.disabled = true;
  controller.resume();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(messages, ['FLOW_COMPLETE']);
  assert.equal(controller.status().state, 'completed');
});

test('background AUTO_CONTINUE resumes a paused catalog transition on the same route', async () => {
  const fixture = catalogFixture([]);
  const { activePage } = markUnlearnedTabSelected(fixture.document);
  const next = new CatalogElement('button', '下一页');
  attachCatalogPager(fixture.document, activePage, next);
  const view = fakeWindow(fixture.document);
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/examTask/75';
  const controller = new StudyController({ document: fixture.document, window: view, runtime: { sendMessage: async () => ({ ok: true }) } });
  const context = { rate: 1, completedKeys: [], completedPeriodIds: [], pendingKey: null };
  await controller.autoContinue(context);
  controller.pause();
  const status = await controller.autoContinue(context);
  assert.equal(status.state, 'running');
  assert.equal(view.timers.size, 1);
  assert.equal(next.clickCount, 1, 'resume waits for the existing navigation instead of clicking again');
});

test('background AUTO_CONTINUE resumes paused video and article controllers on the same route', async () => {
  const video = new FakeElement('video');
  const videoDoc = new FakeDocument([video], '已学习：00:01，要求学习：00:08');
  const videoView = fakeWindow(videoDoc);
  videoView.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/coursePlayer?periodId=88';
  const videoController = new StudyController({ document: videoDoc, window: videoView, runtime: { sendMessage: async () => ({ ok: true }) } });
  const context = { rate: 2, completedKeys: [], completedPeriodIds: [], pendingKey: null };
  await videoController.autoContinue(context);
  videoController.pause();
  const videoStatus = await videoController.autoContinue(context);
  assert.equal(videoStatus.state, 'running');
  assert.equal(video.playCount, 2);

  const articleDoc = new FakeDocument([], '已学习 00:15 要求学习 02:00');
  const articleView = fakeWindow(articleDoc);
  articleView.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/examTask/75/5/1/4';
  const articleController = new StudyController({ document: articleDoc, window: articleView, runtime: { sendMessage: async () => ({ ok: true }) } });
  await articleController.autoContinue(context);
  articleController.pause();
  const articleStatus = await articleController.autoContinue(context);
  assert.equal(articleStatus.state, 'running');
  assert.equal(articleView.intervals.size, 1);
});

test('readCatalogRows recognizes screenshot-like course rows and returns only safe short hashes', () => {
  const first = catalogRow('知更鸟晴歌', '第一章', '已学习：00:04:00 / 00:23:00');
  const finished = catalogRow('已完成课程', '第二章', '已学习：00:23:00 / 00:23:00');
  const optional = catalogRow('选修内容', '第三章', '已学习：00:00:00 / 00:12:00', { tag: '选学' });
  const invalid = catalogRow('格式不明', '第四章', '已学习：00:04:00');
  const { document } = catalogFixture([first.row, finished.row, optional.row, invalid.row]);

  const rows = readCatalogRows(document);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].row, first.row);
  assert.equal(rows[1].row, optional.row);
  assert.equal(rows[0].button, first.button);
  assert.deepEqual([rows[0].learnedSeconds, rows[0].requiredSeconds], [240, 1380]);
  assert.match(rows[0].courseKey, /^course-[a-z0-9]{1,8}$/);
  assert.equal(rows[0].courseKey.includes('知更鸟晴歌'), false);
  assert.equal(rows[0].courseKey.includes('第一章'), false);
});

test('chooseCourseRow picks the first eligible row and skips completed session keys', () => {
  const first = catalogRow('课程甲', '模块甲', '已学习：00:01:00 / 00:08:00');
  const second = catalogRow('课程乙', '模块乙', '已学习：00:02:00 / 00:08:00');
  const { document } = catalogFixture([first.row, second.row]);
  const firstKey = readCatalogRows(document)[0].courseKey;

  assert.equal(chooseCourseRow(document).row, first.row);
  assert.equal(chooseCourseRow(document, null, new Set([firstKey])).row, second.row);
  assert.equal(chooseCourseRow(document, null, new Set([firstKey, readCatalogRows(document)[1].courseKey])), null);
});

test('chooseCourseRow continues from required courses to optional rows without a type tag', () => {
  const required = catalogRow('必修课程', '模块甲', '已学习：00:00:00 / 00:08:00');
  const optional = catalogRow('中华人民共和国环境保护法（2014修正）', '法律法规', '已学习：00:00:00 / 00:02:00', { tag: '' });
  const { document } = catalogFixture([required.row, optional.row]);
  const requiredKey = readCatalogRows(document)[0].courseKey;
  assert.equal(chooseCourseRow(document).row, required.row);
  assert.equal(chooseCourseRow(document, null, new Set([requiredKey])).row, optional.row);
});

test('catalog selection rejects ambiguous rows, disabled controls, exams, and hidden candidates', () => {
  const ambiguous = catalogRow('有歧义', '模块', '已学习：00:01:00 / 00:08:00', {
    buttons: [new CatalogElement('button', '去学习'), new CatalogElement('button', '去学习')],
  });
  const disabled = catalogRow('禁用课程', '模块', '已学习：00:01:00 / 00:08:00', { disabled: true });
  const exam = catalogRow('考试入口', '模块', '已学习：00:01:00 / 00:08:00', {
    buttons: [new CatalogElement('button', '去学习 考试')],
  });
  const hidden = catalogRow('隐藏课程', '模块', '已学习：00:01:00 / 00:08:00', { hidden: true });
  const { document } = catalogFixture([ambiguous.row, disabled.row, exam.row, hidden.row]);

  assert.deepEqual(readCatalogRows(document), []);
  assert.equal(chooseCourseRow(document), null);
});

test('catalog selection rejects rows hidden by a transparent ancestor', () => {
  const candidate = catalogRow('透明祖先下的课程', '章节', '已学习：00:01:00 / 00:08:00');
  const { document } = catalogFixture([candidate.row]);
  candidate.row.parentElement = new CatalogElement('div', '', { style: { opacity: '0' } });
  assert.deepEqual(readCatalogRows(document), []);
});

test('course rows require the recognized headers and exactly one progress pair', () => {
  const row = catalogRow('课程', '模块', '已学习：00:01:00 / 00:08:00；已学习：00:02:00 / 00:08:00');
  const { document, table } = catalogFixture([row.row]);
  table.querySelectorAll = (selector) => selector === 'tr, [role="row"]' ? [row.row] : [];
  assert.deepEqual(readCatalogRows(document), []);

  const invalidTable = new CatalogElement('table', '', {
    childrenBySelector: { 'tr, [role="row"]': [row.row] },
  });
  invalidTable.children[0] = new CatalogElement('tr', '', {
    childrenBySelector: { 'th, [role="columnheader"]': ['名称', '进度', '学习模块', '操作'].map((label) => new CatalogElement('th', label)) },
  });
  const invalidDoc = { querySelectorAll: (selector) => selector === 'table, [role="table"], [role="grid"]' ? [invalidTable] : [] };
  assert.deepEqual(readCatalogRows(invalidDoc), []);

  const validTable = catalogFixture([catalogRow('课程甲', '模块甲', '已学习：00:01:00 / 00:08:00').row]).table;
  const secondTable = catalogFixture([]).table;
  const ambiguousDoc = {
    querySelectorAll: (selector) => selector === 'table, [role="table"], [role="grid"]' ? [validTable, secondTable] : [],
  };
  assert.deepEqual(readCatalogRows(ambiguousDoc), []);
});

test('readCatalogRows joins Element UI header and body tables and rejects ambiguous wrappers', () => {
  const first = catalogRow('分离表格课程', '章节一', '已学习：00:04:00 / 00:23:00');
  const second = catalogRow('第二行课程', '章节二', '已学习：00:02:00 / 00:20:00');
  const fixture = splitCatalogFixture([first.row, second.row]);

  const rows = readCatalogRows(fixture.document);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].row, first.row);
  assert.equal(rows[1].row, second.row);

  const duplicateHeader = new CatalogElement('div', '', {
    childrenBySelector: { 'table, [role="table"], [role="grid"]': [fixture.headerTable] },
  });
  duplicateHeader.className = 'el-table__header-wrapper';
  const ambiguous = splitCatalogFixture([first.row], { headerWrappers: [fixture.headerWrapper, duplicateHeader] });
  assert.deepEqual(readCatalogRows(ambiguous.document), []);
});

test('catalog does not clear the session while unfinished progress is visible but its action button is loading', async () => {
  const row = catalogRow('待加载课程', '安全知识', '已学习：00:00:00 / 00:03:00', { disabled: true });
  const fixture = catalogFixture([row.row]);
  markUnlearnedTabSelected(fixture.document);
  const view = fakeWindow(fixture.document);
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/examTask/75';
  const messages = [];
  const controller = new StudyController({ document: fixture.document, window: view, runtime: {
    sendMessage: async (message) => { messages.push(message.type); return { ok: true }; },
  } });
  const status = await controller.autoContinue({ rate: 1 });
  assert.equal(status.state, 'running');
  assert.equal(row.button.clickCount, 0);
  assert.equal(view.timers.size, 1);
  assert.deepEqual(messages, []);
});

test('catalog ignores hidden duplicate table wrappers left by a previous page render', () => {
  const course = catalogRow('下一门课程', '安全知识', '已学习：00:00:00 / 00:03:00');
  const visible = splitCatalogFixture([course.row]);
  const hiddenHeader = new CatalogElement('div', '', {
    hidden: true,
    childrenBySelector: { 'table, [role="table"], [role="grid"]': [visible.headerTable] },
  });
  hiddenHeader.className = 'ivu-table-header';
  const hiddenBody = new CatalogElement('div', '', {
    hidden: true,
    childrenBySelector: { 'table, [role="table"], [role="grid"]': [visible.bodyTable] },
  });
  hiddenBody.className = 'ivu-table-body';
  const fixture = splitCatalogFixture([course.row], {
    headerWrappers: [visible.headerWrapper, hiddenHeader],
    bodyWrappers: [visible.bodyWrapper, hiddenBody],
  });
  const view = fakeWindow(fixture.document);
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/examTask/75';
  assert.equal(hasRecognizedCatalogTable(fixture.document, view), true);
  assert.equal(readCatalogRows(fixture.document, view).length, 1);
  const catalog = new StudyController({ document: fixture.document, window: view }).diagnose().catalog;
  assert.equal(catalog.headerWrapperCount, 2);
  assert.equal(catalog.visibleHeaderWrapperCount, 1);
  assert.equal(catalog.recognized, true);
  assert.equal(catalog.eligibleRowCount, 1);
});

test('chooseCatalogNextPage only accepts one visible enabled next control inside pagination', () => {
  const next = new CatalogElement('button', '下一页', { attrs: { 'aria-label': '下一页' } });
  const disabled = new CatalogElement('button', '', { attrs: { 'aria-label': '下一页', 'aria-disabled': 'true' } });
  const classDisabled = new CatalogElement('li', '>');
  classDisabled.className = 'ivu-page-next ivu-page-disabled';
  const pager = new CatalogElement('div', '', { childrenBySelector: { '.btn-next, [aria-label="下一页"]': [next] } });
  pager.className = 'el-pagination';
  next.parentElement = pager;
  disabled.parentElement = pager;
  classDisabled.parentElement = pager;
  const ivuPager = new CatalogElement('ul', '');
  ivuPager.className = 'ivu-page';
  const otherNext = new CatalogElement('button', '', { attrs: { 'aria-label': '下一页' } });
  otherNext.parentElement = ivuPager;
  const NEXT_SELECTOR = '.el-pagination .btn-next, .el-pagination [aria-label="下一页"], .ivu-page .ivu-page-next';
  const doc = { querySelectorAll: (selector) => selector === NEXT_SELECTOR ? [next] : [] };
  assert.equal(chooseCatalogNextPage(doc), next);
  assert.equal(chooseCatalogNextPage({ querySelectorAll: () => [next, otherNext] }), null);
  assert.equal(chooseCatalogNextPage({ querySelectorAll: () => [disabled] }), null);
  assert.equal(chooseCatalogNextPage({ querySelectorAll: () => [classDisabled] }), null, 'ivu class-based disabled is rejected');
  assert.equal(chooseCatalogNextPage({ querySelectorAll: () => [new CatalogElement('button', '下一页')] }), null);
});

test('chooseReturnHome accepts one visible enabled exact return control only', () => {
  const home = new FakeElement('button', '返回课程主页');
  assert.equal(chooseReturnHome(new FakeDocument([home])), home);
  assert.equal(chooseReturnHome(new FakeDocument([home, new FakeElement('a', '返回课程主页')])), null);
  assert.equal(chooseReturnHome(new FakeDocument([new FakeElement('button', '确认返回课程主页')])), null);
  assert.equal(chooseReturnHome(new FakeDocument([new FakeElement('button', '返回课程主页', { disabled: true })])), null);
});

test('chooseReturnHome lets exact nested text bubble when the clickable parent is unknown', () => {
  const container = new FakeElement('div', '返回课程主页');
  const leaf = new FakeElement('span', '返回课程主页', { parentElement: container });
  container.children = [leaf];
  assert.equal(chooseReturnHome(new FakeDocument([container, leaf])), leaf);
});

test('manual player stops when video ends before study counter reaches requirement', () => {
  const video = new FakeElement('video');
  const home = new FakeElement('button', '返回课程主页');
  const document = new FakeDocument([video, home], '已学习：07:56，要求学习：12:00');
  const view = fakeWindow(document);
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/coursePlayer?course=1';
  const controller = new StudyController({ document, window: view });
  assert.equal(controller.start(2).state, 'running');
  video.ended = true;
  video.emit('ended');
  assert.equal(home.clickCount, 0);
  assert.equal(video.playCount, 1);
  assert.equal(controller.status().state, 'needsAttention');
  video.emit('ended');
  assert.equal(video.playCount, 1, 'duplicate ended notifications do not initiate a replay');
  document.body.innerText = '已学习：12:00，要求学习：12:00';
  view.runIntervals();
  assert.equal(home.clickCount, 0, 'the stopped controller never reports completion');
});

test('platform-completed video with insufficient study time is deferred instead of replayed', async () => {
  const video = new FakeElement('video');
  const home = new FakeElement('button', '返回课程主页');
  const document = new FakeDocument([video, home], '已学习：02:34，要求学习：24:00');
  const view = fakeWindow(document);
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/coursePlayer?periodId=4&requireStudyLength=1440&studyLength=154&examId=75';
  const messages = [];
  const runtime = { sendMessage: async (message) => { messages.push(message); return { ok: true }; } };
  const controller = new StudyController({ document, window: view, runtime });
  await controller.autoContinue({ rate: 3.5, completedKeys: [], completedPeriodIds: [], deferredKeys: [], deferredPeriodIds: [], pendingKey: 'course-ab12' });
  document.body.innerText += '。视频已经播放完毕，请选择其他视频！';
  video.ended = true;
  video.emit('ended');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(video.playCount, 1, 'the completed video must not be played a second time');
  assert.deepEqual(messages.map((message) => message.type), ['COURSE_DEFERRED']);
  assert.equal(home.clickCount, 1);
  assert.equal(controller.status().state, 'switching');
});

test('starting on an already-ended video does not replay it or remain stuck on the platform modal', async () => {
  const video = new FakeElement('video');
  video.ended = true;
  const home = new FakeElement('button', '返回课程主页');
  const document = new FakeDocument([video, home], '已学习：02:34，要求学习：24:00。视频已经播放完毕，请选择其他视频！');
  const view = fakeWindow(document);
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/coursePlayer?periodId=4';
  const messages = [];
  const runtime = { sendMessage: async (message) => { messages.push(message.type); return { ok: true }; } };
  const controller = new StudyController({ document, window: view, runtime });
  await controller.autoContinue({ rate: 3.5, pendingKey: 'course-ab12' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(video.playCount, 0);
  assert.deepEqual(messages, ['COURSE_DEFERRED']);
  assert.equal(home.clickCount, 1);
  assert.equal(controller.status().state, 'switching');
});

test('a visible platform finished-video prompt is honored even if the media element reset ended', async () => {
  const video = new FakeElement('video');
  const home = new FakeElement('button', '返回课程主页');
  const document = new FakeDocument([video, home], '已学习：02:34，要求学习：24:00。视频已经播放完毕，请选择其他视频！');
  const view = fakeWindow(document);
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/coursePlayer?periodId=4';
  const messages = [];
  const runtime = { sendMessage: async (message) => { messages.push(message.type); return { ok: true }; } };
  const controller = new StudyController({ document, window: view, runtime });
  await controller.autoContinue({ rate: 3.5, pendingKey: 'course-ab12' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(video.playCount, 0);
  assert.deepEqual(messages, ['COURSE_DEFERRED']);
  assert.equal(home.clickCount, 1);
});

test('resuming a paused deferred period returns to catalog without replaying the ended video', async () => {
  const video = new FakeElement('video');
  const home = new FakeElement('button', '返回课程主页');
  const document = new FakeDocument([video, home], '已学习：02:34，要求学习：24:00');
  const view = fakeWindow(document);
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/coursePlayer?periodId=4';
  let confirmDeferral;
  const runtime = { sendMessage: async (message) => {
    if (message.type === 'COURSE_DEFERRED' && !confirmDeferral) {
      return new Promise((resolve) => { confirmDeferral = resolve; });
    }
    return { ok: true };
  } };
  const controller = new StudyController({ document, window: view, runtime });
  await controller.autoContinue({ rate: 3.5, pendingKey: 'course-ab12' });
  video.ended = true;
  video.emit('ended');
  controller.pause();
  confirmDeferral({ ok: true });
  await new Promise((resolve) => setImmediate(resolve));
  const status = await controller.autoContinue({ rate: 3.5, deferredKeys: ['course-ab12'], deferredPeriodIds: ['4'], pendingKey: null });
  assert.equal(status.state, 'switching');
  assert.equal(video.playCount, 1);
  assert.equal(home.clickCount, 1);
});

test('deferred course reports attention if the return control does not navigate', async () => {
  const video = new FakeElement('video');
  const home = new FakeElement('button', '返回课程主页');
  const document = new FakeDocument([video, home], '已学习：02:34，要求学习：24:00');
  const view = fakeWindow(document);
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/coursePlayer?periodId=4';
  const messages = [];
  const runtime = { sendMessage: async (message) => { messages.push(message.type); return { ok: true }; } };
  const controller = new StudyController({ document, window: view, runtime });
  await controller.autoContinue({ rate: 3.5, pendingKey: 'course-ab12' });
  video.ended = true;
  video.emit('ended');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(home.clickCount, 1);
  assert.equal(view.timers.size, 1);
  view.runTimers();
  assert.equal(controller.status().state, 'needsAttention');
  assert.deepEqual(messages, ['COURSE_DEFERRED', 'FLOW_ATTENTION']);
});

test('player ignores a dispatched ended event before the video naturally reaches its end', () => {
  const video = new FakeElement('video');
  video.duration = 120;
  video.currentTime = 20;
  const home = new FakeElement('button', '返回课程主页');
  const document = new FakeDocument([video, home], '已学习：07:56，要求学习：12:00');
  const view = fakeWindow(document);
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/coursePlayer';
  const controller = new StudyController({ document, window: view });
  controller.start(1);

  video.emit('ended');
  assert.equal(video.playCount, 1, 'synthetic early event must not start a replay');
  assert.equal(home.clickCount, 0);
  assert.equal(controller.status().state, 'running');

  video.currentTime = 120;
  video.ended = false;
  video.emit('ended');
  assert.equal(video.playCount, 1, 'seeking to duration without native ended state must not qualify');

  video.ended = true;
  video.emit('ended');
  assert.equal(video.playCount, 1, 'native end at duration must not replay a platform-completed video');
  assert.equal(controller.status().state, 'needsAttention');
});

test('player completes on met visible time even before the video ends', () => {
  const video = new FakeElement('video');
  const home = new FakeElement('button', '返回课程主页');
  const document = new FakeDocument([video, home], '已学习：12:00，要求学习：12:00');
  const view = fakeWindow(document);
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/coursePlayer';
  const controller = new StudyController({ document, window: view });
  controller.start(1);
  assert.equal(home.clickCount, 1, 'met platform timer alone completes the course');
  assert.equal(controller.status().state, 'completed');
});

test('player reports unknown time or missing return control and ignores repeated ended events', () => {
  const video = new FakeElement('video');
  const document = new FakeDocument([video], '计时暂不可用');
  const view = fakeWindow(document);
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/coursePlayer';
  const controller = new StudyController({ document, window: view });
  controller.start(1);
  video.ended = true;
  video.emit('ended');
  video.emit('ended');
  for (let index = 0; index < 30; index += 1) view.runIntervals();
  assert.equal(controller.status().state, 'needsAttention');
  assert.equal(controller.status().learnedSeconds, null);
  assert.equal(video.playCount, 1);

  const secondVideo = new FakeElement('video');
  const secondDoc = new FakeDocument([secondVideo], '已学习：12:00，要求学习：12:00');
  const secondView = fakeWindow(secondDoc);
  secondView.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/coursePlayer';
  const secondController = new StudyController({ document: secondDoc, window: secondView });
  secondController.start(1);
  secondVideo.ended = true;
  secondVideo.emit('ended');
  secondVideo.emit('ended');
  for (let index = 0; index < 15; index += 1) secondView.runIntervals();
  assert.equal(secondController.status().state, 'needsAttention');
});

test('player pause and stop cancel monitoring and prevent navigation', () => {
  for (const action of ['pause', 'stop']) {
    const video = new FakeElement('video');
    const home = new FakeElement('button', '返回课程主页');
    const document = new FakeDocument([video, home], '已学习：00:12，要求学习：12:00');
    const view = fakeWindow(document);
    view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/coursePlayer';
    const controller = new StudyController({ document, window: view });
    controller.start(1);
    controller[action]();
    video.emit('ended');
    view.runIntervals();
    assert.equal(home.clickCount, 0, action);
    assert.equal(view.intervals.size, 0, action);
  }
});

test('native video pause cancels the player progress monitor', () => {
  const video = new FakeElement('video');
  const home = new FakeElement('button', '返回课程主页');
  const document = new FakeDocument([video, home], '已学习：00:12，要求学习：12:00');
  const view = fakeWindow(document);
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/coursePlayer';
  const controller = new StudyController({ document, window: view });
  controller.start(1);
  video.pause();
  assert.equal(controller.status().state, 'paused');
  assert.equal(view.intervals.size, 0);
  video.emit('ended');
  assert.equal(home.clickCount, 0);
});

test('player automation is limited to the exact coursePlayer pathname', () => {
  const video = new FakeElement('video');
  const next = new FakeElement('button', '下一节');
  const document = new FakeDocument([video, next], '已学习：12:00，要求学习：12:00');
  const view = fakeWindow(document);
  view.location.href = 'https://labsafe.lzjtu.edu.cn/lab-study-front/coursePlayer/extra';
  const controller = new StudyController({ document, window: view });
  controller.start(1);
  video.emit('ended');
  assert.equal(next.clickCount, 1);
  assert.equal(controller.status().learnedSeconds, undefined);
});

test('chooseVideo returns exactly one visible video with nonzero area', () => {
  const visible = new FakeElement('video');
  const hidden = new FakeElement('video', '', { rect: { width: 0, height: 0 } });
  assert.equal(chooseVideo(new FakeDocument([visible, hidden])), visible);
  assert.equal(chooseVideo(new FakeDocument([visible, new FakeElement('video')])), null);
  assert.equal(chooseVideo(new FakeDocument([hidden])), null);
  assert.equal(chooseVideo(new FakeDocument([])), null);
});

test('chooseNext requires one safe visible enabled button or link', () => {
  const next = new FakeElement('button', '下一节');
  assert.equal(chooseNext(new FakeDocument([next])), next);
  assert.equal(chooseNext(new FakeDocument([next, new FakeElement('a', '继续学习')])), null);
  assert.equal(chooseNext(new FakeDocument([new FakeElement('button', '确认下一节')])), null);
  assert.equal(chooseNext(new FakeDocument([new FakeElement('a', '提交并继续学习')])), null);
  assert.equal(chooseNext(new FakeDocument([new FakeElement('button', '下一课', { disabled: true })])), null);
  assert.equal(chooseNext(new FakeDocument([new FakeElement('button', '继续学习', { style: { display: 'none' } })])), null);
});

test('sanitizeText removes email, phone-like values and long digit sequences, then truncates', () => {
  const value = sanitizeText('学员 alice@example.com 电话 138-1234-5678 编号 1234567890');
  assert.equal(value.includes('alice@example.com'), false);
  assert.equal(value.includes('138-1234-5678'), false);
  assert.equal(value.includes('1234567890'), false);
  assert.ok(value.length <= 40);
});

test('controller starts at requested rate and processes one real ended event once', async () => {
  const video = new FakeElement('video');
  const next = new FakeElement('button', '下一节');
  const document = new FakeDocument([video, next]);
  const controller = new StudyController({ document, window: fakeWindow(document) });
  const result = controller.start(4);
  await Promise.resolve();
  assert.equal(result.state, 'running');
  assert.equal(video.playbackRate, 4);
  assert.equal(video.playCount, 1);
  video.emit('ended');
  video.emit('ended');
  assert.equal(next.clickCount, 1);
});

test('natural completion pause does not suppress the following ended event', () => {
  const video = new FakeElement('video');
  const next = new FakeElement('button', '下一节');
  const document = new FakeDocument([video, next]);
  const controller = new StudyController({ document, window: fakeWindow(document) });
  controller.start(2);
  video.ended = true;
  video.paused = true;
  video.emit('pause');
  assert.equal(controller.status().state, 'running');
  video.emit('ended');
  assert.equal(next.clickCount, 1);
});

test('a new media load on the same video element permits its next ended event', () => {
  const video = new FakeElement('video');
  const next = new FakeElement('button', '下一节');
  const document = new FakeDocument([video, next]);
  const controller = new StudyController({ document, window: fakeWindow(document) });
  controller.start(2);
  video.ended = true;
  video.emit('ended');
  assert.equal(next.clickCount, 1);

  video.ended = false;
  video.emit('emptied');
  video.emit('loadstart');
  video.ended = true;
  video.emit('ended');
  assert.equal(next.clickCount, 2);
});

test('controller fails closed when the page URL is unavailable', () => {
  const video = new FakeElement('video');
  const document = new FakeDocument([video, new FakeElement('button', '下一节')]);
  const view = fakeWindow(document);
  delete view.location;
  const controller = new StudyController({ document, window: view });
  assert.equal(controller.start(2).state, 'needsAttention');
  assert.equal(video.playCount, 0);
});

test('setRate rejects changes after the page leaves the allowed URL scope', () => {
  const video = new FakeElement('video');
  const document = new FakeDocument([video, new FakeElement('button', '下一节')]);
  const view = fakeWindow(document);
  const controller = new StudyController({ document, window: view });
  controller.start(2);
  view.location.href = 'https://example.org/elsewhere';
  const result = controller.setRate(4);
  assert.equal(result.state, 'needsAttention');
  assert.equal(result.rate, 2);
  assert.equal(video.playbackRate, 2);
});

test('paused or stopped controller never auto-advances', async () => {
  const video = new FakeElement('video');
  const next = new FakeElement('button', '继续学习');
  const document = new FakeDocument([video, next]);
  const controller = new StudyController({ document, window: fakeWindow(document) });
  controller.start(2);
  controller.pause();
  video.emit('ended');
  assert.equal(next.clickCount, 0);
  controller.resume();
  controller.stop();
  video.emit('ended');
  assert.equal(next.clickCount, 0);
});

test('mutation observer rebinds a replacement video while running', () => {
  const first = new FakeElement('video');
  const next = new FakeElement('button', '下一节');
  const document = new FakeDocument([first, next]);
  document.documentElement = {};
  const view = fakeWindow(document);
  const controller = new StudyController({ document, window: view });
  controller.start(3);
  const replacement = new FakeElement('video');
  document.elements = [replacement, next];
  view.observers[0].trigger();
  assert.equal(replacement.playbackRate, 3);
  assert.equal(replacement.playCount, 1);
  first.emit('ended');
  assert.equal(next.clickCount, 0);
  replacement.emit('ended');
  assert.equal(next.clickCount, 1);
});

test('mutation observer waits through a temporary video gap and rebinds when inserted', () => {
  const first = new FakeElement('video');
  const next = new FakeElement('button', '下一节');
  const document = new FakeDocument([first, next]);
  document.documentElement = {};
  const view = fakeWindow(document);
  const controller = new StudyController({ document, window: view });
  controller.start(3);
  document.elements = [next];
  view.observers[0].trigger();
  assert.equal(controller.status().state, 'running');
  assert.equal(view.timers.size, 1);
  first.emit('ended');
  assert.equal(next.clickCount, 0);

  const replacement = new FakeElement('video');
  document.elements = [replacement, next];
  view.observers[0].trigger();
  assert.equal(view.timers.size, 0);
  assert.equal(replacement.playCount, 1);
  assert.equal(controller.status().state, 'running');
});

test('transition recheck is bounded and its timer is canceled by pause', () => {
  const video = new FakeElement('video');
  const next = new FakeElement('button', '下一节');
  const document = new FakeDocument([video, next]);
  document.documentElement = {};
  const view = fakeWindow(document);
  const controller = new StudyController({ document, window: view });
  controller.start(2);
  document.elements = [next];
  view.observers[0].trigger();
  assert.equal(view.timers.size, 1);
  view.runTimers();
  assert.equal(controller.status().state, 'needsAttention');

  const secondVideo = new FakeElement('video');
  const secondDocument = new FakeDocument([secondVideo, next]);
  secondDocument.documentElement = {};
  const secondView = fakeWindow(secondDocument);
  const secondController = new StudyController({ document: secondDocument, window: secondView });
  secondController.start(2);
  secondDocument.elements = [next];
  secondView.observers[0].trigger();
  secondController.pause();
  assert.equal(secondView.timers.size, 0);
});

test('delayed transition recheck rejects a URL that changed outside the allowed path', () => {
  const video = new FakeElement('video');
  const next = new FakeElement('button', '下一节');
  const replacement = new FakeElement('video');
  const document = new FakeDocument([video, next]);
  document.documentElement = {};
  const view = fakeWindow(document);
  const controller = new StudyController({ document, window: view });
  controller.start(2);
  document.elements = [next];
  view.observers[0].trigger();
  document.elements = [replacement, next];
  view.location.href = 'https://example.org/elsewhere';
  view.runTimers();
  assert.equal(controller.status().state, 'needsAttention');
  assert.equal(replacement.playCount, 0);
});

test('rate correction stops after three overrides and enters needsAttention', () => {
  const video = new FakeElement('video');
  const document = new FakeDocument([video, new FakeElement('button', '下一节')]);
  const controller = new StudyController({ document, window: fakeWindow(document) });
  controller.start(5);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    video.playbackRate = 1;
    video.emit('ratechange');
  }
  assert.equal(controller.status().state, 'needsAttention');
});

test('diagnostics report structure without URL, form values, cookies or body text', () => {
  const video = new FakeElement('video');
  const next = new FakeElement('button', '下一节 alice@example.com', { attrs: { 'aria-label': '下一节', 'data-course-id': 'secret' } });
  const personal = new FakeElement('button', '张三的必修课程：高等数学', { attrs: { role: '账号 user123 private' } });
  const document = new FakeDocument([video, next, personal]);
  document.querySelectorAll = (selector) => {
    if (selector === 'video') return [video];
    if (selector.startsWith('button, a')) return [next, personal];
    if (selector === 'iframe, frame') return [{}];
    return [];
  };
  document.URL = 'https://labsafe.lzjtu.edu.cn/lab-study-front/course?token=private';
  document.body = { textContent: 'private course body' };
  document.cookie = 'session=private';
  const report = JSON.stringify(new StudyController({ document, window: fakeWindow(document) }).diagnose());
  for (const secret of ['private', 'alice@example.com', 'secret', '张三', '高等数学', 'user123', '账号']) assert.equal(report.includes(secret), false);
  assert.match(report, /"videoCount":1/);
  assert.match(report, /"frameCount":1/);
  assert.match(report, /"attributeNames"/);
});
