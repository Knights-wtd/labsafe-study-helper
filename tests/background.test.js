const test = require('node:test');
const assert = require('node:assert/strict');
let createBackground;
try {
  ({ createBackground } = require('../extension/background.js'));
} catch {
  createBackground = null;
}

test('background exposes a testable session controller', () => {
  assert.equal(typeof createBackground, 'function');
});

function featureTest(name, fn) {
  test(name, { skip: typeof createBackground !== 'function' }, fn);
}

function makeEvent() {
  const listeners = [];
  return {
    addListener(listener) { listeners.push(listener); },
    async emit(...args) {
      const results = [];
      for (const listener of listeners) results.push(await listener(...args));
      return results;
    },
    listeners,
  };
}

function makeChrome(initialTabs = []) {
  const data = {};
  const tabs = new Map(initialTabs.map((tab) => [tab.id, { ...tab }]));
  const sent = [];
  const injected = [];
  const chrome = {
    runtime: { onMessage: makeEvent() },
    tabs: {
      onUpdated: makeEvent(),
      onRemoved: makeEvent(),
      async get(tabId) {
        const tab = tabs.get(tabId);
        if (!tab) throw new Error('missing tab');
        return { ...tab };
      },
      async sendMessage(tabId, message) { sent.push({ tabId, message }); return { ok: true }; },
    },
    scripting: {
      async executeScript(details) { injected.push(details); },
    },
    storage: {
      session: {
        async get(key) { return { [key]: structuredClone(data[key]) }; },
        async set(items) { Object.assign(data, structuredClone(items)); },
      },
    },
  };
  return { chrome, tabs, sent, injected, data };
}

const courseUrl = 'https://labsafe.lzjtu.edu.cn/lab-study-front/coursePlayer?id=1';

async function send(chrome, message, sender = {}) {
  return new Promise((resolve) => {
    const keepOpen = chrome.runtime.onMessage.listeners[0](message, sender, resolve);
    if (keepOpen === false) resolve(undefined);
  });
}

featureTest('manual FLOW_START creates a session only for an allowed tab', async () => {
  const { chrome } = makeChrome([
    { id: 7, url: courseUrl },
    { id: 8, url: 'https://example.com/' },
  ]);
  createBackground(chrome);

  assert.deepEqual(await send(chrome, { type: 'FLOW_START', tabId: 7, rate: 2.5 }), {
    ok: true,
    session: { tabId: 7, rate: 2.5, phase: 'running', completedKeys: [], completedPeriodIds: [], deferredKeys: [], deferredPeriodIds: [], pendingKey: null },
  });
  assert.equal((await send(chrome, { type: 'FLOW_START', tabId: 8, rate: 2 })).ok, false);
  assert.deepEqual(chrome.storage.session.get ? (await chrome.storage.session.get('labsafeSessions')).labsafeSessions : null, {
    '7': { tabId: 7, rate: 2.5, phase: 'running', completedKeys: [], completedPeriodIds: [], deferredKeys: [], deferredPeriodIds: [], pendingKey: null },
  });
});

featureTest('same-tab allowed navigation reinjects and resumes from session state', async () => {
  const { chrome, tabs, injected, sent } = makeChrome([{ id: 7, url: courseUrl }]);
  createBackground(chrome);
  await send(chrome, { type: 'FLOW_START', tabId: 7, rate: 3 });
  const tab = tabs.get(7);
  tab.url = 'https://labsafe.lzjtu.edu.cn/lab-study-front/catalog';

  await chrome.tabs.onUpdated.emit(7, { status: 'complete', url: tab.url }, { ...tab });

  assert.equal(injected.length, 1);
  assert.deepEqual(injected[0], { target: { tabId: 7 }, files: ['quiz.js', 'content.js'] });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    tabId: 7,
    message: { type: 'AUTO_CONTINUE', rate: 3, completedKeys: [], completedPeriodIds: [], deferredKeys: [], deferredPeriodIds: [], pendingKey: null },
  });
});

