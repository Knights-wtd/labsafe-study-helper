(() => {
  'use strict';

  const SESSION_KEY = 'labsafeSessions';
  const ALLOWED_HOST = 'labsafe.lzjtu.edu.cn';
  const ALLOWED_PATH = '/lab-study-front/';
  const HANDLED_MESSAGES = new Set([
    'FLOW_START', 'FLOW_GET', 'FLOW_PAUSE', 'FLOW_RESUME', 'FLOW_STOP', 'FLOW_SET_RATE',
    'COURSE_PICKED', 'MODULE_ENTERED', 'COURSE_COMPLETED', 'COURSE_DEFERRED', 'FLOW_COMPLETE', 'FLOW_ATTENTION',
  ]);
  const injectionLocks = new Map();

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
      ...(Number.isSafeInteger(value.practiceCheckAt) && value.practiceCheckAt > 0
        ? { practiceCheckAt: value.practiceCheckAt } : {}),
      ...(typeof value.moduleParentPeriodId === 'string' && /^[\w-]{1,80}$/.test(value.moduleParentPeriodId)
        ? { moduleParentPeriodId: value.moduleParentPeriodId } : {}),
      ...(Array.isArray(value.visitedModuleKeys) ? {
        visitedModuleKeys: [...new Set(value.visitedModuleKeys.filter((key) => /^course-[a-z0-9]{1,8}$/.test(key)).slice(0, 500))],
      } : {}),
    };
  }

  function createBackground(chromeApi) {
    if (!chromeApi?.storage?.session || !chromeApi?.runtime?.onMessage) {
      throw new Error('Chrome extension APIs are required.');
    }

    async function readSessions() {
      const saved = await chromeApi.storage.session.get(SESSION_KEY);
      const raw = saved?.[SESSION_KEY];
      return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : emptySessions();
    }

    async function writeSessions(sessions) {
      await chromeApi.storage.session.set({ [SESSION_KEY]: sessions });
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
      return session;
    }

    async function clearSession(tabId) {
      if (!Number.isInteger(tabId)) return;
      const sessions = await readSessions();
      delete sessions[String(tabId)];
      await writeSessions(sessions);
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
          };
          await putSession(session);
          return { ok: true, session };
        }
        case 'FLOW_GET':
          return { ok: true, session: await getSession(tabId) };
        case 'FLOW_PAUSE': {
          const session = await getSession(tabId);
          if (!session) return { ok: true, session: null };
          session.phase = 'paused';
          await putSession(session);
          await bestEffortMessage(tabId, { type: 'PAUSE' });
          return { ok: true, session };
        }
        case 'FLOW_RESUME': {
          const session = await getSession(tabId);
          if (!session) return { ok: true, session: null };
          if (!await allowedTab(tabId)) {
            return { ok: false, session: null };
          }
          session.phase = 'running';
          await putSession(session);
          await continueSession(tabId);
          return { ok: true, session };
        }
        case 'FLOW_STOP':
          await clearSession(tabId);
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
          if (session.phase !== 'running') return { ok: false, reason: 'session-paused' };
          const sameCourse = session.pendingKey === courseKey;
          const priorCheckAt = session.practiceCheckAt;
          session.pendingKey = courseKey;
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
          if (!session || session.phase !== 'running') return { ok: false };
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
          if (!session) return { ok: false };
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
          if (!session || session.phase !== 'running') return { ok: false };
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
          await clearSession(senderTabId);
          return { ok: true, session: null };
        }
        case 'FLOW_ATTENTION': {
          const senderTabId = sender?.tab?.id;
          if (!Number.isInteger(senderTabId)) return { ok: false };
          await clearSession(senderTabId);
          return { ok: true, session: null };
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
        if (url && !isAllowedUrl(url)) return clearSession(tabId);
        if (session.phase === 'running' && changeInfo?.status === 'complete' && isAllowedUrl(url)) return continueSession(tabId);
      })().catch(() => {});
    });

    chromeApi.tabs.onRemoved?.addListener((tabId) => {
      return clearSession(tabId).catch(() => {});
    });

    return { continueSession, getSession };
  }

  if (typeof module === 'object' && module?.exports) module.exports = { createBackground, isAllowedUrl };
  if (typeof chrome !== 'undefined' && chrome?.runtime?.onMessage) createBackground(chrome);
})();
