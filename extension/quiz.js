(() => {
  'use strict';

  const STORAGE_KEY = 'labsafePracticeQuestionsV1';
  const BANK_KEY = 'labsafePracticeBanksV1';
  const BANK_LIST_KEY = 'labsafePracticeBankNamesV1';
  const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  const bankName = (value) => clean(value).replace(/^\d+[.．、]\s*/, '');

  function isPracticeUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && url.hostname === 'labsafe.lzjtu.edu.cn' && !url.port &&
        /^\/lab-study-front\/questionBank\/exercises\/[^/]+\/?$/.test(url.pathname);
    } catch { return false; }
  }

  function isBankUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && url.hostname === 'labsafe.lzjtu.edu.cn' && !url.port &&
        url.pathname.replace(/\/$/, '') === '/lab-study-front/questionBank';
    } catch { return false; }
  }

  function parseAnswer(text) {
    const feedback = clean(text);
    const judgment = feedback.match(/正确答案\s*[：:]\s*(正确|错误|对|错)(?=\s|我的答案|$)/);
    if (judgment) return [judgment[1] === '正确' ? '对' : judgment[1] === '错误' ? '错' : judgment[1]];
    const match = feedback.match(/正确答案\s*[：:]\s*([A-Z](?:[\s,，、/]*[A-Z])*)/i);
    if (!match) return null;
    return [...new Set((match[1].toUpperCase().match(/[A-Z]/g) || []))].sort();
  }

  function questionKey(bank, stem) {
    const value = `${clean(bank)}\0${clean(stem)}`;
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193) >>> 0;
    return `q-${hash.toString(36)}`;
  }

  function parseQuestionText(heading, choices, feedback) {
    const title = clean(heading).replace(/^\d+[.．、]\s*/, '');
    const kindMatch = title.match(/^(单选题|多选题|判断题)\s*/);
    const kind = kindMatch?.[1] === '多选题' ? 'multiple' : kindMatch?.[1] === '判断题' ? 'judgment' : kindMatch ? 'single' : null;
    const stem = clean(kindMatch ? title.slice(kindMatch[0].length) : title);
    const options = {};
    for (const choice of choices) {
      const label = clean(choice.textContent);
      const judgmentKey = kind === 'judgment' && /^(?:对|错|正确|错误)$/.test(label)
        ? (label === '正确' ? '对' : label === '错误' ? '错' : label) : null;
      const match = label.match(/^([A-Z])\s*[.．、,，]\s*(.+)$/i);
      const key = judgmentKey || match?.[1]?.toUpperCase();
      if (!key || options[key]) return null;
      options[key] = judgmentKey ? label : match[2];
    }
    if (!kind || !stem || Object.keys(options).length < 2) return null;
    return { kind, stem, options, correct: parseAnswer(feedback) };
  }

  function visible(element, view) {
    for (let node = element; node; node = node.parentElement) {
      if (node.hidden || node.getAttribute?.('aria-hidden') === 'true') return false;
      const style = view?.getComputedStyle?.(node) || node.style || {};
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    }
    const rect = element?.getBoundingClientRect?.();
    return !rect || (rect.width > 0 && rect.height > 0);
  }

  function buttonText(element) {
    return clean(element?.innerText ?? element?.textContent ?? element?.getAttribute?.('aria-label'));
  }

  function isChoiceLabel(element) {
    const label = buttonText(element);
    return /^[A-Z]\s*[.．、,，]/i.test(label) || /^(?:对|错|正确|错误)$/.test(label);
  }

  function exactControls(root, label, view) {
    return [...new Set(Array.from(root?.querySelectorAll?.('button, a, [role="button"], span, div') || []))]
      .filter((node) => buttonText(node) === label && visible(node, view) && !node.disabled &&
        node.getAttribute?.('aria-disabled') !== 'true' && !/(?:^|\s)[\w-]*disabled[\w-]*(?:\s|$)/.test(String(node.className || '')))
      .filter((node) => !Array.from(node.querySelectorAll?.('button, a, [role="button"], span, div') || []).some((child) => buttonText(child) === label));
  }

  function questionContainers(document, view) {
    const groups = Array.from(document?.querySelectorAll?.('.ivu-radio-group, .ivu-checkbox-group') || []).filter((group) => visible(group, view));
    const output = [];
    const seen = new Set();
    const wrappers = Array.from(document?.querySelectorAll?.('.ivu-radio-wrapper, .ivu-checkbox-wrapper') || [])
      .filter((label) => visible(label, view) && isChoiceLabel(label));
    for (const seed of [...groups, ...wrappers]) {
      let container = seed.parentElement;
      let labels = [];
      while (container && container !== document.body) {
        const text = clean(container.innerText ?? container.textContent);
        const count = container.querySelectorAll?.('.ivu-radio-group, .ivu-checkbox-group')?.length ?? 0;
        labels = Array.from(container.querySelectorAll?.('.ivu-radio-wrapper, .ivu-checkbox-wrapper, label') || [])
          .filter((label) => visible(label, view) && isChoiceLabel(label));
        if (count <= 1 && labels.length >= 2 && labels.length <= 8 &&
          /^(?:\d+[.．、]\s*)?(?:单选题|多选题|判断题)\s*/.test(text)) break;
        container = container.parentElement;
      }
      if (!container || container === document.body || seen.has(container)) continue;
      const whole = clean(container.innerText ?? container.textContent);
      const isJudgment = /^(?:\d+[.．、]\s*)?判断题/.test(whole);
      const pair = isJudgment ? labels.slice(0, 2).map(buttonText).join(' ') : '';
      const optionStart = isJudgment ? whole.lastIndexOf(pair) : whole.search(/\bA\s*[.．、,，]/i);
      if (optionStart < 0) continue;
      const heading = whole.slice(0, optionStart);
      const question = parseQuestionText(heading, labels, whole);
      if (!question) continue;
      seen.add(container);
      output.push({ ...question, container, group: groups.includes(seed) ? seed : null, labels });
    }
    return output;
  }

  function questionAction(question, known, view) {
    if (question.correct) return { type: 'record' };
    const answer = known?.correct?.length ? known.correct : [Object.keys(question.options)[0]];
    const selected = question.kind === 'multiple' ? answer : answer.slice(0, 1);
    const controls = selected.map((letter) => {
      const label = question.labels.find((node) => question.kind === 'judgment'
        ? (letter === '对' ? /^(?:对|正确)$/.test(buttonText(node)) : /^(?:错|错误)$/.test(buttonText(node)))
        : new RegExp(`^${letter}\\s*[.．、,，]`).test(buttonText(node)));
      return label;
    });
    if (controls.some((control) => !control || !visible(control, view))) return null;
    if (question.kind === 'multiple') {
      return { type: 'select', controls };
    }
    return { type: 'answer', controls };
  }

  function choiceState(label) {
    const input = label?.querySelector?.('input');
    if (typeof input?.checked === 'boolean') return input.checked;
    const classes = String(label?.className || '').split(/\s+/);
    if (classes.some((name) => /(?:^|-)checked(?:$|-)/.test(name))) return true;
    if (classes.some((name) => name === 'ivu-checkbox-wrapper')) return false;
    return null;
  }

  function nextPage(document, view) {
    const nodes = exactControls(document, '下一页', view);
    return nodes.length === 1 ? nodes[0] : null;
  }

  function bankCards(document, view) {
    return exactControls(document, '在线练习', view).map((control) => {
      let name = null;
      for (let node = control.parentElement, depth = 0; node && depth < 5; node = node.parentElement, depth += 1) {
        const text = clean(node.innerText ?? node.textContent);
        const matches = [...new Set(text.match(/[^\s，,。]{2,40}题库/g) || [])];
        if (matches.length === 1 && text.length < 180) { name = matches[0]; break; }
      }
      return name ? { name: bankName(name), control } : null;
    }).filter(Boolean);
  }

  const api = { STORAGE_KEY, BANK_KEY, BANK_LIST_KEY, bankName, isPracticeUrl, isBankUrl, parseAnswer, questionKey, parseQuestionText, questionContainers, questionAction, choiceState, nextPage, bankCards, exactControls, clean, visible };
  if (typeof module === 'object' && module?.exports) module.exports = api;
  if (typeof globalThis !== 'undefined') globalThis.LabSafeQuiz = api;
})();
