(() => {
  'use strict';

  const ALLOWED_HOST = 'labsafe.lzjtu.edu.cn';
  const ALLOWED_PATH = '/lab-study-front/';
  const NEXT_PATTERN = /下一节|继续学习|下一课/;
  const BLOCKED_PATTERN = /考试|提交|完成|确认/;
  const RETURN_HOME_TEXT = '返回课程主页';
  const PLATFORM_FINISHED_PATTERN = /视频已经播放完毕\s*[，,]\s*请选择其他视频[!！]?/;
  const DIALOG_CONFIRM_TEXTS = new Set(['确定', '知道了', '知道了!', '知道了！', '确认', '好', '好的', '关闭', 'OK']);

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

  function isCoursePlayerUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && url.hostname === ALLOWED_HOST && !url.port &&
        !url.username && !url.password && url.pathname === '/lab-study-front/coursePlayer';
    } catch {
      return false;
    }
  }

  function isSafetyVideoUrl(value) {
    try {
      const url = new URL(value);
      return isAllowedUrl(value) && /^\/lab-study-front\/security\/safetyVideo\/\d+\/\d+\/?$/.test(url.pathname);
    } catch {
      return false;
    }
  }

  function isVideoStudyUrl(value) {
    return isCoursePlayerUrl(value) || isSafetyVideoUrl(value);
  }

  function isArticleStudyUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && url.hostname === ALLOWED_HOST && !url.port &&
        !url.username && !url.password && /^\/lab-study-front\/examTask\/\d+\/\d+\/\d+\/\d+$/.test(url.pathname);
    } catch {
      return false;
    }
  }

  function isCatalogUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && url.hostname === ALLOWED_HOST && !url.port &&
        !url.username && !url.password && /^\/lab-study-front\/examTask\/\d+$/.test(url.pathname);
    } catch {
      return false;
    }
  }

  function isPersonUrl(value) {
    try {
      const url = new URL(value);
      return isAllowedUrl(value) && url.pathname.replace(/\/$/, '') === '/lab-study-front/person';
    } catch {
      return false;
    }
  }

  const UNLEARNED_TAB_PATTERN = /未学习|未学|未完成|待学习|待学/;

  function isTabActive(element) {
    const classes = String(element.className || '').split(/\s+/);
    return classes.includes('is-active') || classes.includes('ivu-tabs-tab-active') ||
      element.getAttribute?.('aria-selected') === 'true';
  }

  function unlearnedTabState(document, view) {
    if (!document?.querySelectorAll) return { status: 'absent' };
    const tabs = Array.from(document.querySelectorAll('.el-tabs__item, .ivu-tabs-tab, [role="tab"]'))
      .filter((element) => UNLEARNED_TAB_PATTERN.test(normalizeCatalogText(element.innerText ?? element.textContent)));
    if (tabs.length === 0) return { status: 'absent' };
    if (tabs.length > 1 || !isVisible(tabs[0], view)) return { status: 'ambiguous' };
    return isTabActive(tabs[0]) ? { status: 'active', tab: tabs[0] } : { status: 'inactive', tab: tabs[0] };
  }

  function parseTimeSeconds(value) {
    const parts = String(value).trim().split(/[:：]/).map(Number);
    if ((parts.length !== 2 && parts.length !== 3) || parts.some((part) => !Number.isInteger(part) || part < 0)) return null;
    const [first, second, third] = parts;
    if (parts.length === 2) return second < 60 ? first * 60 + second : null;
    return second < 60 && third < 60 ? first * 3600 + second * 60 + third : null;
  }

  function readStudyProgress(document) {
    const visibleText = document?.body?.innerText ?? document?.documentElement?.innerText;
    if (typeof visibleText !== 'string' || !visibleText.trim()) return null;
    const text = visibleText.replace(/\s+/g, ' ');
    const learnedLabels = [...text.matchAll(/(?:已学习|learned)\s*[:：]?\s*([0-9０-９]+\s*[:：]\s*[0-9０-９]+(?:\s*[:：]\s*[0-9０-９]+)?)/gi)];
    const requiredLabels = [...text.matchAll(/(?:要求学习|required\s+study)\s*[:：]?\s*([0-9０-９]+\s*[:：]\s*[0-9０-９]+(?:\s*[:：]\s*[0-9０-９]+)?)/gi)];
    if (learnedLabels.length !== 1 || requiredLabels.length !== 1) return null;
    const normalize = (value) => value.replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xFEE0)).replace(/\s/g, '');
    const learnedSeconds = parseTimeSeconds(normalize(learnedLabels[0][1]));
    const requiredSeconds = parseTimeSeconds(normalize(requiredLabels[0][1]));
    if (learnedSeconds === null || requiredSeconds === null) return null;
    return { learnedSeconds, requiredSeconds };
  }

  function hasPlatformCompletedPrompt(document) {
    const visibleText = document?.body?.innerText ?? '';
    return typeof visibleText === 'string' && PLATFORM_FINISHED_PATTERN.test(visibleText);
  }

  function isPlatformDialogElement(element) {
    const tag = String(element?.tagName || '').toUpperCase();
    if (tag !== 'DIV') return false;
    const classes = String(element.className || '').split(/\s+/).filter(Boolean);
    return ['el-message-box', 'el-dialog', 'ivu-modal', 'ivu-modal-confirm'].some((name) => classes.includes(name));
  }

  function chooseDialogConfirm(document, view) {
    if (!document?.querySelectorAll) return null;
    const dialogs = Array.from(document.querySelectorAll('div'))
      .filter((element) => isPlatformDialogElement(element) && isVisible(element, view));
    if (dialogs.length === 0) return null;
    const candidates = new Set();
    for (const dialog of dialogs) {
      for (const control of Array.from(dialog.querySelectorAll?.('button, [role="button"]') || [])) {
        const labels = [control.textContent, control.getAttribute?.('aria-label'), control.getAttribute?.('title')]
          .map((value) => normalizeCatalogText(value).replace(/\s+/g, ''))
          .filter(Boolean);
        if (labels.some((label) => DIALOG_CONFIRM_TEXTS.has(label)) && isVisible(control, view) && isEnabled(control)) {
          candidates.add(control);
        }
      }
    }
    if (candidates.size !== 1) return null;
    return candidates.values().next().value;
  }

  function dismissPlatformDialog(document, view) {
    const control = chooseDialogConfirm(document, view);
    if (!control) return false;
    try {
      control.click();
      return true;
    } catch {
      return false;
    }
  }

  function isVisible(element, view) {
    if (!element) return false;
    for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
      if (ancestor.hidden || ancestor.getAttribute?.('aria-hidden') === 'true') return false;
      const style = view?.getComputedStyle?.(ancestor) || ancestor.style || {};
      const opacity = style.opacity;
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' ||
        (opacity != null && opacity !== '' && Number.isFinite(Number(opacity)) && Number(opacity) <= 0)) return false;
    }

    if (typeof element.getBoundingClientRect === 'function') {
      const rect = element.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return false;
    }
    if (typeof element.getClientRects === 'function' && element.getClientRects().length === 0) return false;
    return true;
  }

  function chooseVideo(document, view) {
    if (!document?.querySelectorAll) return null;
    const candidates = Array.from(document.querySelectorAll('video'))
      .filter((video) => isVisible(video, view));
    return candidates.length === 1 ? candidates[0] : null;
  }

  function getControlText(element) {
    return [element?.textContent, element?.getAttribute?.('aria-label'), element?.getAttribute?.('title')]
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function getSafeDiagnosticLabel(element) {
    const allowedLabels = new Set(['下一节', '继续学习', '下一课']);
    const values = [element?.textContent, element?.getAttribute?.('aria-label'), element?.getAttribute?.('title')];
    for (const value of values) {
      const label = String(value || '').replace(/\s+/g, ' ').trim();
      if (allowedLabels.has(label)) return label;
    }
    return '';
  }

  function getSafeDiagnosticRole(element) {
    const allowedRoles = new Set(['button', 'link', 'tab', 'menuitem', 'navigation', 'none', 'presentation']);
    const role = String(element?.getAttribute?.('role') || '').trim().toLowerCase();
    return allowedRoles.has(role) ? role : '';
  }

  function isEnabled(element) {
    if (!element) return false;
    if (element.disabled || element.getAttribute?.('disabled') != null ||
      element.getAttribute?.('aria-disabled') === 'true') return false;
    const classes = String(element.className || '').split(/\s+/).filter(Boolean);
    if (classes.some((name) => /(?:^|[-_])(?:disabled)(?:$|[-_])/.test(name))) return false;
    return true;
  }

  function normalizeCatalogText(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
  }

  function getCatalogCellText(cell) {
    return normalizeCatalogText(cell?.innerText ?? cell?.textContent);
  }

  function parseCatalogDuration(value) {
    const match = String(value).match(/^(\d+):([0-5]?\d):([0-5]?\d)$/);
    if (!match) return null;
    return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  }

  function hashCourseIdentity(title, module) {
    const value = `${normalizeCatalogText(title)}\u0000${normalizeCatalogText(module)}`;
    let first = 0x811c9dc5;
    let second = 0x9e3779b9;
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      first = Math.imul(first ^ code, 0x01000193) >>> 0;
      second = Math.imul(second ^ (code + index), 0x85ebca6b) >>> 0;
    }
    const shortHash = `${first.toString(36).padStart(7, '0').slice(-4)}${second.toString(36).padStart(7, '0').slice(-4)}`;
    return `course-${shortHash}`;
  }

  const CATALOG_HEADERS = ['名称', '学习模块', '学习进度', '操作'];
  const HEADER_WRAPPER_SELECTOR = '.el-table__header-wrapper, .ivu-table-header';
  const BODY_WRAPPER_SELECTOR = '.el-table__body-wrapper, .ivu-table-body';
  const TABLE_INNER_SELECTOR = 'table, [role="table"], [role="grid"]';

  function tableRows(table) {
    return Array.from(table?.querySelectorAll?.('tr, [role="row"]') || []);
  }

  function headerIndexesFromRows(rows) {
    const headerRows = rows.map((row) => ({
      row,
      headers: Array.from(row.querySelectorAll?.('th, [role="columnheader"]') || []).map(getCatalogCellText),
    })).filter(({ headers }) => headers.length > 0);
    const matches = headerRows.filter(({ headers }) => CATALOG_HEADERS.every((label) => headers.filter((value) => value === label).length === 1));
    if (matches.length !== 1) return null;
    const headers = matches[0].headers;
    const indexes = CATALOG_HEADERS.map((label) => headers.indexOf(label));
    return new Set(indexes).size === CATALOG_HEADERS.length ? { headerRow: matches[0].row, indexes } : null;
  }

  function findTableContainer(element) {
    for (let ancestor = element?.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const classes = String(ancestor.className || '').split(/\s+/);
      if (classes.includes('el-table') || classes.includes('ivu-table')) return ancestor;
    }
    return null;
  }

  function readCatalogRows(document, view) {
    if (!document?.querySelectorAll) return [];

    let rows;
    let indexes;
    const headerWrappers = Array.from(new Set(document.querySelectorAll(HEADER_WRAPPER_SELECTOR)));
    const componentTables = Array.from(new Set(document.querySelectorAll('.el-table, .ivu-table')));
    if (headerWrappers.length > 0 || componentTables.length > 0) {
      const headerMatches = headerWrappers.map((wrapper) => {
        const tables = Array.from(new Set(wrapper.querySelectorAll?.(TABLE_INNER_SELECTOR) || []));
        if (tables.length !== 1) return null;
        const header = headerIndexesFromRows(tableRows(tables[0]));
        return header ? { wrapper, indexes: header.indexes } : null;
      }).filter(Boolean);
      if (headerMatches.length !== 1) return [];
      const container = findTableContainer(headerMatches[0].wrapper);
      const bodyWrappers = container
        ? Array.from(container.querySelectorAll?.(BODY_WRAPPER_SELECTOR) || [])
        : Array.from(new Set(document.querySelectorAll(BODY_WRAPPER_SELECTOR)));
      const bodyTables = [];
      for (const wrapper of bodyWrappers) {
        for (const table of wrapper.querySelectorAll?.(TABLE_INNER_SELECTOR) || []) bodyTables.push(table);
      }
      if (bodyTables.length !== 1) return [];
      rows = tableRows(bodyTables[0]);
      indexes = headerMatches[0].indexes;
    } else {
      const tables = Array.from(new Set(document.querySelectorAll(TABLE_INNER_SELECTOR)));
      const catalogTables = tables.map((table) => {
        const header = headerIndexesFromRows(tableRows(table));
        if (!header) return null;
        return { rows: tableRows(table).filter((row) => row !== header.headerRow), indexes: header.indexes };
      }).filter(Boolean);
      if (catalogTables.length !== 1) return [];
      ({ rows, indexes } = catalogTables[0]);
    }

    const output = [];
    for (const row of rows) {
      if (!isVisible(row, view)) continue;
      const cells = Array.from(row.querySelectorAll?.('td, [role="cell"], [role="gridcell"]') || []);
      if (cells.length <= Math.max(...indexes)) continue;
      const title = getCatalogCellText(cells[indexes[0]]);
      const module = getCatalogCellText(cells[indexes[1]]);
      const rowText = normalizeCatalogText(row.innerText ?? row.textContent);
      if (!title || !module || !/(?:^|\s)必学(?:\s|$)/.test(rowText)) continue;

      const progressMatches = [...rowText.matchAll(/已学习\s*[:：]\s*(\d+:[0-5]?\d:[0-5]?\d)\s*[/／]\s*(\d+:[0-5]?\d:[0-5]?\d)/g)];
      const learnedLabels = [...rowText.matchAll(/已学习/g)];
      if (progressMatches.length !== 1 || learnedLabels.length !== 1) continue;
      const learnedSeconds = parseCatalogDuration(progressMatches[0][1]);
      const requiredSeconds = parseCatalogDuration(progressMatches[0][2]);
      if (learnedSeconds === null || requiredSeconds === null || learnedSeconds >= requiredSeconds) continue;

      const actionCell = cells[indexes[3]];
      const controls = Array.from(row.querySelectorAll?.('button, a, [role="button"]') || []);
      const exactControls = controls.filter((control) => {
        const labels = [control.textContent, control.getAttribute?.('aria-label'), control.getAttribute?.('title')]
          .map(normalizeCatalogText).filter(Boolean);
        let ancestor = control.parentElement;
        while (ancestor && ancestor !== actionCell) ancestor = ancestor.parentElement;
        return ancestor === actionCell && labels.includes('去学习') && isVisible(control, view) && isEnabled(control);
      });
      if (exactControls.length !== 1) continue;
      output.push({
        row,
        button: exactControls[0],
        courseKey: hashCourseIdentity(title, module),
        learnedSeconds,
        requiredSeconds,
      });
    }
    return output;
  }

  function chooseCourseRow(document, view, completedKeys = new Set()) {
    const skipped = completedKeys instanceof Set ? completedKeys : new Set(completedKeys || []);
    return readCatalogRows(document, view).find((candidate) => !skipped.has(candidate.courseKey)) || null;
  }

  function isPaginationElement(element) {
    const classes = String(element?.className || '').split(/\s+/);
    return classes.includes('el-pagination') || classes.includes('ivu-page');
  }

  function chooseCatalogNextPage(document, view) {
    if (!document?.querySelectorAll) return null;
    const candidates = Array.from(document.querySelectorAll(
      '.el-pagination .btn-next, .el-pagination [aria-label="下一页"], .ivu-page .ivu-page-next',
    )).filter((element) => {
      let pagination = element.parentElement;
      while (pagination && !isPaginationElement(pagination)) pagination = pagination.parentElement;
      if (!pagination) return false;
      const classes = String(element.className || '').split(/\s+/);
      const isNextClass = classes.includes('btn-next') || classes.includes('ivu-page-next');
      const isNextLabel = normalizeCatalogText(element.getAttribute?.('aria-label')) === '下一页' ||
        normalizeCatalogText(element.getAttribute?.('title')) === '下一页';
      return (isNextClass || isNextLabel) && isVisible(element, view) && isEnabled(element);
    });
    return candidates.length === 1 ? candidates[0] : null;
  }

  function chooseCatalogFirstPage(document, view) {
    if (!document?.querySelectorAll) return null;
    const candidates = Array.from(document.querySelectorAll('.el-pagination .number, .ivu-page .ivu-page-item'))
      .filter((element) => String(element.textContent || '').trim() === '1' && isVisible(element, view) && isEnabled(element));
    return candidates.length === 1 ? candidates[0] : null;
  }

  function readCatalogActivePageLabel(document) {
    if (!document?.querySelectorAll) return [];
    return [
      '.el-pagination .number.active',
      '.el-pagination [aria-current="page"]',
      '.el-pagination .el-pager .active',
      '.ivu-page .ivu-page-item-active',
    ].flatMap((selector) => Array.from(document.querySelectorAll(selector)))
      .map((element) => normalizeCatalogText(element.textContent));
  }

  function hasRecognizedCatalogTable(document) {
    if (!document?.querySelectorAll) return false;
    const headerWrappers = Array.from(document.querySelectorAll(HEADER_WRAPPER_SELECTOR));
    if (headerWrappers.length > 0) {
      const matchedHeaders = headerWrappers.filter((wrapper) =>
        Array.from(wrapper.querySelectorAll?.(TABLE_INNER_SELECTOR) || [])
          .some((table) => headerIndexesFromRows(tableRows(table))));
      if (matchedHeaders.length !== 1) return false;
      const container = findTableContainer(matchedHeaders[0]);
      const bodyWrappers = container
        ? Array.from(container.querySelectorAll?.(BODY_WRAPPER_SELECTOR) || [])
        : Array.from(document.querySelectorAll(BODY_WRAPPER_SELECTOR));
      const bodyTables = bodyWrappers.flatMap((wrapper) => Array.from(wrapper.querySelectorAll?.(TABLE_INNER_SELECTOR) || []));
      if (bodyTables.length !== 1) return false;
      return tableRows(bodyTables[0]).some((row) =>
        Array.from(row.querySelectorAll?.('td, [role="cell"], [role="gridcell"]') || []).length > 0);
    }
    const tables = Array.from(new Set(document.querySelectorAll(TABLE_INNER_SELECTOR)));
    const matches = tables.filter((table) => headerIndexesFromRows(tableRows(table)));
    return matches.length === 1;
  }

  function hasCatalogHeader(document) {
    if (!document?.querySelectorAll) return false;
    const tables = Array.from(new Set(document.querySelectorAll(TABLE_INNER_SELECTOR)));
    return tables.filter((table) => headerIndexesFromRows(tableRows(table))).length === 1;
  }

  function findGoStudyControls(document, view) {
    if (!document?.querySelectorAll) return [];
    return Array.from(document.querySelectorAll('button, a, [role="button"]')).filter((control) => {
      const labels = [control.textContent, control.getAttribute?.('aria-label'), control.getAttribute?.('title')]
        .map(normalizeCatalogText).filter(Boolean);
      return labels.includes('去学习') && isVisible(control, view) && isEnabled(control);
    });
  }

  function moduleCourseIdentity(text) {
    const progress = String(text).match(/已学习\s*[:：]?\s*(\d+:[0-5]?\d:[0-5]?\d)\s*[/／]\s*(\d+:[0-5]?\d:[0-5]?\d)/);
    const completed = progress && parseCatalogDuration(progress[1]) >= parseCatalogDuration(progress[2]);
    const stableText = normalizeCatalogText(String(text)
      .replace(/已学习\s*[:：]?\s*\d+:[0-5]?\d:[0-5]?\d\s*[/／]\s*\d+:[0-5]?\d:[0-5]?\d/g, '')
      .replace(/去学习/g, ''));
    return { key: hashCourseIdentity(stableText, 'module'), completed };
  }

  function chooseModuleRow(document, view, visitedKeys = new Set()) {
    if (!document?.querySelectorAll) return null;
    const candidates = [];
    for (const button of findGoStudyControls(document, view)) {
      let row = button.parentElement;
      while (row && !['LI', 'TR'].includes(String(row.tagName || '').toUpperCase())) row = row.parentElement;
      const owner = row ?? button;
      const rowText = normalizeCatalogText(owner.innerText ?? owner.textContent);
      const fallbackText = normalizeCatalogText(button.parentElement?.innerText ?? button.parentElement?.textContent);
      const identityText = rowText && rowText !== '去学习' ? rowText : fallbackText;
      if (!identityText) continue;
      const identity = moduleCourseIdentity(identityText);
      if (identity.completed) continue;
      candidates.push({ row: owner, text: identityText, key: identity.key, button });
    }
    if (candidates.length === 0) {
      for (const row of Array.from(document.querySelectorAll('li, tr'))) {
        const text = normalizeCatalogText(row.innerText ?? row.textContent);
        if (!text || text.length > 150 || !/(?:^|\s)必学(?:\s|$)/.test(text)) continue;
        if (!isVisible(row, view)) continue;
        const identity = moduleCourseIdentity(text);
        if (identity.completed) continue;
        candidates.push({ row, text, key: identity.key, button: null });
      }
    }
    const leaves = candidates.filter((candidate) => !candidates.some((other) => {
      if (other === candidate || typeof candidate.row.contains !== 'function') return false;
      return candidate.row.contains(other.row);
    }));
    const withButton = leaves.filter((candidate) => candidate.button);
    const pool = withButton.length > 0 ? withButton : leaves;
    const unvisited = pool.filter((candidate) => !visitedKeys.has(candidate.key));
    return unvisited.length ? unvisited[0] : null;
  }

  function chooseNext(document, view) {
    if (!document?.querySelectorAll) return null;
    const candidates = Array.from(document.querySelectorAll('button, a'))
      .filter((element) => {
        const text = getControlText(element);
        return isVisible(element, view) && isEnabled(element) && NEXT_PATTERN.test(text) && !BLOCKED_PATTERN.test(text);
      });
    return candidates.length === 1 ? candidates[0] : null;
  }

  function chooseReturnHome(document, view) {
    if (!document?.querySelectorAll) return null;
    const allElements = Array.from(document.querySelectorAll('button, a, [role="button"], *'));
    const candidates = new Set();
    for (const element of allElements) {
      const text = String(element?.innerText ?? element?.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (text !== RETURN_HOME_TEXT || !isVisible(element, view)) continue;
      let target = element;
      for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
        if (['BUTTON', 'A'].includes(String(ancestor.tagName || '').toUpperCase()) ||
          ancestor.getAttribute?.('role') === 'button') {
          target = ancestor;
          break;
        }
      }
      if (!isVisible(target, view) || !isEnabled(target)) continue;
      candidates.add(target);
    }
    const leaves = Array.from(candidates).filter((candidate) => !Array.from(candidates).some((other) => {
      if (candidate === other) return false;
      for (let ancestor = other.parentElement; ancestor; ancestor = ancestor.parentElement) {
        if (ancestor === candidate) return true;
      }
      return false;
    }));
    return leaves.length === 1 ? leaves[0] : null;
  }

  function chooseArticleReturn(document, view) {
    if (!document?.querySelectorAll) return null;
    const candidates = new Set();
    for (const element of Array.from(document.querySelectorAll('button, a, [role="button"], *'))) {
      const text = String(element?.innerText ?? element?.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (text !== '返回' || !isVisible(element, view)) continue;
      let target = element;
      for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
        if (['BUTTON', 'A'].includes(String(ancestor.tagName || '').toUpperCase()) || ancestor.getAttribute?.('role') === 'button') {
          target = ancestor;
          break;
        }
      }
      if (isVisible(target, view) && isEnabled(target)) candidates.add(target);
    }
    const leaves = Array.from(candidates).filter((candidate) => !Array.from(candidates).some((other) => {
      if (candidate === other) return false;
      for (let ancestor = other.parentElement; ancestor; ancestor = ancestor.parentElement) if (ancestor === candidate) return true;
      return false;
    }));
    return leaves.length === 1 ? leaves[0] : null;
  }

  function sanitizeText(value) {
    return String(value ?? '')
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
      .replace(/\+?\d[\d\s().-]{6,}\d/g, '[phone]')
      .replace(/\d{7,}/g, '[number]')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 40);
  }

  class StudyController {
    constructor(options = {}) {
      this.document = options.document || globalThis.document;
      this.window = options.window || globalThis.window;
      this.runtime = options.runtime || globalThis.chrome?.runtime || null;
      this.state = 'idle';
      this.rate = 1;
      this.reason = '';
      this.video = null;
      this.observer = null;
      this.endedVideos = new WeakSet();
      this.rateAttempts = 0;
      this.handlers = null;
      this.transitionTimer = null;
      this.returnTimer = null;
      this.returnDialogDismissed = false;
      this.returnDialogRetries = 0;
      this.awaitingVideo = false;
      this.playerMode = false;
      this.articleMode = false;
      this.catalogMode = false;
      this.autoFlow = false;
      this.autoContext = null;
      this.autoRouteKey = '';
      this.autoAction = null;
      this.catalogVisitedPages = new Set();
      this.catalogTimer = null;
      this.catalogWait = null;
      this.pausedCatalogWait = null;
      this.catalogSelecting = false;
      this.catalogRetryTimer = null;
      this.catalogRetries = 0;
      this.entryRetryTimer = null;
      this.entryRetries = 0;
      this.routeRetryTimer = null;
      this.routeRetries = 0;
      this.playerProbeTimer = null;
      this.moduleVisitedKeys = new Set();
      this.progressMissTicks = 0;
      this.returnControlRetryTimer = null;
      this.returnControlRetries = 0;
      this.catalogVisitedPageNumbers = new Set();
      this.catalogFirstPageConfirmed = false;
      this.completionPending = false;
      this.deferPending = false;
      this.attentionSent = false;
      this.playerCompleted = false;
      this.monitorTimer = null;
      this.learnedSeconds = null;
      this.requiredSeconds = null;
      this.lastLearnedSeconds = null;
      this.stalledTicks = 0;
      this.progressMissTicks = 0;
    }

    status() {
      return {
        state: this.state,
        rate: this.rate,
        reason: this.reason,
        ...(this.catalogMode ? { mode: 'catalog' } : this.articleMode ? { mode: 'article' } : this.playerMode ? { mode: 'video' } : {}),
        ...(this.playerMode || this.articleMode ? { learnedSeconds: this.learnedSeconds, requiredSeconds: this.requiredSeconds } : {}),
      };
    }

    _allowedNow() {
      const href = this.window?.location?.href;
      return typeof href === 'string' && isAllowedUrl(href);
    }

    _videoReturnControl() {
      const href = this.window?.location?.href;
      if (isSafetyVideoUrl(href)) return chooseArticleReturn(this.document, this.window);
      if (isCoursePlayerUrl(href)) return chooseReturnHome(this.document, this.window);
      const home = chooseReturnHome(this.document, this.window);
      const back = chooseArticleReturn(this.document, this.window);
      return home && !back ? home : back && !home ? back : null;
    }

    _routeKind(href = this.window?.location?.href) {
      if (!isAllowedUrl(href)) return null;
      if (isVideoStudyUrl(href)) return 'video';
      if (isArticleStudyUrl(href)) return 'article';
      if (isCatalogUrl(href) || hasCatalogHeader(this.document)) return 'catalog';
      if (isPersonUrl(href)) return 'entry';
      if (chooseVideo(this.document, this.window) && readStudyProgress(this.document) && this._videoReturnControl()) return 'video';
      if (readStudyProgress(this.document) && chooseArticleReturn(this.document, this.window)) return 'article';
      if (findGoStudyControls(this.document, this.window).length === 1) return 'entry';
      return null;
    }

    _setAttention(reason) {
      this.state = 'needsAttention';
      this.reason = reason;
      this._clearCatalogRetry();
      this._clearEntryRetry();
      this._clearRouteRetry();
      this._clearPlayerProbe();
      this._clearReturnControlRetry();
      try {
        this.document?.documentElement?.setAttribute?.('data-labsafe-attention', String(reason).slice(0, 120));
      } catch { /* 诊断标记失败不影响主流程 */ }
      this._markStep(`attention:${String(reason).slice(0, 60)}`);
      this._clearCatalogWait();
      this.pausedCatalogWait = null;
      if (this.autoFlow && !this.attentionSent) {
        this.attentionSent = true;
        this._sendBackground('FLOW_ATTENTION', { reason }).catch(() => {});
      }
      this._stopProgressMonitor();
      this._cancelTransitionWait();
      this._clearReturnWait();
      this._detachVideo();
      this._disconnectObserver();
      return this.status();
    }

    start(rate = 1) {
      const requestedRate = Number(rate);
      if (!Number.isFinite(requestedRate) || requestedRate < 1 || requestedRate > 16) {
        return this._setAttention('倍速需在 1×–16× 之间。');
      }
      if (!this._allowedNow()) return this._setAttention('当前页面不在允许的学习页面范围内。');

      this.stop(false);
      this.rate = requestedRate;
      this.rateAttempts = 0;
      this.reason = '';
      this.playerMode = this._routeKind() === 'video';
      this.articleMode = this._routeKind() === 'article';
      this.catalogMode = false;
      this.playerCompleted = false;
      this.completionPending = false;
      this.deferPending = false;
      this.learnedSeconds = null;
      this.requiredSeconds = null;
      this.lastLearnedSeconds = null;
      this.stalledTicks = 0;
      this.progressMissTicks = 0;
      this.returnControlRetries = 0;
      this.returnDialogDismissed = false;
      this.returnDialogRetries = 0;
      this.endedVideos = new WeakSet();
      this.state = 'running';
      if (this.articleMode) {
        this._startProgressMonitor();
        return this.status();
      }
      const video = chooseVideo(this.document, this.window);
      if (!video) {
        if (this.playerMode) {
          this._playerVideoProbe(30);
          return this.status();
        }
        return this._setAttention('未找到唯一可见的视频。');
      }
      const alreadyEnded = this.playerMode && (video.ended === true || hasPlatformCompletedPrompt(this.document));
      this._bindVideo(video, !alreadyEnded);
      this._watchPage();
      if (this.playerMode) this._startProgressMonitor();
      if (alreadyEnded && this.state === 'running') {
        if (video.ended === true) this._onEnded(video);
        else this._checkPlayerProgress(true);
      }
      return this.status();
    }

    pause() {
      if (this.state !== 'running') return this.status();
      this.state = 'paused';
      this._clearCatalogRetry();
      this._clearEntryRetry();
      this._clearRouteRetry();
      this._clearPlayerProbe();
      this._clearReturnControlRetry();
      if (this.catalogMode && this.catalogWait) {
        this.pausedCatalogWait = { ...this.catalogWait };
        this._clearCatalogWait();
      }
      this._cancelTransitionWait();
      this._clearReturnWait();
      this._stopProgressMonitor();
      this.video?.pause?.();
      return this.status();
    }

    resume() {
      if (this.state !== 'paused') return this.status();
      if (!this._allowedNow()) return this._setAttention('当前页面不在允许的学习页面范围内。');
      if (this.autoFlow && this.catalogMode) {
        this.state = 'running';
        const pausedWait = this.pausedCatalogWait;
        this.pausedCatalogWait = null;
        if (pausedWait?.previousSignature === 'course-route') {
          const href = this.window?.location?.href || '';
          if (this._routeKind(href)) return this._continueAutoRoute();
          this._waitForCourseRouteChange();
          return this.status();
        }
        if (pausedWait?.previousSignature) {
          if (this._catalogSignature() === pausedWait.previousSignature) {
            this._waitForCatalogChange(pausedWait.previousSignature);
            return this.status();
          }
        }
        return this._continueCatalog();
      }
      if (this.autoFlow && this._routeKind() === 'entry') {
        this.state = 'running';
        return this._continueEntry();
      }
      if (this.articleMode) {
        this.state = 'running';
        this._startProgressMonitor();
        return this.status();
      }
      const video = chooseVideo(this.document, this.window);
      if (!video) {
        this.state = 'running';
        if (this.playerMode) {
          this._playerVideoProbe(30);
          return this.status();
        }
        return this._setAttention('未找到唯一可见的视频。');
      }
      this.state = 'running';
      this._bindVideo(video, true);
      if (this.playerMode) this._startProgressMonitor();
      return this.status();
    }

    stop(markStopped = true) {
      this._clearCatalogWait();
      this._clearCatalogRetry();
      this._clearEntryRetry();
      this._clearRouteRetry();
      this._clearPlayerProbe();
      this._clearReturnControlRetry();
      if (markStopped) {
        this.autoFlow = false;
        this.autoContext = null;
        this.pausedCatalogWait = null;
        this.returnDialogDismissed = false;
        this.returnDialogRetries = 0;
      }
      this._cancelTransitionWait();
      this._clearReturnWait();
      this._stopProgressMonitor();
      this._detachVideo();
      this._disconnectObserver();
      if (markStopped) {
        this.state = 'stopped';
        this.reason = '';
      }
      return this.status();
    }

    async _sendBackground(type, payload = {}) {
      if (!this.runtime?.sendMessage) return null;
      try {
        return await this.runtime.sendMessage({ type, ...payload });
      } catch {
        return null;
      }
    }

    async autoContinue(message = {}) {
      const rate = Number(message.rate);
      if (!Number.isFinite(rate) || rate < 1 || rate > 16 || !this._allowedNow()) {
        return this._setAttention('自动续学参数或当前页面未通过校验。');
      }
      if (['stopped', 'needsAttention', 'completed'].includes(this.state)) {
        this.state = 'idle';
        this.reason = '';
        this.playerCompleted = false;
        this.completionPending = false;
        this.deferPending = false;
      }
      this.autoFlow = true;
      this.attentionSent = false;
      this.autoContext = {
        rate,
        completedKeys: new Set(Array.isArray(message.completedKeys) ? message.completedKeys.filter((key) => /^course-[a-z0-9]{1,8}$/.test(key)) : []),
        completedPeriodIds: new Set(Array.isArray(message.completedPeriodIds) ? message.completedPeriodIds.map(String).filter((id) => /^[\w-]{1,80}$/.test(id)) : []),
        deferredKeys: new Set(Array.isArray(message.deferredKeys) ? message.deferredKeys.filter((key) => /^course-[a-z0-9]{1,8}$/.test(key)) : []),
        deferredPeriodIds: new Set(Array.isArray(message.deferredPeriodIds) ? message.deferredPeriodIds.map(String).filter((id) => /^[\w-]{1,80}$/.test(id)) : []),
        pendingKey: /^course-[a-z0-9]{1,8}$/.test(message.pendingKey || '') ? message.pendingKey : null,
        moduleParentPeriodId: /^[\w-]{1,80}$/.test(message.moduleParentPeriodId || '') ? message.moduleParentPeriodId : null,
      };
      this.moduleVisitedKeys = new Set(Array.isArray(message.visitedModuleKeys)
        ? message.visitedModuleKeys.filter((key) => /^course-[a-z0-9]{1,8}$/.test(key)) : []);
      return this._continueAutoRoute();
    }

    async _continueAutoRoute() {
      if (!this.autoFlow || !['running', 'paused', 'idle'].includes(this.state)) return this.status();
      const href = this.window?.location?.href || '';
      if (!this._allowedNow()) return this._setAttention('当前页面不在允许的学习页面范围内。');
      if (this.autoAction) return this.status();
      const routeKey = new URL(href).pathname + new URL(href).search;
      const routeKind = this._routeKind(href);
      if (routeKind !== 'entry') this._clearEntryRetry();
      if (routeKind) {
        this._clearRouteRetry();
        this.routeRetries = 0;
      }
      if (routeKind === 'video' || routeKind === 'article') {
        const periodId = this._currentPeriodId();
        if (periodId && this.autoContext.completedPeriodIds.has(String(periodId))) {
          this.autoRouteKey = routeKey;
          this.playerMode = routeKind === 'video';
          this.articleMode = routeKind === 'article';
          this.catalogMode = false;
          this.state = 'running';
          this.reason = '';
          this._stopProgressMonitor();
          this._detachVideo();
          this._watchPage();
          return this._returnPreviouslyCompletedCourse(String(periodId));
        }
        if (periodId && this.autoContext.deferredPeriodIds.has(String(periodId))) {
          this.autoRouteKey = routeKey;
          this.playerMode = routeKind === 'video';
          this.articleMode = routeKind === 'article';
          this.catalogMode = false;
          this.state = 'running';
          this.reason = '';
          this._stopProgressMonitor();
          this._detachVideo();
          this._watchPage();
          return this._returnPreviouslyDeferredCourse(String(periodId));
        }
        if (this.autoRouteKey === routeKey && this.state === 'paused') return this.resume();
        if (this.autoRouteKey === routeKey && this.state === 'running' &&
          ((routeKind === 'video' && this.playerMode) || (routeKind === 'article' && this.articleMode))) return this.status();
        this.autoRouteKey = routeKey;
        const result = this.start(this.autoContext.rate);
        if (result.state !== 'running') return result;
        this.autoFlow = true;
        this._watchPage();
        return this.status();
      }
      if (routeKind === 'catalog') {
        if (this.catalogMode && this.autoRouteKey === routeKey && this.state === 'paused') return this.resume();
        if (this.catalogMode && this.autoRouteKey === routeKey && this.state === 'running') return this._continueCatalog();
        this._stopProgressMonitor();
        this._detachVideo();
        this._disconnectObserver();
        this.playerMode = false;
        this.articleMode = false;
        this.catalogMode = true;
        this.state = 'running';
        this.reason = '';
        this.rate = this.autoContext.rate;
        this.autoRouteKey = routeKey;
        this._watchPage();
        return this._continueCatalog();
      }
      if (routeKind === 'entry') {
        this._stopProgressMonitor();
        this._detachVideo();
        this.playerMode = false;
        this.articleMode = false;
        this.catalogMode = false;
        this.state = 'running';
        this.reason = '';
        this.rate = this.autoContext.rate;
        this.autoRouteKey = routeKey;
        this._watchPage();
        return this._continueEntry();
      }
      this.autoRouteKey = routeKey;
      this.state = 'running';
      this._watchPage();
      return this._scheduleRouteRetry();
    }

    _clearRouteRetry() {
      if (this.routeRetryTimer !== null) {
        const cancel = this.window?.clearTimeout || globalThis.clearTimeout;
        cancel.call(this.window, this.routeRetryTimer);
      }
      this.routeRetryTimer = null;
    }

    _scheduleRouteRetry() {
      if (this.routeRetryTimer !== null) return this.status();
      if (this.routeRetries >= 30) return this._setAttention('当前学习页面长时间无法识别，请检查页面是否加载完成。');
      this.routeRetries += 1;
      const schedule = this.window?.setTimeout || globalThis.setTimeout;
      this.routeRetryTimer = schedule.call(this.window, () => {
        this.routeRetryTimer = null;
        if (this.autoFlow && this.state === 'running') this._continueAutoRoute();
      }, 1000);
      return this.status();
    }

    _clearEntryRetry() {
      if (this.entryRetryTimer !== null) {
        const cancel = this.window?.clearTimeout || globalThis.clearTimeout;
        cancel.call(this.window, this.entryRetryTimer);
      }
      this.entryRetryTimer = null;
    }

    _continueEntry() {
      if (!this.autoFlow || this.state !== 'running' || this.catalogSelecting || this.catalogWait) return this.status();
      const dialogState = this._dismissBlockingDialog();
      if (dialogState === 'blocked') return this._setAttention('平台弹窗缺少可安全点击的确认按钮，请手动关闭后重新开始。');
      if (dialogState === 'dismissed') return this._scheduleEntryRetry();
      const controls = findGoStudyControls(this.document, this.window);
      if (controls.length > 1) return this._setAttention('个人中心有多个“去学习”入口，无法唯一确认。');
      if (controls.length === 0) return this._scheduleEntryRetry();
      this._clearEntryRetry();
      this.entryRetries = 0;
      const originHref = String(this.window?.location?.href || '');
      try {
        this.catalogSelecting = true;
        controls[0].click();
        this._waitForCourseRouteChange(originHref);
      } catch {
        return this._setAttention('无法打开个人中心的“去学习”入口。');
      }
      return this.status();
    }

    _scheduleEntryRetry() {
      if (this.entryRetryTimer !== null) return this.status();
      if (this.entryRetries >= 30) return this._setAttention('个人中心的“去学习”入口长时间未出现。');
      this.entryRetries += 1;
      const schedule = this.window?.setTimeout || globalThis.setTimeout;
      this.entryRetryTimer = schedule.call(this.window, () => {
        this.entryRetryTimer = null;
        if (this.state === 'running' && this.autoFlow) this._continueEntry();
      }, 1000);
      return this.status();
    }

    _clearReturnControlRetry() {
      if (this.returnControlRetryTimer !== null) {
        const cancel = this.window?.clearTimeout || globalThis.clearTimeout;
        cancel.call(this.window, this.returnControlRetryTimer);
      }
      this.returnControlRetryTimer = null;
    }

    _deferReturnControlRetry(retry, timeoutReason) {
      if (this.state !== 'running') return this.status();
      if (this.returnControlRetryTimer !== null) return this.status();
      if (this.returnControlRetries >= 15) return this._setAttention(timeoutReason);
      this.returnControlRetries += 1;
      const schedule = this.window?.setTimeout || globalThis.setTimeout;
      this.returnControlRetryTimer = schedule.call(this.window, () => {
        this.returnControlRetryTimer = null;
        if (this.state !== 'running') return;
        retry();
      }, 1000);
      return this.status();
    }

    async _returnPreviouslyCompletedCourse(periodId) {
      if (this.autoAction) return this.status();
      const control = this.articleMode ? chooseArticleReturn(this.document, this.window) : this._videoReturnControl();
      if (!control) {
        return this._deferReturnControlRetry(
          () => { this._returnPreviouslyCompletedCourse(periodId); },
          '已达标课时缺少唯一可用的返回控件，已停止自动操作。',
        );
      }
      this.returnControlRetries = 0;
      const operation = (async () => {
        const ack = await this._sendBackground('COURSE_COMPLETED', { periodId });
        if (!ack?.ok) return this._setAttention('后台未确认已完成课时，已停止自动返回。');
        if (!this.autoContext.moduleParentPeriodId || this.autoContext.moduleParentPeriodId === periodId) {
          if (this.autoContext.pendingKey) this.autoContext.completedKeys.add(this.autoContext.pendingKey);
          this.autoContext.pendingKey = null;
          this.autoContext.moduleParentPeriodId = null;
        }
        this.autoContext.completedPeriodIds.add(periodId);
        this.state = 'completed';
        this.reason = '';
        this._dismissBlockingDialog();
        try {
          const originHref = String(this.window?.location?.href || '');
          control.click();
          if (this.autoFlow) this._waitForReturnRoute(originHref);
          return this.status();
        } catch {
          return this._setAttention('无法返回目录，已停止自动操作。');
        }
      })();
      this.autoAction = operation;
      try { return await operation; }
      finally { if (this.autoAction === operation) this.autoAction = null; }
    }

    async _returnPreviouslyDeferredCourse(periodId) {
      if (this.autoAction) return this.status();
      const control = this.articleMode ? chooseArticleReturn(this.document, this.window) : this._videoReturnControl();
      if (!control) {
        return this._deferReturnControlRetry(
          () => { this._returnPreviouslyDeferredCourse(periodId); },
          '待处理课时缺少唯一可用的返回控件，已停止自动操作。',
        );
      }
      this.returnControlRetries = 0;
      const operation = (async () => {
        const ack = await this._sendBackground('COURSE_DEFERRED', { periodId });
        if (!ack?.ok) return this._setAttention('后台未确认待处理课时，已停止自动返回。');
        if (!this.autoContext.moduleParentPeriodId || this.autoContext.moduleParentPeriodId === periodId) {
          if (this.autoContext.pendingKey) this.autoContext.deferredKeys.add(this.autoContext.pendingKey);
          this.autoContext.pendingKey = null;
          this.autoContext.moduleParentPeriodId = null;
        }
        this.autoContext.deferredPeriodIds.add(periodId);
        this.state = 'switching';
        this.reason = '';
        this._dismissBlockingDialog();
        try {
          const originHref = String(this.window?.location?.href || '');
          control.click();
          this._waitForReturnRoute(originHref);
          return this.status();
        } catch {
          return this._setAttention('无法返回目录，已停止自动操作。');
        }
      })();
      this.autoAction = operation;
      try { return await operation; }
      finally { if (this.autoAction === operation) this.autoAction = null; }
    }

    _catalogSignature() {
      const text = String(this.document?.body?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 4000);
      const pageNumber = readCatalogActivePageLabel(this.document).join(',');
      return hashCourseIdentity(`${this.window?.location?.pathname || ''}|${pageNumber}|${text}|${[...this.autoContext.completedKeys].sort().join(',')}|${[...this.autoContext.deferredKeys].sort().join(',')}`, 'catalog');
    }

    _dismissBlockingDialog() {
      if (!this.document?.querySelectorAll) return 'none';
      const dialogs = Array.from(this.document.querySelectorAll('div'))
        .filter((element) => isPlatformDialogElement(element) && isVisible(element, this.window));
      if (dialogs.length === 0) return 'none';
      return dismissPlatformDialog(this.document, this.window) ? 'dismissed' : 'blocked';
    }

    _readCurrentPageNumber() {
      if (!this.document?.querySelectorAll) return null;
      const pagers = Array.from(this.document.querySelectorAll('.el-pagination, .ivu-page'));
      if (pagers.length === 0) return { singlePage: true, page: 1 };
      const unique = [...new Set(readCatalogActivePageLabel(this.document).filter((value) => /^\d+$/.test(value)))];
      if (unique.length !== 1) return null;
      return { singlePage: false, page: Number(unique[0]) };
    }

    _markStep(step) {
      try {
        const root = this.document?.documentElement;
        if (!root?.setAttribute) return;
        const stamp = `${Date.now() % 100000}|${step}`.slice(0, 150);
        root.setAttribute('data-labsafe-step', stamp);
      } catch { /* 诊断标记失败不影响主流程 */ }
    }

    _clearCatalogRetry() {
      if (this.catalogRetryTimer !== null) {
        const cancel = this.window?.clearTimeout || globalThis.clearTimeout;
        cancel.call(this.window, this.catalogRetryTimer);
      }
      this.catalogRetryTimer = null;
    }

    _deferCatalogRetry(timeoutReason) {
      if (this.catalogRetryTimer !== null) return this.status();
      if (this.catalogRetries >= 30) return this._setAttention(timeoutReason);
      this.catalogRetries += 1;
      const schedule = this.window?.setTimeout || globalThis.setTimeout;
      this.catalogRetryTimer = schedule.call(this.window, () => {
        this.catalogRetryTimer = null;
        if (this.state !== 'running' || !this.autoFlow) return;
        this._continueCatalog();
      }, 1000);
      return this.status();
    }

    async _continueCatalog() {
      if (!this.autoFlow || this.state !== 'running' || this.autoAction || this.catalogWait || this.catalogSelecting) return this.status();
      const dialogState = this._dismissBlockingDialog();
      if (dialogState === 'blocked') return this._setAttention('平台弹窗缺少可安全点击的确认按钮，请手动关闭后重新开始。');
      if (dialogState === 'dismissed') { this._markStep('dialog-dismissed'); return this.status(); }
      const tabState = unlearnedTabState(this.document, this.window);
      if (tabState.status === 'ambiguous') return this._setAttention('目录的“未学”筛选标签无法唯一确认，已停止自动选择。');
      if (tabState.status === 'inactive') {
        const signature = this._catalogSignature();
        try {
          tabState.tab.click();
          this._markStep('tab-click');
          this._waitForCatalogChange(signature);
          return this.status();
        } catch {
          return this._setAttention('无法切换到“未学”筛选标签。');
        }
      }
      if (!hasRecognizedCatalogTable(this.document)) {
        return this._deferCatalogRetry('目录表格长时间未出现，已停止自动选择。');
      }
      const currentPage = this._readCurrentPageNumber();
      if (!currentPage) return this._deferCatalogRetry('目录页码长时间无法唯一识别，已停止。');
      this.catalogRetries = 0;
      this.catalogVisitedPageNumbers.add(currentPage.page);
      if (currentPage.singlePage || currentPage.page === 1) {
        this.catalogFirstPageConfirmed = true;
      } else if (!this.catalogFirstPageConfirmed) {
        const firstPage = chooseCatalogFirstPage(this.document, this.window);
        if (!firstPage) return this._setAttention('目录不在第1页且无法安全返回第1页。');
        const signature = this._catalogSignature();
        try {
          firstPage.click();
          this._waitForCatalogChange(signature);
          return this.status();
        } catch {
          return this._setAttention('无法返回目录第1页。');
        }
      }
      const row = chooseCourseRow(this.document, this.window,
        new Set([...this.autoContext.completedKeys, ...this.autoContext.deferredKeys]));
      if (row) {
        this._markStep(`row:${row.courseKey}`);
        const operation = (async () => {
          const ack = await this._sendBackground('COURSE_PICKED', { courseKey: row.courseKey });
          if (!ack?.ok) return this._setAttention('后台未确认课程选择，已停止自动操作。');
          if (this.state !== 'running') return this.status();
          this.autoContext.pendingKey = row.courseKey;
          try {
            this.catalogSelecting = true;
            const originHref = String(this.window?.location?.href || '');
            row.button.click();
            this._markStep('row-clicked');
            this._waitForCourseRouteChange(originHref);
            return this.status();
          } catch {
            return this._setAttention('无法打开已确认的课程。');
          }
        })();
        this.autoAction = operation;
        try { return await operation; }
        finally { if (this.autoAction === operation) this.autoAction = null; }
      }

      const signature = this._catalogSignature();
      if (this.catalogVisitedPages.has(signature)) return this._setAttention('检测到目录页重复，已停止以避免循环。');
      const next = chooseCatalogNextPage(this.document, this.window);
      if (next) {
        this.catalogVisitedPages.add(signature);
        try {
          next.click();
          this._waitForCatalogChange(signature);
          return this.status();
        } catch {
          return this._setAttention('无法翻到目录下一页。');
        }
      }
      const lastPage = this._readCurrentPageNumber();
      const expectedPages = lastPage ? lastPage.page : 0;
      const traversedAllPages = expectedPages > 0 && this.catalogFirstPageConfirmed &&
        Array.from({ length: expectedPages }, (_value, index) => index + 1).every((page) => this.catalogVisitedPageNumbers.has(page));
      if (traversedAllPages) {
        if (this.autoContext.deferredKeys.size || this.autoContext.deferredPeriodIds.size) {
          return this._setAttention('仍有计时未达标的课程：平台禁止重播，已先学习其他课程，请手动检查剩余任务。');
        }
        const completed = await this._sendBackground('FLOW_COMPLETE');
        if (!completed?.ok) return this._setAttention('无法确认学习流程完成。');
        this.autoFlow = false;
        this.state = 'completed';
        this.reason = '';
        this._disconnectObserver();
        return this.status();
      }
      return this._setAttention('当前页没有未完成课程；为避免漏掉其他页，已停止并等待检查。');
    }

    _waitForCatalogChange(previousSignature) {
      this._clearCatalogWait();
      this.catalogWait = { previousSignature, attempts: 0 };
      const tick = () => {
        if (!this.catalogWait || this.state !== 'running') return;
        if (this._catalogSignature() !== previousSignature) {
          this._clearCatalogWait();
          this._continueCatalog();
          return;
        }
        this.catalogWait.attempts += 1;
        if (this.catalogWait.attempts >= 20) {
          this._setAttention('目录翻页后内容未变化，已停止避免重复翻页。');
          return;
        }
        const schedule = this.window?.setTimeout || globalThis.setTimeout;
        this.catalogTimer = schedule.call(this.window, tick, 500);
      };
      const schedule = this.window?.setTimeout || globalThis.setTimeout;
      this.catalogTimer = schedule.call(this.window, tick, 500);
    }

    _waitForCourseRouteChange(originHref = String(this.window?.location?.href || '')) {
      this._clearCatalogWait();
      this.catalogWait = { previousSignature: 'course-route', originHref, attempts: 0 };
      const tick = () => {
        if (!this.catalogWait || !this.autoFlow || this.state !== 'running') return;
        const href = this.window?.location?.href || '';
        if (href !== originHref && this._routeKind(href)) {
          this._clearCatalogWait();
          this.catalogSelecting = false;
          this._continueAutoRoute();
          return;
        }
        this.catalogWait.attempts += 1;
        if (this.catalogWait.attempts >= 20) {
          this._setAttention('打开课程后页面没有切换，已停止避免重复点击。');
          return;
        }
        const schedule = this.window?.setTimeout || globalThis.setTimeout;
        this.catalogTimer = schedule.call(this.window, tick, 500);
      };
      const schedule = this.window?.setTimeout || globalThis.setTimeout;
      this.catalogTimer = schedule.call(this.window, tick, 500);
    }

    _clearCatalogWait() {
      if (this.catalogTimer !== null) {
        const cancel = this.window?.clearTimeout || globalThis.clearTimeout;
        cancel.call(this.window, this.catalogTimer);
      }
      this.catalogTimer = null;
      this.catalogWait = null;
    }

    _waitForReturnRoute(originHref = String(this.window?.location?.href || '')) {
      this._clearReturnWait();
      const schedule = this.window?.setTimeout || globalThis.setTimeout;
      this.returnTimer = schedule.call(this.window, () => {
        this.returnTimer = null;
        if (!['switching', 'completed'].includes(this.state) || !this.autoFlow) return;
        const href = this.window?.location?.href || '';
        if (href !== originHref && isAllowedUrl(href)) {
          this.state = 'running';
          this._continueAutoRoute();
        } else {
          const dialogState = this._dismissBlockingDialog();
          if (dialogState === 'blocked') return this._setAttention('平台弹窗缺少可安全点击的确认按钮，请手动关闭后重新开始。');
          if (dialogState === 'dismissed') this.returnDialogDismissed = true;
          if (!this.returnDialogDismissed || this.returnDialogRetries >= 2) {
            return this._setAttention('点击返回后页面没有切换，请检查平台提示。');
          }
          this.returnDialogDismissed = false;
          this.returnDialogRetries += 1;
          this.returnTimer = schedule.call(this.window, () => {
            this.returnTimer = null;
            if (!['switching', 'completed'].includes(this.state) || this.window?.location?.href !== originHref) return;
            const control = this.articleMode ? chooseArticleReturn(this.document, this.window) : this._videoReturnControl();
            if (!control) return this._setAttention('弹窗关闭后无法确认返回控件。');
            try {
              control.click();
              this._waitForReturnRoute(originHref);
            } catch {
              this._setAttention('弹窗关闭后无法返回课程目录。');
            }
          }, 500);
        }
      }, 10000);
    }

    _clearReturnWait() {
      if (this.returnTimer !== null) {
        const cancel = this.window?.clearTimeout || globalThis.clearTimeout;
        cancel.call(this.window, this.returnTimer);
        this.returnTimer = null;
      }
    }

    setRate(rate) {
      const requestedRate = Number(rate);
      if (!Number.isFinite(requestedRate) || requestedRate < 1 || requestedRate > 16) {
        return this._setAttention('倍速需在 1×–16× 之间。');
      }
      if (!this._allowedNow()) return this._setAttention('当前页面不在允许的学习页面范围内。');
      this.rate = requestedRate;
      this.rateAttempts = 0;
      if (this.video) this._applyRate();
      return this.status();
    }

    _bindVideo(video, play) {
      this._cancelTransitionWait();
      if (this.video === video) {
        this._applyRate();
        if (play) this._play(video);
        return;
      }
      this._detachVideo();
      this.video = video;
      const handlers = {
        ended: () => this._onEnded(video),
        playing: () => this.endedVideos.delete(video),
        pause: () => {
          const duration = Number(video.duration);
          const currentTime = Number(video.currentTime);
          const atNaturalEnd = video.ended || (Number.isFinite(duration) && duration > 0 && currentTime >= duration);
          if (this.video === video && this.state === 'running' && video.paused && !atNaturalEnd) {
            if (this.autoFlow && this.playerMode) this._checkPlayerProgress(false);
            else {
              this.state = 'paused';
              this._stopProgressMonitor();
            }
          }
        },
        ratechange: () => {
          if (this.video === video && this.state === 'running' && video.playbackRate !== this.rate) this._correctRate();
        },
        loadstart: () => this.endedVideos.delete(video),
        emptied: () => this.endedVideos.delete(video),
      };
      this.handlers = handlers;
      for (const [type, handler] of Object.entries(handlers)) video.addEventListener(type, handler);
      this.rateAttempts = 0;
      this._applyRate();
      if (play && this.state === 'running') this._play(video);
    }

    _applyRate() {
      if (!this.video || this.state === 'paused' || this.state === 'stopped') return;
      try {
        if (this.video.playbackRate !== this.rate) this.video.playbackRate = this.rate;
      } catch {
        this._setAttention('浏览器未能设置所选倍速。');
      }
    }

    _correctRate() {
      if (this.rateAttempts >= 3) {
        this._setAttention('页面连续覆盖倍速设置，已暂停自动控制。');
        return;
      }
      this.rateAttempts += 1;
      this._applyRate();
      if (this.rateAttempts >= 3 && this.state === 'running') {
        this._setAttention('页面连续覆盖倍速设置，已暂停自动控制。');
      }
    }

    _play(video) {
      try {
        const result = video.play();
        if (result && typeof result.catch === 'function') {
          result.catch(() => {
            if (this.video === video && this.state === 'running') this._setAttention('浏览器拒绝播放，请手动播放后重试。');
          });
        }
      } catch {
        if (this.video === video && this.state === 'running') this._setAttention('浏览器拒绝播放，请手动播放后重试。');
      }
    }

    _onEnded(video) {
      if (this.state !== 'running' || this.awaitingVideo || this.video !== video || this.endedVideos.has(video)) return;
      if (!this._allowedNow()) return this._setAttention('当前页面不在允许的学习页面范围内。');
      if (this.playerMode && video.ended !== true) return;
      this.endedVideos.add(video);
      if (this.playerMode) {
        this.playerCompleted = true;
        this._checkPlayerProgress(true);
        return;
      }
      const next = chooseNext(this.document, this.window);
      if (!next) return this._setAttention('未找到唯一且安全的下一节控件。');
      try {
        next.click();
      } catch {
        this._setAttention('无法激活下一节控件。');
      }
    }

    _startProgressMonitor() {
      this._stopProgressMonitor();
      const schedule = this.window?.setInterval || globalThis.setInterval;
      if (typeof schedule !== 'function') return this._setAttention('浏览器无法检查页面学习计时。');
      this.monitorTimer = schedule.call(this.window, () => this._checkStudyProgress(false), 1000);
      this._checkStudyProgress(false);
    }

    _stopProgressMonitor() {
      if (this.monitorTimer !== null) {
        const cancel = this.window?.clearInterval || globalThis.clearInterval;
        cancel.call(this.window, this.monitorTimer);
        this.monitorTimer = null;
      }
    }

    _checkPlayerProgress(handleNaturalEnd) {
      if (!this.playerMode || this.state !== 'running') return;
      if (!this._allowedNow() || (this._routeKind() !== 'video' &&
        `${new URL(this.window.location.href).pathname}${new URL(this.window.location.href).search}` !== this.autoRouteKey)) {
        return this._setAttention('当前页面已离开课程播放器。');
      }
      const errorDialogState = this._dismissBlockingDialog();
      if (errorDialogState === 'blocked') return this._setAttention('平台弹窗缺少可安全点击的确认按钮，请手动关闭后重新开始。');
      if (errorDialogState === 'dismissed') return;
      const progress = readStudyProgress(this.document);
      if (!progress) {
        this.progressMissTicks += 1;
        if (this.progressMissTicks >= 30) return this._setAttention('无法唯一读取页面可见的已学习与要求学习时间。');
        return;
      }
      this.progressMissTicks = 0;
      this.learnedSeconds = progress.learnedSeconds;
      this.requiredSeconds = progress.requiredSeconds;
      const platformFinished = hasPlatformCompletedPrompt(this.document);
      if (platformFinished) {
        this.playerCompleted = true;
        if (this._dismissBlockingDialog() === 'blocked') {
          return this._setAttention('平台“视频已经播放完毕”弹窗缺少确认按钮，请手动关闭。');
        }
      }
      const duration = Number(this.video?.duration);
      const currentTime = Number(this.video?.currentTime);
      const atVideoEnd = !this.video || this.video.ended === true ||
        (Number.isFinite(duration) && duration > 0 && Number.isFinite(currentTime) && currentTime >= duration - 0.5);
      if (atVideoEnd) this.playerCompleted = true;
      if (this.deferPending) return;
      if (progress.learnedSeconds >= progress.requiredSeconds) {
        const home = this._videoReturnControl();
        if (!home) {
          this.returnControlRetries += 1;
          if (this.returnControlRetries >= 15) return this._setAttention('未找到唯一可见且可用的“返回课程主页”控件。');
          return;
        }
        this.returnControlRetries = 0;
        this._completeCourseAndReturn(home, this._currentPeriodId());
        return;
      }
      if (this.playerCompleted) this._deferCourseAndReturn();
    }

    _deferCourseAndReturn() {
      if (this.deferPending || this.state !== 'running') return;
      if (!this.autoFlow) return this._setAttention('视频已结束但学习计时未达标；平台禁止重播，请选择其他课程。');
      const home = this._videoReturnControl();
      const periodId = this._currentPeriodId();
      if (!home || !periodId || !/^[\w-]{1,80}$/.test(periodId)) {
        return this._setAttention('视频计时未达标，且无法安全确认返回控件或课时编号。');
      }
      this.deferPending = true;
      this._sendBackground('COURSE_DEFERRED', { periodId }).then((ack) => {
        if (!ack?.ok) return this._setAttention('后台未确认待处理课程，已停止自动返回。');
        if (this.state !== 'running') return;
        if (!this.autoContext.moduleParentPeriodId || this.autoContext.moduleParentPeriodId === String(periodId)) {
          if (this.autoContext.pendingKey) this.autoContext.deferredKeys.add(this.autoContext.pendingKey);
          this.autoContext.pendingKey = null;
          this.autoContext.moduleParentPeriodId = null;
        }
        this.autoContext.deferredPeriodIds.add(String(periodId));
        this.state = 'switching';
        this.reason = '';
        this._stopProgressMonitor();
        this._detachVideo();
        this._dismissBlockingDialog();
        try {
          const originHref = String(this.window?.location?.href || '');
          home.click();
          this._waitForReturnRoute(originHref);
        } catch {
          this._setAttention('无法返回课程主页，已停止自动操作。');
        }
      });
    }

    _checkStudyProgress(replayIfInsufficient) {
      if (this.articleMode) return this._checkArticleProgress();
      return this._checkPlayerProgress(replayIfInsufficient);
    }

    _tryModuleSubcourse() {
      if (!this.autoFlow || this.catalogWait || this.catalogSelecting) return false;
      const candidate = chooseModuleRow(this.document, this.window, this.moduleVisitedKeys);
      if (!candidate) return false;
      this.moduleVisitedKeys.add(candidate.key);
      let target = candidate.button;
      if (!target) {
        try {
          const inner = candidate.row.querySelectorAll?.('a, button, [role="button"]') || [];
          if (inner.length === 1 && isVisible(inner[0], this.window) && isEnabled(inner[0])) target = inner[0];
        } catch { /* 保持行点击 */ }
        if (!target) target = candidate.row;
      }
      this.catalogSelecting = true;
      const parentPeriodId = this._currentPeriodId();
      this._sendBackground('MODULE_ENTERED', { parentPeriodId, moduleKey: candidate.key }).then((ack) => {
        if (!ack?.ok) return this._setAttention('后台未确认模块子课程，已停止自动操作。');
        if (this.state !== 'running') return;
        this.autoContext.moduleParentPeriodId = parentPeriodId;
        try {
          const originHref = String(this.window?.location?.href || '');
          target.click();
          this._markStep(`module-row:${candidate.key}`);
          this._stopProgressMonitor();
          this._waitForCourseRouteChange(originHref);
        } catch {
          this._setAttention('无法打开模块子课程。');
        }
      });
      return true;
    }

    _checkArticleProgress() {
      if (!this.articleMode || this.state !== 'running') return;
      if (!this._allowedNow() || (this._routeKind() !== 'article' &&
        `${new URL(this.window.location.href).pathname}${new URL(this.window.location.href).search}` !== this.autoRouteKey)) {
        return this._setAttention('当前页面已离开资料学习页面。');
      }
      const dialogState = this._dismissBlockingDialog();
      if (dialogState === 'blocked') return this._setAttention('平台弹窗缺少可安全点击的确认按钮，请手动关闭后重新开始。');
      if (dialogState === 'dismissed') return;
      const progress = readStudyProgress(this.document);
      if (!progress) {
        this.progressMissTicks = (this.progressMissTicks || 0) + 1;
        if (this.progressMissTicks >= 15 && this._tryModuleSubcourse()) return;
        if (this.progressMissTicks >= 60) return this._setAttention('无法唯一读取页面可见的已学习与要求学习时间。');
        return;
      }
      this.progressMissTicks = 0;
      this.learnedSeconds = progress.learnedSeconds;
      this.requiredSeconds = progress.requiredSeconds;
      if (this.lastLearnedSeconds === null || progress.learnedSeconds > this.lastLearnedSeconds) {
        this.stalledTicks = 0;
      } else if (progress.learnedSeconds === this.lastLearnedSeconds) {
        this.stalledTicks += 1;
      } else {
        this.stalledTicks = 0;
      }
      this.lastLearnedSeconds = progress.learnedSeconds;
      if (progress.learnedSeconds >= progress.requiredSeconds) {
        const back = chooseArticleReturn(this.document, this.window);
        if (!back) {
          this.returnControlRetries += 1;
          if (this.returnControlRetries >= 15) return this._setAttention('未找到唯一可见且可用的“返回”控件。');
          return;
        }
        this.returnControlRetries = 0;
        this._completeCourseAndReturn(back, this._currentPeriodId() || 'article');
        return;
      }
      if (this.stalledTicks >= 15 && this._tryModuleSubcourse()) return;
      if (this.stalledTicks >= 60) return this._setAttention('学习计时未增长，已暂停自动操作，请检查页面是否仍在正常学习。');
    }

    _currentPeriodId() {
      try {
        const url = new URL(this.window.location.href);
        const periodId = url.searchParams.get('periodId');
        if (periodId) return periodId;
        if (isSafetyVideoUrl(url.href)) return `safety-video-${url.pathname.split('/').slice(-2).join('-')}`;
        if (isArticleStudyUrl(url.href)) return `article-${url.pathname.split('/').slice(-4).join('-')}`;
        if (this.playerMode || this.articleMode) return `route-${hashCourseIdentity(`${url.pathname}${url.search}`, 'period').slice(7)}`;
        return null;
      } catch {
        return null;
      }
    }

    _completeCourseAndReturn(control, periodId) {
      if (this.completionPending || this.state !== 'running') return;
      if (!periodId && this.autoFlow) return this._setAttention('无法从课程地址确认课时编号。');
      this.completionPending = true;
      const finish = () => {
        if (this.state !== 'running') return;
        this.state = 'completed';
        this.reason = '';
        this._stopProgressMonitor();
        this._detachVideo();
        this._dismissBlockingDialog();
        if (!this.autoFlow) this._disconnectObserver();
        try {
          const originHref = String(this.window?.location?.href || '');
          control.click();
          if (this.autoFlow) this._waitForReturnRoute(originHref);
        } catch {
          this.completionPending = false;
          this._setAttention('无法激活课程返回控件。');
        }
      };
      if (!this.autoFlow) return finish();
      this._sendBackground('COURSE_COMPLETED', { periodId }).then((ack) => {
        if (!ack?.ok) return this._setAttention('后台未确认课程完成，已停止自动返回。');
        if (this.autoContext?.pendingKey && (!this.autoContext.moduleParentPeriodId || this.autoContext.moduleParentPeriodId === String(periodId))) {
          this.autoContext.completedKeys.add(this.autoContext.pendingKey);
        }
        if (this.autoContext) {
          if (!this.autoContext.moduleParentPeriodId || this.autoContext.moduleParentPeriodId === String(periodId)) {
            this.autoContext.pendingKey = null;
            this.autoContext.moduleParentPeriodId = null;
          }
          this.autoContext.completedPeriodIds.add(String(periodId));
        }
        finish();
      });
    }

    _watchPage() {
      this._disconnectObserver();
      const Observer = this.window?.MutationObserver || globalThis.MutationObserver;
      if (!Observer || !this.document?.documentElement) return;
      this.observer = new Observer(() => this._onMutation());
      this.observer.observe(this.document.documentElement, { childList: true, subtree: true, attributes: true });
    }

    _onMutation() {
      if (this.autoFlow && ['running', 'paused', 'completed', 'switching'].includes(this.state)) {
        const href = this.window?.location?.href || '';
        if (!this._allowedNow()) return this._setAttention('当前页面不在允许的学习页面范围内。');
        if (this.returnTimer !== null && !this.returnDialogDismissed && ['completed', 'switching'].includes(this.state)) {
          const dialogState = this._dismissBlockingDialog();
          if (dialogState === 'blocked') return this._setAttention('平台弹窗缺少可安全点击的确认按钮，请手动关闭后重新开始。');
          if (dialogState === 'dismissed') this.returnDialogDismissed = true;
        }
        const routeKey = `${new URL(href).pathname}${new URL(href).search}`;
        if (this._routeKind(href) === 'catalog') {
          this._clearReturnWait();
          if (this.state === 'completed' || this.state === 'switching') this.state = 'running';
          if (this.catalogWait && this.catalogWait.previousSignature !== 'course-route' &&
            this._catalogSignature() !== this.catalogWait.previousSignature) {
            this._clearCatalogWait();
            this._continueCatalog();
          } else if (!this.catalogSelecting && !this.catalogWait && this.state === 'running') {
            this._continueAutoRoute();
          }
          return;
        }
        if (routeKey !== this.autoRouteKey && isAllowedUrl(href)) {
          this._clearCatalogWait();
          this._clearReturnWait();
          this.catalogSelecting = false;
          if (this.state === 'completed' || this.state === 'switching') this.state = 'running';
          this._continueAutoRoute();
          return;
        }
        if (this._routeKind(href) === 'article') return;
      }
      if (!['running', 'paused'].includes(this.state)) return;
      if (!this._allowedNow()) return this._setAttention('当前页面不在允许的学习页面范围内。');
      const video = chooseVideo(this.document, this.window);
      if (!video) {
        if (this.state === 'running') this._deferTransitionCheck();
        return;
      }
      if (video !== this.video) this._bindVideo(video, this.state === 'running');
    }

    _clearPlayerProbe() {
      if (this.playerProbeTimer !== null) {
        const cancel = this.window?.clearTimeout || globalThis.clearTimeout;
        cancel.call(this.window, this.playerProbeTimer);
      }
      this.playerProbeTimer = null;
    }

    _playerVideoProbe(attemptsLeft) {
      if (this.state !== 'running' || !this._allowedNow()) {
        this._clearPlayerProbe();
        if (this.state === 'running') return this._setAttention('页面变化后仍未找到唯一可见的视频。');
        return;
      }
      const video = chooseVideo(this.document, this.window);
      if (video) {
        this._clearPlayerProbe();
        this.awaitingVideo = false;
        this._cancelTransitionWait();
        this._bindVideo(video, true);
        if (this.playerMode) this._startProgressMonitor();
        return;
      }
      const progress = readStudyProgress(this.document);
      const prompt = hasPlatformCompletedPrompt(this.document);
      if ((progress && progress.learnedSeconds >= progress.requiredSeconds) || prompt) {
        this._clearPlayerProbe();
        this.playerCompleted = true;
        this._startProgressMonitor();
        return;
      }
      if (attemptsLeft <= 0) {
        this._clearPlayerProbe();
        return this._setAttention('视频不可见且无法确认学习进度，请手动检查。');
      }
      const schedule = this.window?.setTimeout || globalThis.setTimeout;
      this.playerProbeTimer = schedule.call(this.window, () => {
        this.playerProbeTimer = null;
        this._playerVideoProbe(attemptsLeft - 1);
      }, 2000);
    }

    _deferTransitionCheck() {
      this.awaitingVideo = true;
      if (this.transitionTimer !== null) return;
      const schedule = this.window?.setTimeout || globalThis.setTimeout;
      this.transitionTimer = schedule(() => {
        this.transitionTimer = null;
        if (this.state !== 'running') {
          this.awaitingVideo = false;
          return;
        }
        if (!this._allowedNow()) {
          this._setAttention('当前页面不在允许的学习页面范围内。');
          return;
        }
        const video = chooseVideo(this.document, this.window);
        if (video) {
          this.awaitingVideo = false;
          this._bindVideo(video, true);
          return;
        }
        if (this.playerMode) {
          if (this.playerProbeTimer === null) this._playerVideoProbe(15);
          return;
        }
        this._setAttention('页面变化后仍未找到唯一可见的视频。');
      }, 2000);
    }

    _cancelTransitionWait() {
      if (this.transitionTimer !== null) {
        const cancel = this.window?.clearTimeout || globalThis.clearTimeout;
        cancel(this.transitionTimer);
        this.transitionTimer = null;
      }
      this.awaitingVideo = false;
    }

    _detachVideo() {
      if (this.video && this.handlers) {
        for (const [type, handler] of Object.entries(this.handlers)) this.video.removeEventListener(type, handler);
      }
      this.video = null;
      this.handlers = null;
    }

    _disconnectObserver() {
      this.observer?.disconnect();
      this.observer = null;
    }

    diagnose() {
      const videos = this.document?.querySelectorAll ? Array.from(this.document.querySelectorAll('video')) : [];
      const frames = this.document?.querySelectorAll ? Array.from(this.document.querySelectorAll('iframe, frame')) : [];
      const controls = this.document?.querySelectorAll
        ? Array.from(this.document.querySelectorAll('button, a, [role="button"]'))
        : [];
      return {
        state: this.state,
        rate: this.rate,
        videoCount: videos.length,
        visibleVideoCount: videos.filter((video) => isVisible(video, this.window)).length,
        frameCount: frames.length,
        candidates: controls.slice(0, 100).map((element) => ({
          tag: String(element.tagName || '').toLowerCase(),
          role: getSafeDiagnosticRole(element),
          text: getSafeDiagnosticLabel(element),
          attributeNames: typeof element.getAttributeNames === 'function' ? element.getAttributeNames().slice(0, 30) : [],
          visible: isVisible(element, this.window),
          enabled: isEnabled(element),
        })),
      };
    }
  }

  const exported = { isAllowedUrl, isSafetyVideoUrl, isArticleStudyUrl, isCatalogUrl, unlearnedTabState, hasRecognizedCatalogTable, chooseVideo, chooseNext, chooseReturnHome, chooseArticleReturn, readStudyProgress, readCatalogRows, chooseCourseRow, chooseCatalogFirstPage, chooseCatalogNextPage, chooseDialogConfirm, dismissPlatformDialog, sanitizeText, StudyController };
  if (typeof module === 'object' && module && module.exports) module.exports = exported;

  const pageWindow = typeof window === 'undefined' ? null : window;
  const runtime = typeof chrome === 'undefined' ? null : chrome.runtime;
  if (pageWindow && runtime?.onMessage?.addListener) {
    try {
      document.documentElement.setAttribute('data-labsafe-ready', '1');
    } catch { /* 诊断标记失败不影响主流程 */ }
    const controller = pageWindow.__labsafeStudyHelper || new StudyController({ document, window: pageWindow });
    pageWindow.__labsafeStudyHelper = controller;
    if (!pageWindow.__labsafeStudyHelperListenerInstalled) {
      pageWindow.__labsafeStudyHelperListenerInstalled = true;
      runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (!message || typeof message.type !== 'string') return false;
        let response;
        switch (message.type) {
          case 'PING':
            response = { ok: true, status: controller.status() };
            break;
          case 'AUTO_CONTINUE':
            controller.autoContinue(message)
              .then((status) => {
                controller._markStep(`auto:${status.state}:${String(status.reason || '').slice(0, 50)}`);
                sendResponse({ ok: status.state !== 'needsAttention', status });
              })
              .catch(() => {
                controller._markStep('auto:exception');
                sendResponse({ ok: false, status: controller._setAttention('自动续学发生异常，已停止。') });
              });
            return true;
          case 'START':
            response = { ok: true, status: controller.start(message.rate) };
            break;
          case 'PAUSE':
            response = { ok: true, status: controller.pause() };
            break;
          case 'RESUME':
            response = { ok: true, status: controller.resume() };
            break;
          case 'STOP':
            response = { ok: true, status: controller.stop() };
            break;
          case 'SET_RATE':
            response = { ok: true, status: controller.setRate(message.rate) };
            break;
          case 'DIAGNOSE':
            response = { ok: true, diagnosis: controller.diagnose() };
            break;
          default:
            return false;
        }
        sendResponse(response);
        return false;
      });
    }
  }
})();
