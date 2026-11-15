'use strict';

(function () {
  const $ = (sel) => document.querySelector(sel);
  const thread = $('#thread');
  const welcome = $('#welcome');
  const input = $('#input');
  const send = $('#send');
  const statusEl = $('#status');

  // ---------------------------------------------------------------- session
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  };
  let sessionId = store.get('kvant.session');
  if (!sessionId) {
    sessionId = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)).replace(/[^a-zA-Z0-9-]/g, '');
    store.set('kvant.session', sessionId);
  }
  let busy = false;

  // ---------------------------------------------------------------- helpers
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  const renderMarkdown = (md) => {
    const html = window.marked ? window.marked.parse(md, { gfm: true, breaks: false }) : md;
    const clean = window.DOMPurify ? window.DOMPurify.sanitize(html, { USE_PROFILES: { html: true } }) : '';
    const tpl = document.createElement('template');
    tpl.innerHTML = clean;
    tpl.content.querySelectorAll('a').forEach((a) => { a.target = '_blank'; a.rel = 'noopener noreferrer nofollow'; });
    return tpl.content;
  };

  const fmtMs = (ms) => (ms >= 1000 ? (ms / 1000).toFixed(1) + ' с' : ms + ' мс');

  const sparkline = (points) => {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 360 46');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.classList.add('spark');
    const vals = points.map((p) => p[1]);
    const min = Math.min(...vals), max = Math.max(...vals);
    const span = max - min || 1;
    const d = vals.map((v, i) => `${i ? 'L' : 'M'}${(i / Math.max(1, vals.length - 1)) * 356 + 2},${42 - ((v - min) / span) * 38}`).join(' ');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    path.setAttribute('class', vals[vals.length - 1] >= vals[0] ? 'up' : 'down');
    svg.appendChild(path);
    const title = document.createElementNS(ns, 'title');
    title.textContent = `${points[0][0]}: ${vals[0]} → ${points[points.length - 1][0]}: ${vals[vals.length - 1]}`;
    svg.appendChild(title);
    return svg;
  };

  const autosize = () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 180) + 'px';
  };

  // ---------------------------------------------------------------- status
  fetch('/api/health').then((r) => r.json()).then((h) => {
    statusEl.textContent = h.llmConfigured ? `${h.model} · онлайн` : 'модель не настроена';
    statusEl.classList.add(h.llmConfigured ? 'ok' : 'bad');
  }).catch(() => { statusEl.textContent = 'сервер недоступен'; statusEl.classList.add('bad'); });

  // ---------------------------------------------------------------- turn UI
  function createTurn(question) {
    welcome.hidden = true;
    thread.appendChild(el('div', 'msg-user', question));
    const box = el('article', 'msg-agent');
    const steps = el('details', 'steps');
    steps.open = true;
    const summary = el('summary', null, 'Агент планирует шаги…');
    const list = el('ol');
    steps.append(summary, list);
    const answer = el('div', 'answer');
    const meta = el('div', 'meta');
    box.append(steps, answer, meta);
    thread.appendChild(box);
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const stepNodes = new Map();
    let count = 0;
    const started = Date.now();

    return {
      queued(pos) { summary.textContent = `В очереди: ${pos}`; },
      start() { summary.textContent = 'Агент планирует шаги…'; },
      toolStart(ev) {
        count++;
        const li = el('li', 'step run');
        li.append(el('span', 'dot'));
        const body = el('div');
        body.append(el('div', 'label', ev.label));
        const sum = el('div', 'sum', describeArgs(ev.args));
        body.append(sum);
        li.append(body, el('span', 'ms', '…'));
        list.appendChild(li);
        stepNodes.set(ev.id || ev.tool + count, { li, sum, body });
        summary.textContent = `Шаги агента: ${count}`;
      },
      toolEnd(ev) {
        let node = stepNodes.get(ev.id);
        if (!node) node = [...stepNodes.values()].reverse().find((n) => n.li.classList.contains('run'));
        if (!node) return;
        node.li.className = 'step ' + (ev.ok === false ? 'err' : 'ok');
        node.sum.textContent = ev.summary || '';
        node.li.querySelector('.ms').textContent = ev.ms != null ? fmtMs(ev.ms) : '';
        if (ev.chart && ev.chart.points && ev.chart.points.length > 2) node.body.append(sparkline(ev.chart.points));
        if (ev.sources && ev.sources.length) {
          const src = el('div', 'src');
          ev.sources.forEach((u, i) => {
            const a = el('a', null, hostOf(u));
            a.href = u; a.target = '_blank'; a.rel = 'noopener noreferrer nofollow';
            if (i) src.append(' · ');
            src.append(a);
          });
          node.body.append(src);
        }
      },
      thinking(text) {
        const t = el('div', 'thinking', text.length > 280 ? text.slice(0, 280) + '…' : text);
        steps.appendChild(t);
      },
      answer(text) {
        answer.replaceChildren(renderMarkdown(text));
        if (count === 0) steps.remove();
        else steps.open = false;
      },
      check(c) {
        if (!c.checked) return;
        const b = el('span', 'badge ' + (c.ungrounded.length === 0 ? 'ok' : 'warn'));
        b.textContent = c.ungrounded.length === 0
          ? `✓ Все ${c.checked} чисел найдены в данных`
          : `Сверка чисел: ${c.grounded} из ${c.checked} найдены в данных`;
        if (c.ungrounded.length) b.title = 'Не найдены в данных (могут быть расчётными): ' + c.ungrounded.join(', ');
        meta.append(b);
        if (c.ungrounded.length) meta.append(el('span', null, 'Расчётные или непроверенные: ' + c.ungrounded.slice(0, 8).join(', ')));
      },
      done(ev) {
        meta.prepend(el('span', 'badge', `${fmtMs(ev.ms || Date.now() - started)} · шагов: ${count}`));
      },
      error(message) {
        answer.replaceChildren(el('div', 'error', message));
        steps.open = false;
      },
    };
  }

  function hostOf(u) {
    try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; }
  }

  function describeArgs(args) {
    if (!args) return '';
    const parts = [];
    for (const [k, v] of Object.entries(args)) {
      if (v == null || v === '') continue;
      if (Array.isArray(v)) parts.push(v.map((x) => (typeof x === 'object' ? x.ticker || JSON.stringify(x) : x)).join(', '));
      else if (typeof v === 'object') continue;
      else parts.push(`${k}: ${v}`);
    }
    return parts.join(' · ').slice(0, 200);
  }

  // ---------------------------------------------------------------- network
  async function ask(question) {
    if (busy || !question.trim()) return;
    busy = true;
    send.disabled = true;
    const turn = createTurn(question.trim());
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, message: question.trim() }),
      });
      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({}));
        turn.error(err.error || `Ошибка сервера (${res.status})`);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let gotAnswer = false;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const line = chunk.split('\n').find((l) => l.startsWith('data:'));
          if (!line) continue;
          let ev;
          try { ev = JSON.parse(line.slice(5)); } catch { continue; }
          switch (ev.type) {
            case 'session': if (ev.sessionId && ev.sessionId !== sessionId) { sessionId = ev.sessionId; store.set('kvant.session', sessionId); } break;
            case 'queued': turn.queued(ev.position); break;
            case 'start': turn.start(); break;
            case 'tool_start': turn.toolStart(ev); break;
            case 'tool_end': turn.toolEnd(ev); break;
            case 'thinking': turn.thinking(ev.text); break;
            case 'answer': gotAnswer = true; turn.answer(ev.text); break;
            case 'check': turn.check(ev); break;
            case 'done': turn.done(ev); break;
            case 'error': turn.error(ev.message); break;
            default: break;
          }
        }
      }
      if (!gotAnswer) turn.error('Соединение прервалось до ответа. Повторите вопрос.');
    } catch (e) {
      turn.error('Сеть недоступна: ' + (e && e.message ? e.message : e));
    } finally {
      busy = false;
      send.disabled = false;
      input.focus();
    }
  }

  // ---------------------------------------------------------------- events
  $('#ask').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = input.value;
    input.value = '';
    autosize();
    ask(q);
  });
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $('#ask').requestSubmit();
    }
  });

  document.querySelectorAll('.ex').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.open) {
      const form = document.getElementById(b.dataset.open);
      form.hidden = !form.hidden;
      if (!form.hidden) form.querySelector('textarea').focus();
      return;
    }
    ask(b.textContent);
  }));

  $('#portfolio').addEventListener('submit', (e) => {
    e.preventDefault();
    const lines = $('#pf-text').value.split('\n').map((l) => l.trim()).filter(Boolean);
    const items = lines.map((l) => {
      const m = /^(.*?)[\s:;]+([\d\s.,]+)\s*(₽|руб\.?|р\.?)?$/i.exec(l);
      if (!m) return l;
      const name = m[1].trim();
      const num = m[2].replace(/\s/g, '').replace(',', '.');
      if (/^(деньги|кэш|cash|рубли)$/i.test(name)) return `свободные деньги ${num} ₽`;
      return m[3] ? `${name} на ${num} ₽` : `${name} ${num} шт`;
    });
    ask(`Мой портфель: ${items.join('; ')}. ${$('#pf-goal').value}.`);
  });

  $('#reset').addEventListener('click', async () => {
    if (busy) return;
    await fetch('/api/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId }) }).catch(() => {});
    thread.replaceChildren();
    welcome.hidden = false;
    window.scrollTo({ top: 0 });
  });
})();
