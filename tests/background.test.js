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
    session: { tabId: 7, rate: 2.5, phase: 'running', completedKeys: [], completedPeriodIds: [], deferredKeys: [], deferredPeriodIds: [], pendingKey: null, autoRestartCount: 0 },
  });
  assert.equal((await send(chrome, { type: 'FLOW_START', tabId: 8, rate: 2 })).ok, false);
  assert.deepEqual(chrome.storage.session.get ? (await chrome.storage.session.get('labsafeSessions')).labsafeSessions : null, {
    '7': { tabId: 7, rate: 2.5, phase: 'running', completedKeys: [], completedPeriodIds: [], deferredKeys: [], deferredPeriodIds: [], pendingKey: null, autoRestartCount: 0 },
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
  await chrome.tabs.onUpdated.emit(9, { status: 'complete', url: tab.url }, { ...tab });
  assert.equal(data.labsafeSessions['9'], undefined);
});

featureTest('keep-awake follows running study sessions across pause, resume, stop and multiple tabs', async () => {
  const { chrome } = makeChrome([{ id: 7, url: courseUrl }, { id: 8, url: courseUrl }]);
  const powerCalls = [];
  chrome.power = {
    requestKeepAwake(level) { powerCalls.push(`request:${level}`); },
    releaseKeepAwake() { powerCalls.push('release'); },
  };
  createBackground(chrome);
  await send(chrome, { type: 'FLOW_START', tabId: 7, rate: 1 });
  assert.equal(powerCalls.at(-1), 'request:system');
  await send(chrome, { type: 'FLOW_PAUSE', tabId: 7 });
  assert.equal(powerCalls.at(-1), 'release');
  await send(chrome, { type: 'FLOW_RESUME', tabId: 7 });
  assert.equal(powerCalls.at(-1), 'request:system');
  await send(chrome, { type: 'FLOW_START', tabId: 8, rate: 1 });
  await send(chrome, { type: 'FLOW_STOP', tabId: 7 });
  assert.equal(powerCalls.at(-1), 'request:system', 'the other running tab still needs power');
  await send(chrome, { type: 'FLOW_STOP', tabId: 8 });
  assert.equal(powerCalls.at(-1), 'release');
});

featureTest('keep-awake is restored when the background worker restarts during a running session', async () => {
  const { chrome, data } = makeChrome([{ id: 7, url: courseUrl }]);
  data.labsafeSessions = { '7': {
    tabId: 7, rate: 1, phase: 'running', completedKeys: [], completedPeriodIds: [],
    deferredKeys: [], deferredPeriodIds: [], pendingKey: null,
  } };
  const calls = [];
  chrome.power = {
    requestKeepAwake(level) { calls.push(`request:${level}`); },
    releaseKeepAwake() { calls.push('release'); },
  };
  createBackground(chrome);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.at(-1), 'request:system');
  await send(chrome, { type: 'FLOW_ATTENTION', reason: 'page issue' },
    { tab: { id: 7 }, url: courseUrl, frameId: 0 });
  assert.equal(calls.at(-1), 'release');
});

featureTest('intermediate navigation outside the learning path does not discard a returning session', async () => {
  const { chrome, tabs, data } = makeChrome([{ id: 7, url: courseUrl }]);
  createBackground(chrome);
  await send(chrome, { type: 'FLOW_START', tabId: 7, rate: 1 });
  await chrome.tabs.onUpdated.emit(7, { url: 'https://labsafe.lzjtu.edu.cn/' }, { id: 7, url: 'https://labsafe.lzjtu.edu.cn/' });
  assert.ok(data.labsafeSessions['7']);
  tabs.get(7).url = 'https://labsafe.lzjtu.edu.cn/lab-study-front/examTask/75';
  await chrome.tabs.onUpdated.emit(7, { status: 'complete', url: tabs.get(7).url }, { ...tabs.get(7) });
  assert.ok(data.labsafeSessions['7']);
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
    autoRestartCount: 0,
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
      deferredKeys: ['course-ab12'], deferredPeriodIds: ['period-7'], pendingKey: null, autoRestartCount: 0,
    },
  });
  assert.deepEqual(data.labsafeSessions['7'], result.session);
  assert.deepEqual(await send(chrome, { type: 'COURSE_DEFERRED', periodId: 'bad id' }, { tab: { id: 7 } }), { ok: false });
  tabs.get(8).url = 'https://example.com/';
  assert.deepEqual(await send(chrome, { type: 'COURSE_DEFERRED', periodId: 'period-8' }, { tab: { id: 8 } }), { ok: false });
});

