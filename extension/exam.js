(() => {
  'use strict';

  const Quiz = globalThis.LabSafeQuiz || (typeof module === 'object' && module?.exports ? require('./quiz.js') : null);
  const clean = (value) => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const sameText = (value) => clean(value).replace(/\s/g, '').replace(/[，、]/g, ',');
  const optionText = (value) => {
    const text = sameText(value);
    return text === '正确' ? '对' : text === '错误' ? '错' : text;
  };

  function examQuestions(document, view) {
    const items = Array.from(document?.querySelectorAll?.('.answer-sheet .m-item') || []);
    const result = [];
    for (const container of items) {
      if (!Quiz.visible(container, view)) continue;
      const heading = clean(container.querySelector?.('h3.tit.item')?.innerText ??
        container.querySelector?.('h3.tit.item')?.textContent);
      const type = heading.match(/(?:判断题|单选题|多选题)/)?.[0];
      if (!type) continue;
      const stem = heading
        .replace(/^\s*\d+\s*[.．、]?\s*/, '')
        .replace(/^(?:判断题|单选题|多选题)\s*/, '')
        .replace(/^[（(]?\s*\d+(?:\.\d+)?\s*分\s*[）)]?\s*/, '')
        .replace(/^[：:]\s*/, '');
      const labels = Array.from(container.querySelectorAll?.('.select-box label') || [])
        .filter((label) => Quiz.visible(label, view));
      if (labels.length < 2 || labels.length > 8) continue;
      const parsed = Quiz.parseQuestionText(`${type} ${stem}`, labels, '');
      if (parsed) result.push({ ...parsed, container, labels });
    }
    return result;
  }

  function genericQuestions(document, view) {
    const labels = Array.from(document?.querySelectorAll?.('label') || [])
      .filter((node) => Quiz.visible(node, view) && /^(?:[A-Z]\s*[.．、,，]|对$|错$|正确$|错误$)/i.test(clean(node.innerText ?? node.textContent)));
    const found = new Map();
    for (const seed of labels) {
      for (let container = seed.parentElement; container && container !== document.body; container = container.parentElement) {
        const choices = Array.from(container.querySelectorAll?.('label') || [])
          .filter((node) => Quiz.visible(node, view) && labels.includes(node));
        if (choices.length < 2 || choices.length > 8) continue;
        const whole = clean(container.innerText ?? container.textContent);
        if (whole.length > 800) continue;
        const firstChoice = clean(choices[0].innerText ?? choices[0].textContent);
        const offset = whole.indexOf(firstChoice);
        if (offset < 2) continue;
        const heading = whole.slice(0, offset).trim();
        const type = /多选题|多选/.test(heading) ? '多选题' : /判断题|判断/.test(heading) ||
          choices.length === 2 && choices.every((node) => /^(?:对|错|正确|错误)$/.test(clean(node.innerText ?? node.textContent))) ? '判断题' :
          /单选题|单选/.test(heading) ? '单选题' :
          choices.every((node) => node.querySelector?.('input[type="checkbox"]')) ? '多选题' :
          choices.every((node) => node.querySelector?.('input[type="radio"]')) ? '单选题' : null;
        if (!type) continue;
        const stem = heading.replace(/^\d+[.．、]\s*/, '').replace(/^(?:单选题|多选题|判断题|单选|多选|判断)\s*/, '');
        const parsed = Quiz.parseQuestionText(`${type} ${stem}`, choices, whole);
        if (!parsed || found.has(container)) continue;
        found.set(container, { ...parsed, container, labels: choices });
        break;
      }
    }
    return Array.from(found.values());
  }

  function visibleQuestions(document, view) {
    const specific = examQuestions(document, view);
    if (specific.length) return specific;
    const original = Quiz?.questionContainers?.(document, view) || [];
    const fallback = genericQuestions(document, view);
    return [...original, ...fallback.filter((item) => !original.some((known) =>
      known.kind === item.kind && sameText(known.stem) === sameText(item.stem) &&
      Object.entries(known.options).map(([, value]) => optionText(value)).sort().join('\0') ===
      Object.entries(item.options).map(([, value]) => optionText(value)).sort().join('\0')))];
  }

  function answerPlan(question, records) {
    const stem = sameText(question.stem);
    const kind = question.kind;
    const currentOptions = Object.entries(question.options || {});
    if (!stem || !kind || currentOptions.length < 2) return null;
    const currentTexts = currentOptions.map(([, value]) => optionText(value));
    if (new Set(currentTexts).size !== currentTexts.length) return null;
    const currentSet = [...currentTexts].sort().join('\0');
    const answers = new Set();
    for (const record of Object.values(records || {})) {
      if (!record || record.kind !== kind || sameText(record.stem) !== stem || !Array.isArray(record.correct)) continue;
      const oldOptions = Object.entries(record.options || {});
      if (oldOptions.length !== currentOptions.length ||
        oldOptions.map(([, value]) => optionText(value)).sort().join('\0') !== currentSet) continue;
      const selectedTexts = record.correct.map((letter) => optionText(record.options[letter]));
      if (selectedTexts.some((value) => !value || !currentTexts.includes(value))) continue;
      const mapped = selectedTexts.map((value) => currentOptions.find(([, text]) => optionText(text) === value)?.[0]).sort();
      if (mapped.length !== record.correct.length ||
        (kind !== 'multiple' && mapped.length !== 1) || mapped.length === 0) continue;
      answers.add(mapped.join(','));
    }
    return answers.size === 1 ? [...answers][0].split(',') : null;
  }

  function choiceLabel(question, letter) {
    return question.labels?.find((node) => {
      const label = clean(node.innerText ?? node.textContent);
      if (letter === '对') return /^(?:对|正确)$/.test(label);
      if (letter === '错') return /^(?:错|错误)$/.test(label);
      return new RegExp(`^${letter}\\s*[.．、,，]`, 'i').test(label);
    }) || null;
  }

  async function fillCurrentPage(document, view, records, options = {}) {
    const parse = options.parse || visibleQuestions;
    const wait = options.wait || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const first = parse(document, view);
    if (!first.length) throw new Error('考试题目结构尚未识别，请保持页面并导出诊断。');
    const href = view?.location?.href;
    const targets = first.map((item) => ({ stem: sameText(item.stem), kind: item.kind }));
    const result = { visible: targets.length, matched: 0, filled: 0, skipped: 0 };
    for (const target of targets) {
      if (view?.location?.href !== href) break;
      let question = parse(document, view).filter((item) => item.kind === target.kind && sameText(item.stem) === target.stem);
      if (question.length !== 1) { result.skipped += 1; continue; }
      const desired = answerPlan(question[0], records);
      if (!desired) { result.skipped += 1; continue; }
      result.matched += 1;
      let valid = true;
      for (let attempt = 0; attempt < desired.length + 2; attempt += 1) {
        question = parse(document, view).filter((item) => item.kind === target.kind && sameText(item.stem) === target.stem);
        if (view?.location?.href !== href || question.length !== 1) { valid = false; break; }
        const selected = new Set();
        for (const letter of Object.keys(question[0].options)) {
          const label = choiceLabel(question[0], letter);
          if (!label) { valid = false; break; }
          const state = Quiz.choiceState(label);
          if (state === null) { valid = false; break; }
          if (state) selected.add(letter);
        }
        if (!valid || [...selected].some((letter) => !desired.includes(letter))) { valid = false; break; }
        const missing = desired.find((letter) => !selected.has(letter));
        if (!missing) break;
        const label = choiceLabel(question[0], missing);
        if (!label || !Quiz.visible(label, view) || label.disabled || label.getAttribute?.('aria-disabled') === 'true') {
          valid = false; break;
        }
        label.click();
        await wait(1000);
      }
      question = parse(document, view).filter((item) => item.kind === target.kind && sameText(item.stem) === target.stem);
      if (valid && question.length === 1 && desired.every((letter) => Quiz.choiceState(choiceLabel(question[0], letter)) === true)) {
        result.filled += 1;
      } else {
        result.skipped += 1;
      }
    }
    return result;
  }

  function pageSignature(questions) {
    return questions.map((item) => `${item.kind}:${sameText(item.stem)}`).join('\0');
  }

  function nextPageControl(document, view) {
    const root = document?.querySelector?.('.answer-sheet');
    if (!root) return null;
    const candidates = Array.from(root.querySelectorAll?.('.next-page-wrap, button, [role="button"]') || [])
      .filter((node) => clean(node.innerText ?? node.textContent) === '下一页' && Quiz.visible(node, view) &&
        !node.disabled && node.getAttribute?.('aria-disabled') !== 'true' &&
        !/(?:^|\s|-)disabled(?:\s|$)/.test(String(node.className || '')));
    return candidates.length === 1 ? candidates[0] : null;
  }

  async function fillForward(document, view, records, options = {}) {
    const parse = options.parse || visibleQuestions;
    const wait = options.wait || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const next = options.next || nextPageControl;
    const startHref = view?.location?.href;
    const visited = new Set();
    const total = { pages: 0, visible: 0, matched: 0, filled: 0, skipped: 0, stoppedReason: '' };
    for (let page = 0; page < 25; page += 1) {
      if (view?.location?.href !== startHref) { total.stoppedReason = '考试页面已切换'; break; }
      const questions = parse(document, view);
      const signature = pageSignature(questions);
      if (!signature || visited.has(signature)) { total.stoppedReason = '题目页未变化'; break; }
      visited.add(signature);
      const result = await fillCurrentPage(document, view, records, { parse, wait });
      total.pages += 1;
      for (const key of ['visible', 'matched', 'filled', 'skipped']) total[key] += result[key];
      if (view?.location?.href !== startHref) { total.stoppedReason = '考试页面已切换'; break; }
      const control = next(document, view);
      if (!control) { total.stoppedReason = '末页或未找到唯一可用的下一页'; break; }
      control.click();
      let changed = false;
      for (let tick = 0; tick < 40; tick += 1) {
        await wait(250);
        if (view?.location?.href !== startHref) break;
        const candidate = pageSignature(parse(document, view));
        if (candidate && candidate !== signature) { changed = true; break; }
      }
      if (!changed) { total.stoppedReason = '点击下一页后题目未变化'; break; }
    }
    if (!total.stoppedReason) total.stoppedReason = '已达到单次最多 25 页的上限';
    return total;
  }

  const api = { examQuestions, visibleQuestions, genericQuestions, answerPlan, fillCurrentPage,
    nextPageControl, fillForward };
  if (typeof module === 'object' && module?.exports) module.exports = api;
  if (typeof globalThis !== 'undefined') globalThis.LabSafeExam = api;
})();
