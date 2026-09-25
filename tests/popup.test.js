const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('popup preserves the concrete page failure instead of hiding it as stopped', async () => {
  const elements = new Map();
  for (const id of ['rate', 'status', 'error', 'start', 'pause', 'resume', 'stop', 'export', 'exportQuiz']) {
    elements.set(id, { value: id === 'rate' ? '1' : '', textContent: '', hidden: true, disabled: false,
      listeners: {}, addEventListener(type, handler) { this.listeners[type] = handler; }, focus() {} });
  }
  const feedback = { dataset: {} };
  const sent = [];
  const chrome = {
    tabs: {
      query: async () => [{ id: 7, url: 'https://labsafe.lzjtu.edu.cn/lab-study-front/questionBank/exercises/23' }],
      sendMessage: async (_tabId, message) => {
        if (message.type === 'PING') throw new Error('not injected');
        return { ok: false, status: { state: 'needsAttention', reason: '练习题目结构无法识别。' } };
      },
    },
    runtime: { sendMessage: async (message) => {
      sent.push(message.type);
      if (message.type === 'FLOW_START') return { ok: true, session: { completedKeys: [], completedPeriodIds: [], pendingKey: null } };
      return { ok: true, session: null };
    } },
    scripting: { executeScript: async () => {} },
    storage: { local: { get: async () => ({ studyRate: 1 }), set: async () => {} } },
  };
  const context = { chrome, document: { getElementById: (id) => elements.get(id), querySelector: () => feedback },
    location: { search: '' }, URL, URLSearchParams, Blob, Date, setTimeout };
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../extension/popup.js'), 'utf8'), context);
  await new Promise((resolve) => setImmediate(resolve));
  await elements.get('start').listeners.click();
  assert.equal(elements.get('status').textContent, '需要处理');
  assert.equal(elements.get('error').textContent, '练习题目结构无法识别。');
  assert.equal(sent.includes('FLOW_STOP'), false);
});