featureTest('catalog duration creates a persistent practice time checkpoint and rechecks stale progress', async () => {
  const { chrome, data, tabs, sent } = makeChrome([{ id: 7, url: courseUrl }]);
  createBackground(chrome);
  await send(chrome, { type: 'FLOW_START', tabId: 7, rate: 1 });
  const before = Date.now();
  const first = await send(chrome, { type: 'COURSE_PICKED', courseKey: 'course-ab12', learnedSeconds: 60, requiredSeconds: 600 }, { tab: { id: 7 } });
  assert.ok(first.session.practiceCheckAt >= before + 540000);
  assert.ok(first.session.practiceCheckAt <= Date.now() + 540000 + 300000);
  tabs.get(7).url = 'https://labsafe.lzjtu.edu.cn/lab-study-front/questionBank/exercises/34';
  await chrome.tabs.onUpdated.emit(7, { status: 'complete' }, { ...tabs.get(7) });
  assert.equal(sent.at(-1).message.practiceCheckAt, first.session.practiceCheckAt);
  data.labsafeSessions['7'].practiceCheckAt = Date.now() - 1000;
  const second = await send(chrome, { type: 'COURSE_PICKED', courseKey: 'course-ab12', learnedSeconds: 60, requiredSeconds: 600 }, { tab: { id: 7 } });
  assert.ok(second.session.practiceCheckAt > Date.now());
  assert.ok(second.session.practiceCheckAt <= Date.now() + 300000);
});

featureTest('a transient tab lookup failure on allowed navigation preserves the session for the next resume', async () => {
  const { chrome, data, injected } = makeChrome([{ id: 7, url: courseUrl }]);
  createBackground(chrome);
  await send(chrome, { type: 'FLOW_START', tabId: 7, rate: 1 });
  const originalGet = chrome.tabs.get;
  chrome.tabs.get = async () => { throw new Error('tab is navigating'); };
  await chrome.tabs.onUpdated.emit(7, {
    status: 'complete', url: 'https://labsafe.lzjtu.edu.cn/lab-study-front/examTask/75',
  }, { id: 7 });
  assert.ok(data.labsafeSessions['7']);
  chrome.tabs.get = originalGet;
  await chrome.tabs.onUpdated.emit(7, {
    status: 'complete', url: 'https://labsafe.lzjtu.edu.cn/lab-study-front/examTask/75',
  }, { id: 7 });
  assert.equal(injected.length, 1);
});

featureTest('COURSE_PICKED uses the trusted sender URL during a transient tab lookup failure', async () => {
  const { chrome, data } = makeChrome([{ id: 7, url: courseUrl }]);
  createBackground(chrome);
  await send(chrome, { type: 'FLOW_START', tabId: 7, rate: 1 });
  chrome.tabs.get = async () => { throw new Error('tab is navigating'); };

  const picked = await send(chrome, { type: 'COURSE_PICKED', courseKey: 'course-ab12' },
    { tab: { id: 7 }, url: 'https://labsafe.lzjtu.edu.cn/lab-study-front/examTask/75', frameId: 0 });
  assert.equal(picked.ok, true);
  assert.equal(data.labsafeSessions['7'].pendingKey, 'course-ab12');
  const rejected = await send(chrome, { type: 'COURSE_PICKED', courseKey: 'course-cd34' },
    { tab: { id: 7 }, url: 'https://example.com/', frameId: 0 });
  assert.deepEqual(rejected, { ok: false, reason: 'tab-not-allowed' });
  assert.equal(data.labsafeSessions['7'].pendingKey, 'course-ab12');
});

