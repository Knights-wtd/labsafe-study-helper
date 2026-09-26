(() => {
  'use strict';

  const SESSION_KEY = 'labsafeSessions';
  const RECOVERY_KEY = 'labsafeRecoverySessions';
  const SESSION_EVENT_KEY = 'labsafeSessionEvents';
  const ALLOWED_HOST = 'labsafe.lzjtu.edu.cn';
  const ALLOWED_PATH = '/lab-study-front/';
  const HANDLED_MESSAGES = new Set([
    'FLOW_START', 'FLOW_GET', 'FLOW_PAUSE', 'FLOW_RESUME', 'FLOW_STOP', 'FLOW_SET_RATE',
    'COURSE_PICKED', 'MODULE_ENTERED', 'COURSE_COMPLETED', 'COURSE_DEFERRED', 'FLOW_COMPLETE', 'FLOW_ATTENTION', 'FLOW_RECOVER', 'FLOW_AUTO_RESTART',
  ]);
  const injectionLocks = new Map();
  const AUTO_RESTART_DELAY_MS = 5000;
  const MAX_AUTO_RESTARTS_WITHOUT_PROGRESS = 5;

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

  function validRate(value) {
    const rate = Number(value);
    return Number.isFinite(rate) && rate >= 1 && rate <= 16 ? rate : null;
  }

  function validRunId(value) {
    return typeof value === 'string' && /^[a-zA-Z0-9-]{8,80}$/.test(value) ? value : null;
  }

  function sameRun(session, message) {
    return !session?.runId || session.runId === message?.runId;
  }

  function emptySessions() {
    return {};
  }

  function normalizeSession(value, tabId) {
    if (!value || value.tabId !== tabId || validRate(value.rate) === null ||
      !['running', 'paused'].includes(value.phase)) return null;
    return {
      tabId,
      rate: validRate(value.rate),
      phase: value.phase,
      completedKeys: Array.isArray(value.completedKeys) ? [...new Set(value.completedKeys.filter((item) => typeof item === 'string').slice(0, 500))] : [],
      completedPeriodIds: Array.isArray(value.completedPeriodIds) ? [...new Set(value.completedPeriodIds.filter((item) => typeof item === 'string').slice(0, 500))] : [],
      deferredKeys: Array.isArray(value.deferredKeys) ? [...new Set(value.deferredKeys.filter((item) => typeof item === 'string').slice(0, 500))] : [],
      deferredPeriodIds: Array.isArray(value.deferredPeriodIds) ? [...new Set(value.deferredPeriodIds.filter((item) => typeof item === 'string').slice(0, 500))] : [],
      pendingKey: typeof value.pendingKey === 'string' ? value.pendingKey : null,
      autoRestartCount: Number.isSafeInteger(value.autoRestartCount) && value.autoRestartCount >= 0
        ? value.autoRestartCount : 0,
      ...(typeof value.attentionReason === 'string' && value.attentionReason
        ? { attentionReason: value.attentionReason.slice(0, 120) } : {}),
      ...(validRunId(value.runId) ? { runId: value.runId } : {}),
      ...(Number.isSafeInteger(value.practiceCheckAt) && value.practiceCheckAt > 0
        ? { practiceCheckAt: value.practiceCheckAt } : {}),
      ...(typeof value.moduleParentPeriodId === 'string' && /^[\w-]{1,80}$/.test(value.moduleParentPeriodId)
        ? { moduleParentPeriodId: value.moduleParentPeriodId } : {}),
      ...(Array.isArray(value.visitedModuleKeys) ? {
        visitedModuleKeys: [...new Set(value.visitedModuleKeys.filter((key) => /^course-[a-z0-9]{1,8}$/.test(key)).slice(0, 500))],
      } : {}),
    };
  }

  function createBackground(chromeApi, scheduler = globalThis) {
    if (!chromeApi?.storage?.session || !chromeApi?.runtime?.onMessage) {
      throw new Error('Chrome extension APIs are required.');
    }
    const restartTimers = new Map();
    const restartOperations = new Map();

    function cancelAutoRestart(tabId) {
      const timer = restartTimers.get(tabId);
      if (timer !== undefined) scheduler.clearTimeout(timer);
      restartTimers.delete(tabId);
    }

    async function autoRestart(tabId, runId) {
      if (restartOperations.has(tabId)) return restartOperations.get(tabId);
      const operation = (async () => {
      const session = await getSession(tabId);
      if (!session || session.phase !== 'paused' || session.runId !== runId ||
        !session.attentionReason || session.autoRestartCount >= MAX_AUTO_RESTARTS_WITHOUT_PROGRESS) return false;
      cancelAutoRestart(tabId);
      session.autoRestartCount += 1;
      session.phase = 'running';
      delete session.attentionReason;
      session.runId = globalThis.crypto.randomUUID();
      await putSession(session);
      await recordSessionEvent(tabId, 'auto-restarted');
      if (await continueSession(tabId)) return true;
      session.phase = 'paused';
      session.attentionReason = '自动恢复时页面暂不可用';
      await putSession(session);
      await recordSessionEvent(tabId, 'auto-restart-retry', session.attentionReason);
      if (session.autoRestartCount < MAX_AUTO_RESTARTS_WITHOUT_PROGRESS) scheduleAutoRestart(tabId, session.runId);
      return false;
      })();
      restartOperations.set(tabId, operation);
      try { return await operation; }
      finally { if (restartOperations.get(tabId) === operation) restartOperations.delete(tabId); }
    }

    function scheduleAutoRestart(tabId, runId) {
      cancelAutoRestart(tabId);
      const timer = scheduler.setTimeout(() => {
        restartTimers.delete(tabId);
        autoRestart(tabId, runId).catch(() => {});
      }, AUTO_RESTART_DELAY_MS);
      timer?.unref?.();
      restartTimers.set(tabId, timer);
    }

    async function readSessions() {
      const saved = await chromeApi.storage.session.get(SESSION_KEY);
      const raw = saved?.[SESSION_KEY];
      return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : emptySessions();
    }

    async function writeSessions(sessions) {
      await chromeApi.storage.session.set({ [SESSION_KEY]: sessions });
    }

    async function readRecoverySessions() {
      const saved = await chromeApi.storage.session.get(RECOVERY_KEY);
      const raw = saved?.[RECOVERY_KEY];
      return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    }

    async function readSessionEvents() {
      const saved = await chromeApi.storage.session.get(SESSION_EVENT_KEY);
      const raw = saved?.[SESSION_EVENT_KEY];
      return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    }

    async function recordSessionEvent(tabId, type, reason = '') {
      const events = await readSessionEvents();
      events[String(tabId)] = { type, at: new Date().toISOString(),
        ...(reason ? { reason: String(reason).slice(0, 120) } : {}) };
      await chromeApi.storage.session.set({ [SESSION_EVENT_KEY]: events });
    }

    async function getSession(tabId) {
      if (!Number.isInteger(tabId)) return null;
      const sessions = await readSessions();
      return normalizeSession(sessions[String(tabId)], tabId);
    }

    async function putSession(session) {
      const sessions = await readSessions();
      sessions[String(session.tabId)] = session;
      await writeSessions(sessions);
      const recovery = await readRecoverySessions();
      recovery[String(session.tabId)] = session;
      await chromeApi.storage.session.set({ [RECOVERY_KEY]: recovery });
      return session;
    }

    async function clearSession(tabId, reason = 'cleared') {
      if (!Number.isInteger(tabId)) return;
      cancelAutoRestart(tabId);
      const sessions = await readSessions();
      delete sessions[String(tabId)];
      await writeSessions(sessions);
      const recovery = await readRecoverySessions();
      delete recovery[String(tabId)];
      await chromeApi.storage.session.set({ [RECOVERY_KEY]: recovery });
      await recordSessionEvent(tabId, reason);
    }

    async function allowedTab(tabId) {
      if (!Number.isInteger(tabId)) return null;
      try {
        const tab = await chromeApi.tabs.get(tabId);
        return isAllowedUrl(tab?.url || '') ? tab : null;
      } catch {
        return null;
      }
    }

    async function allowedContentSender(sender) {
      if (!Number.isInteger(sender?.tab?.id)) return false;
      if (sender.url !== undefined) return isAllowedUrl(sender.url) && (sender.frameId === undefined || sender.frameId === 0);
      return Boolean(await allowedTab(sender.tab.id));
    }

    async function bestEffortMessage(tabId, message) {
      try { return await chromeApi.tabs.sendMessage(tabId, message); } catch { return null; }
    }

    async function continueSession(tabId) {
      if (injectionLocks.has(tabId)) return injectionLocks.get(tabId);
      const operation = (async () => {
        const session = await getSession(tabId);
        if (!session || session.phase !== 'running') return false;
        const tab = await allowedTab(tabId);
        if (!tab) return false;
        try {
          await chromeApi.scripting.executeScript({ target: { tabId }, files: ['quiz.js', 'content.js'] });
          await chromeApi.tabs.sendMessage(tabId, {
            type: 'AUTO_CONTINUE',
            rate: session.rate,
            completedKeys: session.completedKeys,
            completedPeriodIds: session.completedPeriodIds,
            deferredKeys: session.deferredKeys,
            deferredPeriodIds: session.deferredPeriodIds,
            pendingKey: session.pendingKey,
            ...(session.runId ? { runId: session.runId } : {}),
            ...(session.practiceCheckAt ? { practiceCheckAt: session.practiceCheckAt } : {}),
            ...(session.moduleParentPeriodId ? { moduleParentPeriodId: session.moduleParentPeriodId } : {}),
            ...(session.visitedModuleKeys ? { visitedModuleKeys: session.visitedModuleKeys } : {}),
          });
          return true;
        } catch {
          return false;
        }
      })();
      injectionLocks.set(tabId, operation);
      try { return await operation; }
      finally { injectionLocks.delete(tabId); }
    }

    async function handleMessage(message, sender) {
      if (!message || typeof message.type !== 'string') return undefined;
      const tabId = Number.isInteger(message.tabId) ? message.tabId : null;
      switch (message.type) {
        case 'FLOW_START': {
          const rate = validRate(message.rate);
          const tab = await allowedTab(tabId);
          if (!tab || rate === null) return { ok: false };
          const session = {
            tabId,
            rate,
            phase: 'running',
            completedKeys: [],
            completedPeriodIds: [],
            deferredKeys: [],
            deferredPeriodIds: [],
            pendingKey: null,
            autoRestartCount: 0,
            ...(validRunId(message.runId) ? { runId: message.runId } : {}),
          };
          cancelAutoRestart(tabId);
          await putSession(session);
          await recordSessionEvent(tabId, 'started');
          return { ok: true, session };
        }
        case 'FLOW_GET': {
          const session = await getSession(tabId);
          const saved = Number.isInteger(tabId) ? (await readRecoverySessions())[String(tabId)] : null;
          const lastEvent = Number.isInteger(tabId) ? (await readSessionEvents())[String(tabId)] || null : null;
          return { ok: true, session, recoverable: Boolean(normalizeSession(saved, tabId)), lastEvent };
        }
        case 'FLOW_RECOVER': {
          const senderTabId = sender?.tab?.id;
          if (!await allowedContentSender(sender)) return { ok: false };
          const current = await getSession(senderTabId);
          if (current) return { ok: current.phase === 'running' && sameRun(current, message), session: current };
          const saved = (await readRecoverySessions())[String(senderTabId)];
          const session = normalizeSession(saved, senderTabId);
          if (!session || session.phase !== 'running' || !sameRun(session, message)) return { ok: false };
          await putSession(session);
          await recordSessionEvent(senderTabId, 'recovered');
          return { ok: true, session };
        }
        case 'FLOW_PAUSE': {
          cancelAutoRestart(tabId);
          const session = await getSession(tabId);
          if (!session) return { ok: true, session: null };
          session.phase = 'paused';
          delete session.attentionReason;
          await putSession(session);
          await bestEffortMessage(tabId, { type: 'PAUSE' });
          return { ok: true, session };
        }
        case 'FLOW_RESUME': {
          cancelAutoRestart(tabId);
          const session = await getSession(tabId);
          if (!session) return { ok: true, session: null };
          if (!await allowedTab(tabId)) {
            return { ok: false, session: null };
          }
          session.phase = 'running';
          session.autoRestartCount = 0;
          delete session.attentionReason;
          await putSession(session);
          await continueSession(tabId);
          return { ok: true, session };
        }
        case 'FLOW_STOP':
          await clearSession(tabId, 'user-stop');
          if (tabId !== null) await bestEffortMessage(tabId, { type: 'STOP' });
          return { ok: true, session: null };
        case 'FLOW_SET_RATE': {
          const session = await getSession(tabId);
          const rate = validRate(message.rate);
          if (!session || rate === null) return { ok: false, session };
          session.rate = rate;
          await putSession(session);
          await bestEffortMessage(tabId, { type: 'SET_RATE', rate });
          return { ok: true, session };
        }
        case 'COURSE_PICKED': {
          const senderTabId = sender?.tab?.id;
          const courseKey = message.courseKey;
          if (!Number.isInteger(senderTabId) || !/^course-[a-z0-9]{1,8}$/.test(courseKey || '')) return { ok: false, reason: 'invalid-request' };
          // Chrome supplies the sender frame URL. A fresh tabs.get can briefly fail during SPA navigation.
          if (sender.url !== undefined) {
            if (!isAllowedUrl(sender.url) || (sender.frameId !== undefined && sender.frameId !== 0)) return { ok: false, reason: 'tab-not-allowed' };
          } else if (!await allowedTab(senderTabId)) return { ok: false, reason: 'tab-unavailable' };
          const session = await getSession(senderTabId);
          if (!session) return { ok: false, reason: 'session-missing' };
          if (!sameRun(session, message)) return { ok: false, reason: 'stale-run' };
          if (session.phase !== 'running') return { ok: false, reason: 'session-paused' };
          const sameCourse = session.pendingKey === courseKey;
          const priorCheckAt = session.practiceCheckAt;
          session.pendingKey = courseKey;
          if (!sameCourse) session.autoRestartCount = 0;
          const learned = message.learnedSeconds;
          const required = message.requiredSeconds;
          if (Number.isSafeInteger(learned) && Number.isSafeInteger(required) &&
            learned >= 0 && learned < required && required <= 864000) {
            const now = Date.now();
            const freshCheckAt = now + (required - learned) * 1000 + 300000;
            session.practiceCheckAt = sameCourse && priorCheckAt
              ? (priorCheckAt > now ? Math.min(priorCheckAt, freshCheckAt) : now + 300000)
              : freshCheckAt;
          } else {
            delete session.practiceCheckAt;
          }
          delete session.moduleParentPeriodId;
          delete session.visitedModuleKeys;
          await putSession(session);
          return { ok: true, session };
        }
        case 'MODULE_ENTERED': {
          const senderTabId = sender?.tab?.id;
          const parentPeriodId = String(message.parentPeriodId ?? '');
          const moduleKey = String(message.moduleKey ?? '');
          if (!/^[\w-]{1,80}$/.test(parentPeriodId) || !/^course-[a-z0-9]{1,8}$/.test(moduleKey) || !await allowedContentSender(sender)) return { ok: false };
          const session = await getSession(senderTabId);
          if (!session || session.phase !== 'running' || !sameRun(session, message)) return { ok: false };
          if (session.moduleParentPeriodId !== parentPeriodId) session.visitedModuleKeys = [];
          session.moduleParentPeriodId = parentPeriodId;
          if (!session.visitedModuleKeys.includes(moduleKey)) session.visitedModuleKeys.push(moduleKey);
          await putSession(session);
          return { ok: true, session };
        }
        case 'COURSE_COMPLETED': {
          const senderTabId = sender?.tab?.id;
          const periodId = message.periodId;
          if (!/^[\w-]{1,80}$/.test(String(periodId ?? '')) || !await allowedContentSender(sender)) return { ok: false };
          const session = await getSession(senderTabId);
          if (!session || !sameRun(session, message)) return { ok: false };
          const normalizedPeriodId = String(periodId);
          if (!session.moduleParentPeriodId || session.moduleParentPeriodId === normalizedPeriodId) {
            if (session.pendingKey && !session.completedKeys.includes(session.pendingKey)) session.completedKeys.push(session.pendingKey);
            session.pendingKey = null;
            delete session.practiceCheckAt;
            delete session.moduleParentPeriodId;
            delete session.visitedModuleKeys;
          }
          if (!session.completedPeriodIds.includes(normalizedPeriodId)) session.completedPeriodIds.push(normalizedPeriodId);
          await putSession(session);
          return { ok: true, session };
        }
        case 'COURSE_DEFERRED': {
          const senderTabId = sender?.tab?.id;
          const periodId = message.periodId;
          if (!/^[\w-]{1,80}$/.test(String(periodId ?? '')) || !await allowedContentSender(sender)) return { ok: false };
          const session = await getSession(senderTabId);
          if (!session || session.phase !== 'running' || !sameRun(session, message)) return { ok: false };
          const normalizedPeriodId = String(periodId);
          if (!session.moduleParentPeriodId || session.moduleParentPeriodId === normalizedPeriodId) {
            if (session.pendingKey && !session.deferredKeys.includes(session.pendingKey)) session.deferredKeys.push(session.pendingKey);
            session.pendingKey = null;
            delete session.practiceCheckAt;
            delete session.moduleParentPeriodId;
            delete session.visitedModuleKeys;
          }
          if (!session.deferredPeriodIds.includes(normalizedPeriodId)) session.deferredPeriodIds.push(normalizedPeriodId);
          await putSession(session);
          return { ok: true, session };
        }
        case 'FLOW_COMPLETE': {
          const senderTabId = sender?.tab?.id;
          if (!await allowedContentSender(sender)) return { ok: false };
          const session = await getSession(senderTabId);
          if (!session || !sameRun(session, message)) return { ok: false };
          await clearSession(senderTabId, 'complete');
          return { ok: true, session: null };
        }
        case 'FLOW_ATTENTION': {
          const senderTabId = sender?.tab?.id;
          if (!Number.isInteger(senderTabId) || !await allowedContentSender(sender)) return { ok: false };
          const session = await getSession(senderTabId);
          if (!session) return { ok: true, session: null };
          if (!sameRun(session, message)) return { ok: false };
          if (session.phase !== 'running') return { ok: false, session };
          const reason = String(message.reason || '').slice(0, 120);
          session.phase = 'paused';
          session.attentionReason = reason;
          await putSession(session);
          await recordSessionEvent(senderTabId, 'attention-paused', reason);
          if (session.autoRestartCount < MAX_AUTO_RESTARTS_WITHOUT_PROGRESS) {
            scheduleAutoRestart(senderTabId, session.runId);
          }
          return { ok: true, session };
        }
        case 'FLOW_AUTO_RESTART': {
          if (!await allowedContentSender(sender)) return { ok: false };
          return { ok: await autoRestart(sender.tab.id, message.runId) };
        }
        default:
          return undefined;
      }
    }

    chromeApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!HANDLED_MESSAGES.has(message?.type)) return false;
      handleMessage(message, sender).then((response) => {
        if (response !== undefined) sendResponse(response);
      }).catch(() => sendResponse({ ok: false }));
      return true;
    });

    chromeApi.tabs.onUpdated?.addListener((tabId, changeInfo, tab) => {
      return (async () => {
        let url = changeInfo?.url || tab?.url || '';
        if (!url) {
          try {
            url = (await chromeApi.tabs.get(tabId))?.url || '';
          } catch {
            return;
          }
        }
        const session = await getSession(tabId);
        if (!session) return;
        if (url && !isAllowedUrl(url)) {
          if (changeInfo?.status !== 'complete') return;
          try {
            url = (await chromeApi.tabs.get(tabId))?.url || '';
          } catch { return; }
          if (!isAllowedUrl(url)) return clearSession(tabId, 'left-site');
        }
        if (session.phase === 'running' && changeInfo?.status === 'complete' && isAllowedUrl(url)) return continueSession(tabId);
      })().catch(() => {});
    });

    chromeApi.tabs.onRemoved?.addListener((tabId) => {
      return clearSession(tabId, 'tab-closed').catch(() => {});
    });

    return { continueSession, getSession };
  }

  if (typeof module === 'object' && module?.exports) module.exports = { createBackground, isAllowedUrl };
  if (typeof chrome !== 'undefined' && chrome?.runtime?.onMessage) createBackground(chrome);
})();