featureTest('tabs.onUpdated looks up the actual URL when the event omits both URL fields', async () => {
  const { chrome, data, injected, sent } = makeChrome([{ id: 7, url: courseUrl }]);
  createBackground(chrome);
  await send(chrome, { type: 'FLOW_START', tabId: 7, rate: 2 });

  await chrome.tabs.onUpdated.emit(7, { status: 'complete' }, { id: 7 });

  assert.ok(data.labsafeSessions['7']);
  assert.equal(injected.length, 1);
  assert.equal(sent[0].message.type, 'AUTO_CONTINUE');
});

featureTest('stop clears the session even when the page controller cannot be reached', async () => {
  const { chrome, data } = makeChrome([{ id: 7, url: courseUrl }]);
  chrome.tabs.sendMessage = async () => { throw new Error('content script absent'); };
  createBackground(chrome);
  await send(chrome, { type: 'FLOW_START', tabId: 7, rate: 1 });

  assert.deepEqual(await send(chrome, { type: 'FLOW_STOP', tabId: 7 }), { ok: true, session: null });
  assert.deepEqual(data.labsafeSessions, {});
});

featureTest('tab removal and navigation off the allowed site clear the session', async () => {
  const { chrome, tabs, data } = makeChrome([{ id: 7, url: courseUrl }, { id: 9, url: courseUrl }]);
  createBackground(chrome);
  await send(chrome, { type: 'FLOW_START', tabId: 7, rate: 1 });
  await chrome.tabs.onRemoved.emit(7);
  assert.equal(data.labsafeSessions['7'], undefined);

  await send(chrome, { type: 'FLOW_START', tabId: 9, rate: 1 });
  const tab = tabs.get(9);
  tab.url = 'https://example.com/';
  await chrome.tabs.onUpdated.emit(9, { url: tab.url }, { ...tab });
  assert.equal(data.labsafeSessions['9'], undefined);
});

featureTest('FLOW_COMPLETE clears only its allowed content tab session without sending STOP', async () => {
  const { chrome, tabs, data, sent } = makeChrome([{ id: 7, url: courseUrl }, { id: 8, url: courseUrl }]);
  createBackground(chrome);
  await send(chrome, { type: 'FLOW_START', tabId: 7, rate: 1 });
  await send(chrome, { type: 'FLOW_START', tabId: 8, rate: 1 });
  tabs.get(8).url = 'https://example.com/';

  assert.deepEqual(await send(chrome, { type: 'FLOW_COMPLETE' }, { tab: { id: 7 } }), { ok: true, session: null });
  assert.equal(data.labsafeSessions['7'], undefined);
  assert.ok(data.labsafeSessions['8']);
  assert.deepEqual(sent, []);
  assert.deepEqual(await send(chrome, { type: 'FLOW_COMPLETE' }), { ok: false });
  assert.deepEqual(await send(chrome, { type: 'FLOW_COMPLETE' }, { tab: { id: 8 } }), { ok: false });
  assert.ok(data.labsafeSessions['8']);
});

featureTest('session data survives background recreation and content events remain tab scoped', async () => {
  const { chrome, data } = makeChrome([{ id: 7, url: courseUrl }]);
  createBackground(chrome);
  await send(chrome, { type: 'FLOW_START', tabId: 7, rate: 1.5 });
  await send(chrome, { type: 'COURSE_PICKED', courseKey: 'course-ab12' }, { tab: { id: 7 } });
  await send(chrome, { type: 'COURSE_COMPLETED', periodId: 'period-4' }, { tab: { id: 7 } });

  createBackground(chrome);
  const response = await send(chrome, { type: 'FLOW_GET', tabId: 7 });
  assert.deepEqual(response.session, {
    tabId: 7,
    rate: 1.5,
    phase: 'running',
    completedKeys: ['course-ab12'],
    completedPeriodIds: ['period-4'],
    deferredKeys: [],
    deferredPeriodIds: [],
    pendingKey: null,
  });
  assert.deepEqual(data.labsafeSessions['7'], response.session);
});

featureTest('legacy sessions migrate missing deferred arrays to empty arrays', async () => {
  const { chrome, data } = makeChrome([{ id: 7, url: courseUrl }]);
  data.labsafeSessions = {
    '7': { tabId: 7, rate: 1, phase: 'running', completedKeys: ['course-a'], completedPeriodIds: ['period-1'], pendingKey: null },
  };
  createBackground(chrome);

  const response = await send(chrome, { type: 'FLOW_GET', tabId: 7 });
  assert.deepEqual(response.session.deferredKeys, []);
  assert.deepEqual(response.session.deferredPeriodIds, []);
});