featureTest('all course checkpoints use the sender page when tab lookup is temporarily unavailable', async () => {
  const { chrome, data } = makeChrome([{ id: 7, url: courseUrl }]);
  createBackground(chrome);
  await send(chrome, { type: 'FLOW_START', tabId: 7, rate: 1 });
  chrome.tabs.get = async () => { throw new Error('tab is navigating'); };
  const sender = { tab: { id: 7 }, url: courseUrl, frameId: 0 };
  assert.equal((await send(chrome, { type: 'COURSE_PICKED', courseKey: 'course-ab12' }, sender)).ok, true);
  assert.equal((await send(chrome, { type: 'MODULE_ENTERED', parentPeriodId: 'period-1', moduleKey: 'course-cd34' }, sender)).ok, true);
  assert.equal((await send(chrome, { type: 'COURSE_COMPLETED', periodId: 'period-2' }, sender)).ok, true);
  assert.equal((await send(chrome, { type: 'COURSE_DEFERRED', periodId: 'period-3' }, sender)).ok, true);
  assert.equal((await send(chrome, { type: 'FLOW_COMPLETE' }, sender)).ok, true);
  assert.equal(data.labsafeSessions['7'], undefined);
});

featureTest('COURSE_PICKED reports missing session without creating a new one', async () => {
  const { chrome, data } = makeChrome([{ id: 7, url: courseUrl }]);
  createBackground(chrome);
  const result = await send(chrome, { type: 'COURSE_PICKED', courseKey: 'course-ab12' },
    { tab: { id: 7 }, url: courseUrl, frameId: 0 });
  assert.deepEqual(result, { ok: false, reason: 'session-missing' });
  assert.equal(data.labsafeSessions, undefined);
});

featureTest('a lost active session can recover its saved course state, but a user stop cannot', async () => {
  const { chrome, data } = makeChrome([{ id: 7, url: courseUrl }]);
  createBackground(chrome);
  await send(chrome, { type: 'FLOW_START', tabId: 7, rate: 2 });
  await send(chrome, { type: 'COURSE_PICKED', courseKey: 'course-ab12' }, { tab: { id: 7 }, url: courseUrl, frameId: 0 });
  delete data.labsafeSessions['7'];
  const sender = { tab: { id: 7 }, url: courseUrl, frameId: 0 };
  const recovered = await send(chrome, { type: 'FLOW_RECOVER' }, sender);
  assert.equal(recovered.ok, true);
  assert.equal(recovered.session.pendingKey, 'course-ab12');
  assert.equal(recovered.session.rate, 2);
  await send(chrome, { type: 'FLOW_STOP', tabId: 7 });
  assert.equal((await send(chrome, { type: 'FLOW_RECOVER' }, sender)).ok, false);
  const diagnosis = await send(chrome, { type: 'FLOW_GET', tabId: 7 });
  assert.equal(diagnosis.recoverable, false);
  assert.equal(diagnosis.lastEvent.type, 'user-stop');
});

featureTest('completed sessions cannot restart from the recovery snapshot', async () => {
  const { chrome } = makeChrome([{ id: 7, url: courseUrl }]);
  createBackground(chrome);
  await send(chrome, { type: 'FLOW_START', tabId: 7, rate: 1 });
  const sender = { tab: { id: 7 }, url: courseUrl, frameId: 0 };
  await send(chrome, { type: 'FLOW_COMPLETE' }, sender);
  assert.equal((await send(chrome, { type: 'FLOW_RECOVER' }, sender)).ok, false);
  assert.equal((await send(chrome, { type: 'FLOW_GET', tabId: 7 })).lastEvent.type, 'complete');
});

