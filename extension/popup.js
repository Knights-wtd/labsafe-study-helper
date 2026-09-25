(() => {
  'use strict';

  const ALLOWED_HOST = 'labsafe.lzjtu.edu.cn';
  const ALLOWED_PATH = '/lab-study-front/';
  const RATE_KEY = 'studyRate';
  const buttonIds = ['start', 'pause', 'resume', 'stop', 'export', 'exportQuiz'];
  const rateInput = document.getElementById('rate');
  const statusOutput = document.getElementById('status');
  const errorOutput = document.getElementById('error');
  const feedback = document.querySelector('.feedback');
  const buttons = buttonIds.map((id) => document.getElementById(id));
  let actionVersion = 0;

  function isAllowedUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' &&
        url.hostname === ALLOWED_HOST &&
        !url.port &&
        !url.username &&
        !url.password &&
        url.pathname.startsWith(ALLOWED_PATH);
    } catch {
      return false;
    }
  }

  function validateRate(value) {
    const rate = Number(value);
    return Number.isFinite(rate) && rate >= 1 && rate <= 16 ? rate : null;
  }

  function statusLabel(status) {
    const labels = {
      idle: '就绪',
      running: '学习中',
      switching: '正在切换课程',
      paused: '已暂停',
      stopped: '已停止',
      completed: '已完成',
      needsAttention: '需要处理',
    };
    return labels[status?.state] || '状态未知';
  }

  function showStatus(status) {
    if (!status) return;
    statusOutput.textContent = statusLabel(status);
    feedback.dataset.state = status.state || '';
    if (status.reason) showError(status.reason);
    else clearError();
  }

  function showError(message) {
    errorOutput.textContent = String(message || '操作失败。');
    errorOutput.hidden = false;
  }

  function clearError() {
    errorOutput.textContent = '';
    errorOutput.hidden = true;
  }

  function setBusy(busy) {
    rateInput.disabled = busy;
    for (const button of buttons) button.disabled = busy;
  }

  async function getActiveTab() {
    let tabs;
    try {
      tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    } catch {
      throw new Error('无法获取当前标签页，请重新打开扩展面板。');
    }
    const tab = tabs?.[0];
    if (!tab?.id) throw new Error('无法获取当前标签页。');
    return tab;
  }

  function requireAllowedTab(tab) {
    if (!isAllowedUrl(tab.url || '')) {
      throw new Error('请先打开 https://labsafe.lzjtu.edu.cn/lab-study-front/ 下的学习页面。');
    }
  }

  async function sendToTab(tabId, type, values = {}) {
    let response;
    try {
      response = await chrome.tabs.sendMessage(tabId, { type, ...values });
    } catch {
      throw new Error('学习助手尚未注入此页面。请点击“开始学习”或“导出诊断”后重试。');
    }
    if (!response?.ok) throw new Error('页面未能处理此操作。');
    return response;
  }

  async function sendFlow(type, values = {}) {
    let response;
    try {
      response = await chrome.runtime.sendMessage({ type, ...values });
    } catch {
      throw new Error('无法更新本次学习会话，请重新打开扩展面板后重试。');
    }
    if (!response?.ok) throw new Error('本次学习会话无法处理此操作。');
    return response;
  }

  async function inject(tabId) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['quiz.js', 'content.js'] });
    } catch {
      throw new Error('无法在当前页面启动学习助手，请确认这是允许的学习页面后重试。');
    }
  }

  async function runWithTab({ allowed = false, ensureInjected = false } = {}, operation) {
    actionVersion += 1;
    setBusy(true);
    clearError();
    try {
      const tab = await getActiveTab();
      if (allowed || ensureInjected) requireAllowedTab(tab);
      if (ensureInjected) await inject(tab.id);
      const result = await operation(tab);
      if (result?.status) showStatus(result.status);
      return result;
    } catch (error) {
      showError(error?.message || '操作失败，请重试。');
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    const rate = validateRate(rateInput.value);
    if (rate === null) {
      showError('倍速必须是 1 到 16 之间的数字。');
      rateInput.focus();
      return;
    }
    await runWithTab({ allowed: true }, async (tab) => {
      await startOnTab(tab, rate);
    });
  }

  async function startOnTab(tab, rate) {
    try {
      await chrome.storage.local.set({ [RATE_KEY]: rate, labsafePracticeBanksV1: [] });
    } catch {
      throw new Error('无法保存倍速设置。');
    }
    const flow = await sendFlow('FLOW_START', { tabId: tab.id, rate });
    try {
      await inject(tab.id);
      const response = await sendToTab(tab.id, 'AUTO_CONTINUE', {
        rate,
        completedKeys: flow.session.completedKeys,
        completedPeriodIds: flow.session.completedPeriodIds,
        pendingKey: flow.session.pendingKey,
      });
      return response;
    } catch (error) {
      await sendFlow('FLOW_STOP', { tabId: tab.id }).catch(() => {});
      throw error;
    }
  }

  async function autoStartFromUrl() {
    let params;
    try {
      params = new URLSearchParams(globalThis.location?.search || '');
    } catch {
      return;
    }
    if (params.get('autostart') !== '1') return;
    const rate = validateRate(params.get('rate') || '1');
    if (rate === null) {
      showError('倍速必须是 1 到 16 之间的数字。');
      return;
    }
    rateInput.value = String(rate);
    setBusy(true);
    try {
      const tabs = await chrome.tabs.query({ url: 'https://labsafe.lzjtu.edu.cn/lab-study-front/*' });
      if (!tabs?.length) throw new Error('未找到实验室安全学习页面，请先打开学习页面。');
      if (tabs.length > 1) throw new Error('存在多个学习页面标签，请只保留一个后重试。');
      const result = await startOnTab(tabs[0], rate);
      if (result?.status) showStatus(result.status);
    } catch (error) {
      showError(error?.message || '自动启动失败。');
    } finally {
      setBusy(false);
    }
  }

  async function exportDiagnosis() {
    await runWithTab({ ensureInjected: true }, async (tab) => {
      const response = await sendToTab(tab.id, 'DIAGNOSE');
      const report = {
        exportedAt: new Date().toISOString(),
        diagnosis: response.diagnosis,
      };
      const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
      const objectUrl = URL.createObjectURL(blob);
      try {
        const anchor = document.createElement('a');
        anchor.href = objectUrl;
        anchor.download = `labsafe-diagnosis-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
        anchor.click();
      } finally {
        setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      }
      statusOutput.textContent = '诊断文件已导出';
      feedback.dataset.state = response.diagnosis?.state || '';
      return response;
    });
  }

  async function exportQuiz() {
    setBusy(true);
    clearError();
    try {
      const saved = await chrome.storage.local.get('labsafePracticeQuestionsV1');
      const records = Object.values(saved.labsafePracticeQuestionsV1 || {});
      if (!records.length) throw new Error('还没有采集到练习题。');
      const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), questions: records }, null, 2)], { type: 'application/json' });
      const objectUrl = URL.createObjectURL(blob);
      try {
        const anchor = document.createElement('a');
        anchor.href = objectUrl;
        anchor.download = `labsafe-practice-questions-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
        anchor.click();
      } finally {
        setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      }
      statusOutput.textContent = `已导出 ${records.length} 道练习题`;
    } catch (error) {
      showError(error?.message || '导出题库失败。');
    } finally {
      setBusy(false);
    }
  }

  async function refreshStatus() {
    const version = actionVersion;
    statusOutput.textContent = '正在读取页面状态…';
    try {
      const tab = await getActiveTab();
      if (version !== actionVersion) return;
      if (!isAllowedUrl(tab.url || '')) {
        statusOutput.textContent = '就绪';
        feedback.dataset.state = 'idle';
        return;
      }
      const flow = await sendFlow('FLOW_GET', { tabId: tab.id });
      if (version !== actionVersion) return;
      if (flow.session) {
        try {
          const response = await sendToTab(tab.id, 'PING');
          if (version !== actionVersion) return;
          showStatus(response.status);
        } catch {
          if (version !== actionVersion) return;
          showStatus({ state: flow.session.phase });
        }
        return;
      }
      try {
        const response = await sendToTab(tab.id, 'PING');
        if (version !== actionVersion) return;
        showStatus(response.status);
      } catch {
        if (version !== actionVersion) return;
        statusOutput.textContent = '未启动';
        feedback.dataset.state = 'idle';
        clearError();
      }
    } catch (error) {
      if (version !== actionVersion) return;
      statusOutput.textContent = '状态暂不可用';
      feedback.dataset.state = 'idle';
      showError(error?.message || '无法读取页面状态。');
    }
  }

  document.getElementById('start').addEventListener('click', start);
  document.getElementById('pause').addEventListener('click', () => runWithTab({ allowed: true }, async (tab) => {
    const response = await sendFlow('FLOW_PAUSE', { tabId: tab.id });
    if (response.session) showStatus({ state: response.session.phase });
    return response;
  }));
  document.getElementById('resume').addEventListener('click', () => runWithTab({ allowed: true }, async (tab) => {
    const response = await sendFlow('FLOW_RESUME', { tabId: tab.id });
    if (response.session) showStatus({ state: response.session.phase });
    return response;
  }));
  document.getElementById('stop').addEventListener('click', () => runWithTab({}, async (tab) => {
    const response = await sendFlow('FLOW_STOP', { tabId: tab.id });
    showStatus({ state: 'stopped' });
    return response;
  }));
  document.getElementById('export').addEventListener('click', exportDiagnosis);
  document.getElementById('exportQuiz').addEventListener('click', exportQuiz);

  rateInput.addEventListener('change', async () => {
    clearError();
    const rate = validateRate(rateInput.value);
    if (rate === null) {
      showError('倍速必须是 1 到 16 之间的数字。');
      return;
    }
    await runWithTab({ allowed: true }, async (tab) => {
      try {
        await chrome.storage.local.set({ [RATE_KEY]: rate });
      } catch {
        throw new Error('无法保存倍速设置。');
      }
      const flow = await sendFlow('FLOW_GET', { tabId: tab.id });
      if (flow.session) {
        const response = await sendFlow('FLOW_SET_RATE', { tabId: tab.id, rate });
        showStatus({ state: response.session?.phase || flow.session.phase });
        return response;
      }
      const ping = await sendToTab(tab.id, 'PING');
      if (ping.status?.state !== 'running') return ping;
      return sendToTab(tab.id, 'SET_RATE', { rate });
    });
  });

  chrome.storage.local.get({ [RATE_KEY]: 1 }).then((stored) => {
    const rate = validateRate(stored[RATE_KEY]);
    rateInput.value = String(rate ?? 1);
  }).catch(() => showError('无法读取已保存的倍速设置。'));
  refreshStatus();
  autoStartFromUrl();
})();