featureTest('COURSE_DEFERRED records an unfinished period without marking it complete', async () => {
  const { chrome, tabs, data } = makeChrome([{ id: 7, url: courseUrl }, { id: 8, url: courseUrl }]);
  createBackground(chrome);
  await send(chrome, { type: 'FLOW_START', tabId: 7, rate: 1 });
  await send(chrome, { type: 'COURSE_PICKED', courseKey: 'course-ab12' }, { tab: { id: 7 } });

  const result = await send(chrome, { type: 'COURSE_DEFERRED', periodId: 'period-7' }, { tab: { id: 7 } });
  assert.deepEqual(result, {
    ok: true,
    session: {
      tabId: 7, rate: 1, phase: 'running', completedKeys: [], completedPeriodIds: [],
      deferredKeys: ['course-ab12'], deferredPeriodIds: ['period-7'], pendingKey: null,
    },
  });
  assert.deepEqual(data.labsafeSessions['7'], result.session);
  assert.deepEqual(await send(chrome, { type: 'COURSE_DEFERRED', periodId: 'bad id' }, { tab: { id: 7 } }), { ok: false });
  tabs.get(8).url = 'https://example.com/';
  assert.deepEqual(await send(chrome, { type: 'COURSE_DEFERRED', periodId: 'period-8' }, { tab: { id: 8 } }), { ok: false });
});

featureTest('completing a module child preserves the catalog parent until the module itself meets its timer', async () => {
  const { chrome, sent } = makeChrome([{ id: 7, url: courseUrl }]);
  createBackground(chrome);
  await send(chrome, { type: 'FLOW_START', tabId: 7, rate: 1 });
  await send(chrome, { type: 'COURSE_PICKED', courseKey: 'course-ab12' }, { tab: { id: 7 } });
  const entered = await send(chrome, { type: 'MODULE_ENTERED', parentPeriodId: 'article-75-2-1-431', moduleKey: 'course-ab34' }, { tab: { id: 7 } });
  assert.equal(entered.ok, true);
  const child = await send(chrome, { type: 'COURSE_COMPLETED', periodId: '99' }, { tab: { id: 7 } });
  assert.equal(child.session.pendingKey, 'course-ab12');
  assert.deepEqual(child.session.completedKeys, []);
  assert.deepEqual(child.session.completedPeriodIds, ['99']);
  await createBackground(chrome).continueSession(7);
  assert.equal(sent.at(-1).message.moduleParentPeriodId, 'article-75-2-1-431');
  assert.deepEqual(sent.at(-1).message.visitedModuleKeys, ['course-ab34']);
  const parent = await send(chrome, { type: 'COURSE_COMPLETED', periodId: 'article-75-2-1-431' }, { tab: { id: 7 } });
  assert.equal(parent.session.pendingKey, null);
  assert.deepEqual(parent.session.completedKeys, ['course-ab12']);
});

featureTest('AUTO_CONTINUE restores deferred course and period identifiers', async () => {
  const { chrome, tabs, sent } = makeChrome([{ id: 7, url: courseUrl }]);
  createBackground(chrome);
  await send(chrome, { type: 'FLOW_START', tabId: 7, rate: 1 });
  await send(chrome, { type: 'COURSE_PICKED', courseKey: 'course-ab12' }, { tab: { id: 7 } });
  await send(chrome, { type: 'COURSE_DEFERRED', periodId: 'period-7' }, { tab: { id: 7 } });
  tabs.get(7).url = 'https://labsafe.lzjtu.edu.cn/lab-study-front/catalog';

  await chrome.tabs.onUpdated.emit(7, { status: 'complete', url: tabs.get(7).url }, { ...tabs.get(7) });
  assert.deepEqual(sent[0].message, {
    type: 'AUTO_CONTINUE', rate: 1, completedKeys: [], completedPeriodIds: [],
    deferredKeys: ['course-ab12'], deferredPeriodIds: ['period-7'], pendingKey: null,
  });
});