featureTest('late messages from a previous study run cannot pause or complete the current run', async () => {
  const { chrome, data } = makeChrome([{ id: 7, url: courseUrl }]);
  createBackground(chrome);
  const sender = { tab: { id: 7 }, url: courseUrl, frameId: 0 };
  await send(chrome, { type: 'FLOW_START', tabId: 7, rate: 1, runId: 'run-previous' });
  await send(chrome, { type: 'FLOW_START', tabId: 7, rate: 1, runId: 'run-current' });
  assert.equal((await send(chrome, { type: 'FLOW_ATTENTION', runId: 'run-previous' }, sender)).ok, false);
  assert.equal((await send(chrome, { type: 'FLOW_COMPLETE', runId: 'run-previous' }, sender)).ok, false);
  assert.equal((await send(chrome, { type: 'COURSE_PICKED', courseKey: 'course-ab12', runId: 'run-previous' }, sender)).ok, false);
  assert.equal(data.labsafeSessions['7'].phase, 'running');
  assert.equal(data.labsafeSessions['7'].pendingKey, null);
  assert.equal(data.labsafeSessions['7'].runId, 'run-current');
});

featureTest('attention pauses the background session and preserves learned course state', async () => {
  const { chrome, data } = makeChrome([{ id: 7, url: courseUrl }]);
  createBackground(chrome);
  await send(chrome, { type: 'FLOW_START', tabId: 7, rate: 1 });
  await send(chrome, { type: 'COURSE_PICKED', courseKey: 'course-ab12' }, { tab: { id: 7 }, url: courseUrl, frameId: 0 });
  const response = await send(chrome, { type: 'FLOW_ATTENTION', reason: 'catalog issue' }, { tab: { id: 7 }, url: courseUrl, frameId: 0 });
  assert.equal(response.session.phase, 'paused');
  assert.equal(data.labsafeSessions['7'].pendingKey, 'course-ab12');
  assert.equal(response.session.attentionReason, 'catalog issue');
  const duplicate = await send(chrome, { type: 'FLOW_ATTENTION', reason: 'secondary error' },
    { tab: { id: 7 }, url: courseUrl, frameId: 0 });
  assert.equal(duplicate.ok, false);
  const diagnosis = await send(chrome, { type: 'FLOW_GET', tabId: 7 });
  assert.equal(diagnosis.lastEvent.reason, 'catalog issue');
  assert.equal(diagnosis.session.attentionReason, 'catalog issue');
});

featureTest('attention automatically restarts after five seconds without losing progress', async () => {
  const { chrome, sent } = makeChrome([{ id: 7, url: courseUrl }]);
  const callbacks = new Map();
  let nextId = 1;
  createBackground(chrome, {
    setTimeout(callback, delay) { assert.equal(delay, 5000); const id = nextId++; callbacks.set(id, callback); return id; },
    clearTimeout(id) { callbacks.delete(id); },
  });
  const sender = { tab: { id: 7 }, url: courseUrl, frameId: 0 };
  await send(chrome, { type: 'FLOW_START', tabId: 7, rate: 2, runId: 'run-original' });
  await send(chrome, { type: 'COURSE_PICKED', courseKey: 'course-ab12', runId: 'run-original' }, sender);
  await send(chrome, { type: 'FLOW_ATTENTION', reason: 'page changed slowly', runId: 'run-original' }, sender);
  assert.equal(callbacks.size, 1);
  const callback = [...callbacks.values()][0];
  callback();
  await new Promise((resolve) => setImmediate(resolve));
  const resumed = await send(chrome, { type: 'FLOW_GET', tabId: 7 });
  assert.equal(resumed.session.phase, 'running');
  assert.equal(resumed.session.pendingKey, 'course-ab12');
  assert.equal(resumed.session.autoRestartCount, 1);
  assert.notEqual(resumed.session.runId, 'run-original');
  assert.equal(sent.at(-1).message.type, 'AUTO_CONTINUE');
});

featureTest('route oscillation attention stays paused until the user resumes', async () => {
  const { chrome } = makeChrome([{ id: 7, url: courseUrl }]);
  const callbacks = new Map();
  let nextId = 1;
  createBackground(chrome, {
    setTimeout(callback) { const id = nextId++; callbacks.set(id, callback); return id; },
    clearTimeout(id) { callbacks.delete(id); },
  });
  const sender = { tab: { id: 7 }, url: courseUrl, frameId: 0 };
  await send(chrome, { type: 'FLOW_START', tabId: 7, rate: 1, runId: 'run-original' });
  const stopped = await send(chrome, { type: 'FLOW_ATTENTION', reason: 'rapid routes', retryable: false, runId: 'run-original' }, sender);
  assert.equal(stopped.session.phase, 'paused');
  assert.equal(stopped.session.autoRestartBlocked, true);
  assert.equal(callbacks.size, 0);
  assert.equal((await send(chrome, { type: 'FLOW_AUTO_RESTART', runId: 'run-original' }, sender)).ok, false);
  await send(chrome, { type: 'FLOW_RESUME', tabId: 7 });
  assert.equal((await send(chrome, { type: 'FLOW_GET', tabId: 7 })).session.autoRestartBlocked, undefined);
});

featureTest('manual pause cancels a scheduled automatic restart', async () => {
  const { chrome } = makeChrome([{ id: 7, url: courseUrl }]);
  const callbacks = new Map();
  let nextId = 1;
  createBackground(chrome, {
    setTimeout(callback) { const id = nextId++; callbacks.set(id, callback); return id; },
    clearTimeout(id) { callbacks.delete(id); },
  });
  const sender = { tab: { id: 7 }, url: courseUrl, frameId: 0 };
  await send(chrome, { type: 'FLOW_START', tabId: 7, rate: 1 });
  await send(chrome, { type: 'FLOW_ATTENTION', reason: 'wait', runId: null }, sender);
  assert.equal(callbacks.size, 1);
  await send(chrome, { type: 'FLOW_PAUSE', tabId: 7 });
  assert.equal(callbacks.size, 0);
  assert.equal((await send(chrome, { type: 'FLOW_GET', tabId: 7 })).session.phase, 'paused');
});

featureTest('the same failing course stops auto-restarting after five attempts', async () => {
  const { chrome } = makeChrome([{ id: 7, url: courseUrl }]);
  const callbacks = new Map();
  let nextId = 1;
  createBackground(chrome, {
    setTimeout(callback) { const id = nextId++; callbacks.set(id, callback); return id; },
    clearTimeout(id) { callbacks.delete(id); },
  });
  const sender = { tab: { id: 7 }, url: courseUrl, frameId: 0 };
  await send(chrome, { type: 'FLOW_START', tabId: 7, rate: 1, runId: 'run-initial' });
  await send(chrome, { type: 'COURSE_PICKED', courseKey: 'course-ab12', runId: 'run-initial' }, sender);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const active = (await send(chrome, { type: 'FLOW_GET', tabId: 7 })).session;
    await send(chrome, { type: 'FLOW_ATTENTION', reason: 'same failure', runId: active.runId }, sender);
    assert.equal(callbacks.size, 1);
    const callback = [...callbacks.values()][0];
    callbacks.clear();
    callback();
    await new Promise((resolve) => setImmediate(resolve));
    const restarted = (await send(chrome, { type: 'FLOW_GET', tabId: 7 })).session;
    assert.equal(restarted.autoRestartCount, attempt + 1);
    await send(chrome, { type: 'COURSE_PICKED', courseKey: 'course-ab12', runId: restarted.runId }, sender);
  }
  const active = (await send(chrome, { type: 'FLOW_GET', tabId: 7 })).session;
  await send(chrome, { type: 'FLOW_ATTENTION', reason: 'same failure', runId: active.runId }, sender);
  assert.equal(callbacks.size, 0);
  assert.equal((await send(chrome, { type: 'FLOW_GET', tabId: 7 })).session.phase, 'paused');
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
