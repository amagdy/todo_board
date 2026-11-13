/* Task Board frontend - vanilla JS, no build step. */
const TB = (() => {
  // ------------------------------------------------------------- utilities
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v == null) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'html') el.innerHTML = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(kid));
    }
    return el;
  }

  async function api(method, url, body) {
    const opts = { method, headers: {} };
    if (body instanceof FormData) opts.body = body;
    else if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { toast(data.error || 'Request failed', true); throw new Error(data.error); }
    return data;
  }

  let toastTimer;
  function toast(msg, isError) {
    const t = document.getElementById('toast');
    t.textContent = msg; t.className = 'toast' + (isError ? ' error' : ''); t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 3500);
  }

  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                    .replace(/"/g, '&quot;');

  function textColor(bg) {
    const n = parseInt(bg.slice(1), 16);
    const l = 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
    return l > 150 ? '#111' : '#fff';
  }

  function fmtDate(d) {
    if (!d) return '';
    return new Date(d + 'T00:00:00').toLocaleDateString(undefined,
      { year: 'numeric', month: 'short', day: 'numeric' });
  }
  const isOverdue = (t) => t.due_date && !t.done && t.due_date < new Date().toISOString().slice(0, 10);
  const fmtEst = t => t.estimate_value == null ? '' :
    `${+t.estimate_value} ${t.estimate_unit === 'hours' ? 'h' : 'd'}`;

  // ------------------------------------------------------- markdown render
  function inline(s) {
    s = esc(s);
    const codes = [];
    s = s.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, u) =>
      /^(https?:|\/)/i.test(u) ? `<img src="${u}" alt="${alt}" loading="lazy">` : m);
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) =>
      /^(https?:|mailto:|\/)/i.test(u) ? `<a href="${u}" target="_blank" rel="noopener">${t}</a>` : _);
    s = s.replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_, a, b) => `<strong>${a || b}</strong>`);
    s = s.replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\w)|(^|[^_\w])_([^_\s][^_]*)_(?!\w)/g,
      (_, p1, a, p2, b) => `${p1 || p2}<em>${a || b}</em>`);
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
  }

  const splitRow = l => l.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/)
    .map(c => c.trim().replace(/\\\|/g, '|'));
  const isSepRow = l => l != null && l.includes('-') && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(l);
  const tableStart = (lines, i) => lines[i].includes('|') && isSepRow(lines[i + 1]);

  function renderMarkdown(src) {
    const lines = src.replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      let m;
      if (/^```/.test(line)) {
        const buf = []; i++;
        while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
        i++;
        out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
      } else if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
        out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); i++;
      } else if (/^(-{3,}|\*{3,})\s*$/.test(line)) { out.push('<hr>'); i++; }
      else if (/^>\s?/.test(line)) {
        const buf = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
        out.push(`<blockquote>${renderMarkdown(buf.join('\n'))}</blockquote>`);
      } else if (tableStart(lines, i)) {
        const head = splitRow(lines[i]);
        const align = splitRow(lines[i + 1]).map(c =>
          /^:-+:$/.test(c) ? 'center' : /^-+:$/.test(c) ? 'right' : /^:-+$/.test(c) ? 'left' : '');
        i += 2;
        const cell = (tag, c, k) => `<${tag}${align[k] ? ` style="text-align:${align[k]}"` : ''}>${inline(c)}</${tag}>`;
        const body = [];
        while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
          const cells = splitRow(lines[i++]);
          body.push(`<tr>${head.map((_, k) => cell('td', cells[k] || '', k)).join('')}</tr>`);
        }
        out.push(`<div class="md-table"><table><thead><tr>${head.map((c, k) => cell('th', c, k)).join('')}</tr></thead>` +
                 `<tbody>${body.join('')}</tbody></table></div>`);
      } else if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
        const ordered = /^\s*\d+\./.test(line);
        const items = [];
        while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
          let text = lines[i++].replace(/^\s*([-*+]|\d+\.)\s+/, '');
          const task = text.match(/^\[([ xX])\]\s+(.*)$/);
          text = task ? `<input type="checkbox" disabled ${task[1] !== ' ' ? 'checked' : ''}> ${inline(task[2])}`
                      : inline(text);
          items.push(`<li>${text}</li>`);
        }
        out.push(`<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`);
      } else {
        const buf = [];
        do buf.push(lines[i++]);
        while (i < lines.length && lines[i].trim() && !tableStart(lines, i) &&
               !/^(#{1,6}\s|```|>|\s*([-*+]|\d+\.)\s+|-{3,}\s*$)/.test(lines[i]));
        out.push(`<p>${buf.map(inline).join('<br>')}</p>`);
      }
    }
    return out.join('');
  }

  // --------------------------------------------------------- UI components
  /** Click-to-edit input that looks like plain text. Calls onSave(newValue). */
  function inlineText(value, onSave, { cls = '', placeholder = '', required = true } = {}) {
    const input = h('input', { class: 'inline-edit ' + cls, value, placeholder, spellcheck: 'false' });
    input.value = value;
    let current = value;
    const commit = async () => {
      const v = input.value.trim();
      if (v === current) return;
      if (required && !v) { toast('Title is required', true); input.value = current; return; }
      try { await onSave(v); current = v; } catch { input.value = current; }
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') input.blur();
      if (e.key === 'Escape') { input.value = current; input.blur(); }
    });
    input.addEventListener('mousedown', e => e.stopPropagation());
    return input;
  }

  /** Markdown description: rendered as rich text, click to edit raw markdown. */
  function markdownEditor(value, onSave) {
    const box = h('div', { class: 'md-box' });
    let current = value;
    const show = () => {
      box.replaceChildren(h('div', {
        class: 'md' + (current ? '' : ' empty'), title: 'Click to edit',
        html: current ? renderMarkdown(current) : 'Click to add a description (Markdown supported)…',
        onclick: e => { if (e.target.closest('a')) return; edit(); },
      }));
    };
    const edit = () => {
      const ta = h('textarea', { class: 'md-input', rows: 6, placeholder: 'Write Markdown…' });
      ta.value = current;
      const save = async () => {
        try { await onSave(ta.value.trim()); current = ta.value.trim(); show(); } catch {}
      };
      ta.addEventListener('keydown', e => {
        if (e.key === 'Escape') show();
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save();
      });
      box.replaceChildren(ta, h('div', { class: 'row gap' },
        h('button', { class: 'btn primary small', onclick: save }, 'Save'),
        h('button', { class: 'btn small', onclick: show }, 'Cancel'),
        h('span', { class: 'muted small' }, 'Ctrl+Enter to save')));
      ta.focus();
    };
    show();
    return box;
  }

  function chip(tag, onRemove) {
    return h('span', { class: 'chip', style: `background:${tag.color};color:${textColor(tag.color)}` },
      tag.name, onRemove && h('button', {
        class: 'chip-x', title: 'Remove tag', onclick: e => { e.stopPropagation(); onRemove(); } }, '×'));
  }

  let allTags = [];
  async function loadTags() { allTags = await api('GET', '/api/tags'); return allTags; }

  /** Tag chips + an input for adding. onChange(names[]) persists. */
  function tagEditor(tags, onChange) {
    let names = tags.map(t => t.name);
    const wrap = h('span', { class: 'tag-editor' });
    const dlId = 'dl' + Math.random().toString(36).slice(2);
    const render = () => {
      const input = h('input', { class: 'tag-input', placeholder: '+ tag', list: dlId, size: 8 });
      const add = () => {
        const v = input.value.trim().replace(/^#/, '');
        if (v && !names.some(n => n.toLowerCase() === v.toLowerCase())) { names.push(v); onChange(names); }
        input.value = '';
      };
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(); }
      });
      input.addEventListener('change', add);
      wrap.replaceChildren(
        ...tags.map(t => chip(t, () => { names = names.filter(n => n !== t.name); onChange(names); })),
        input,
        h('datalist', { id: dlId }, allTags.filter(t => !names.includes(t.name))
          .map(t => h('option', { value: t.name }))));
    };
    render();
    return wrap;
  }

  function progressBar(p) {
    if (!p.total) return null;
    const pct = Math.round(100 * p.done / p.total);
    return h('span', { class: 'progress', title: `${p.done} of ${p.total} subtasks done (${pct}%)` },
      h('span', { class: 'bar' }, h('span', { style: `width:${pct}%` })),
      h('span', { class: 'progress-label' }, `${p.done}/${p.total}`));
  }

  // ------------------------------------------------------- global controls
  function initGlobal() {
    document.getElementById('backup-btn').onclick = async e => {
      e.target.disabled = true;
      try { toast((await api('POST', '/api/backup')).message); } finally { e.target.disabled = false; }
    };
    document.getElementById('tags-btn').onclick = openTagManager;
  }

  async function openTagManager() {
    const dlg = document.getElementById('tags-dialog');
    const render = async () => {
      const tags = await loadTags();
      dlg.replaceChildren(
        h('h3', {}, 'Manage tags'),
        tags.length ? h('div', { class: 'tag-list' }, tags.map(t => h('div', { class: 'row gap tag-row' },
          h('input', { type: 'color', value: t.color, onchange: e =>
            api('PATCH', `/api/tags/${t.id}`, { color: e.target.value }) }),
          inlineText(t.name, async v => { await api('PATCH', `/api/tags/${t.id}`, { name: v }); },
            { cls: 'grow' }),
          h('button', { class: 'btn small danger', onclick: async () => {
            if (!confirm(`Delete tag "${t.name}"? It will be removed from all tasks and resources.`)) return;
            await api('DELETE', `/api/tags/${t.id}`); await render(); refreshPage();
          } }, 'Delete'))))
          : h('p', { class: 'muted' }, 'No tags yet. Add tags to tasks, projects or resources.'),
        h('div', { class: 'row end' }, h('button', { class: 'btn', onclick: () => { dlg.close(); refreshPage(); } }, 'Close')));
    };
    await render();
    dlg.showModal();
  }
  let refreshPage = () => {};

  // ------------------------------------------------------------ index page
  async function initIndex() {
    initGlobal();
    const grid = document.getElementById('projects');
    const load = async () => {
      await loadTags();
      const projects = await api('GET', '/api/projects');
      grid.replaceChildren(...projects.map(p => h('a', { class: 'card project-card' + (p.done ? ' done' : ''), href: `/task/${p.id}` },
        h('div', { class: 'card-title' }, p.title),
        p.description && h('div', { class: 'card-desc' }, p.description.replace(/[#*_`>\[\]]/g, '').slice(0, 140)),
        h('div', { class: 'meta' },
          p.due_date && h('span', { class: isOverdue(p) ? 'overdue' : '' }, '📅 ' + fmtDate(p.due_date)),
          p.estimate_value != null && h('span', {}, '⏱ ' + fmtEst(p))),
        progressBar(p.progress) || h('div', { class: 'muted small' }, 'No tasks yet'),
        h('div', { class: 'chips' }, p.tags.map(t => chip(t))))));
      if (!projects.length) grid.append(h('p', { class: 'muted' }, 'No projects yet — create your first one.'));
    };
    refreshPage = load;
    document.getElementById('new-project').onclick = () => {
      if (document.getElementById('new-project-card')) return;
      const input = h('input', { class: 'inline-edit big', placeholder: 'Project title…' });
      const create = async () => {
        const title = input.value.trim();
        if (!title) { card.remove(); return; }
        const { id } = await api('POST', '/api/tasks', { title });
        location.href = `/task/${id}`;
      };
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') create();
        if (e.key === 'Escape') card.remove();
      });
      input.addEventListener('blur', () => setTimeout(() => { if (card.isConnected) card.remove(); }, 150));
      const card = h('div', { class: 'card project-card', id: 'new-project-card' }, input,
        h('div', { class: 'row gap' }, h('button', { class: 'btn primary small', onmousedown: create }, 'Create')));
      grid.prepend(card); input.focus();
    };
    load();
  }

  // ------------------------------------------------------------- task page
  async function initTask(rootId) {
    initGlobal();
    const root = document.getElementById('task-root');
    const collapsed = new Set(JSON.parse(localStorage.getItem('tb.collapsed') || '[]'));
    const saveCollapsed = () => localStorage.setItem('tb.collapsed', JSON.stringify([...collapsed]));
    const filter = { q: '', tags: new Set() };
    let state, index;               // index: id -> {node, parent}
    let dragId = null;
    let focusFilter = false;

    const patch = (id, body) => api('PATCH', `/api/tasks/${id}`, body);
    const reload = async (keepScroll = true) => {
      const y = window.scrollY;
      await loadTags();
      state = await api('GET', `/api/task/${rootId}`);
      index = new Map();
      (function walk(n, parent) { index.set(n.id, { node: n, parent }); n.children.forEach(c => walk(c, n)); })(state.task, null);
      document.title = state.task.title + ' · Task Board';
      render();
      if (keepScroll) window.scrollTo(0, y);
    };
    refreshPage = reload;

    // ---- screen
    function render() {
      const t = state.task, isProject = t.task_type === 'project';
      const hadFocus = document.activeElement && document.activeElement.id === 'filter-q';
      root.replaceChildren(
        h('nav', { class: 'crumbs' },
          h('a', { href: '/' }, 'Projects'),
          state.breadcrumbs.map(b => [' / ', h('a', { href: `/task/${b.id}` }, b.title)]),
          ' / ', h('span', {}, t.title)),
        header(t, isProject),
        h('div', { class: 'two-col' }, tasksComponent(t), resourcesComponent(t)));
      if (hadFocus || focusFilter) { const f = document.getElementById('filter-q'); f.focus(); f.setSelectionRange(f.value.length, f.value.length); focusFilter = false; }
    }

    function header(t, isProject) {
      const unit = h('select', { class: 'select', onchange: e => patch(t.id, { estimate_unit: e.target.value }).then(reload) },
        h('option', { value: 'days', selected: t.estimate_unit === 'days' }, 'days'),
        h('option', { value: 'hours', selected: t.estimate_unit === 'hours' }, 'hours'));
      return h('section', { class: 'card header-card' + (t.done ? ' done' : '') },
        h('div', { class: 'row gap center' },
          h('input', { type: 'checkbox', class: 'big-check', checked: t.done, title: 'Mark as done',
            onchange: e => patch(t.id, { done: e.target.checked }).then(reload) }),
          h('span', { class: 'badge' }, isProject ? 'Project' : 'Task'),
          inlineText(t.title, v => patch(t.id, { title: v }).then(() => { document.title = v; }), { cls: 'title-input grow' }),
          h('button', { class: 'btn danger', onclick: async () => {
            const n = t.progress.total;
            if (!confirm(`Delete ${isProject ? 'project' : 'task'} "${t.title}"` +
                (n ? ` and its ${n} subtask${n > 1 ? 's' : ''}` : '') + `, including all attached files?\nThis cannot be undone.`)) return;
            const r = await api('DELETE', `/api/tasks/${t.id}`);
            location.href = r.parent_task_id ? `/task/${r.parent_task_id}` : '/';
          } }, 'Delete ' + (isProject ? 'project' : 'task'))),
        t.progress.total ? h('div', { class: 'row gap center' }, progressBar(t.progress),
          h('span', { class: 'muted small' }, 'of all nested subtasks done')) : null,
        h('div', { class: 'fields' },
          h('label', {}, 'Due date',
            h('input', { type: 'date', class: 'input', value: t.due_date || '',
              onchange: e => patch(t.id, { due_date: e.target.value }).then(reload) })),
          h('label', {}, 'Estimate',
            h('span', { class: 'row gap' },
              h('input', { type: 'number', min: 0, step: 'any', class: 'input narrow', value: t.estimate_value ?? '',
                placeholder: '—', onchange: e => patch(t.id, { estimate_value: e.target.value }).then(reload) }), unit)),
          h('label', { class: 'grow' }, 'Tags',
            tagEditor(t.tags, async names => { await api('PUT', `/api/tasks/${t.id}/tags`, { tags: names }); reload(); }))),
        h('div', { class: 'section-label' }, 'Description'),
        markdownEditor(t.description, v => patch(t.id, { description: v })));
    }

    // ---- task view component
    function matches(n) {
      const hay = (n.title + ' ' + n.description + ' ' + n.tags.map(t => t.name).join(' ')).toLowerCase();
      const words = filter.q.toLowerCase().split(/\s+/).filter(Boolean);
      if (!words.every(w => hay.includes(w))) return false;
      return [...filter.tags].every(name => n.tags.some(t => t.name === name));
    }
    const filtering = () => filter.q.trim() !== '' || filter.tags.size > 0;
    /** Returns set of ids to show (matches + their ancestors) or null for all. */
    function visibleSet() {
      if (!filtering()) return null;
      const vis = new Set();
      (function walk(n, path) {
        if (matches(n)) { vis.add(n.id); path.forEach(p => vis.add(p.id)); }
        n.children.forEach(c => walk(c, [...path, n]));
      })({ ...state.task, children: state.task.children }, []);
      return vis;
    }
    // top node is the root itself; only its children are displayed
    function usedTags() {
      const seen = new Map();
      (function walk(n) { n.children.forEach(c => { c.tags.forEach(t => seen.set(t.name, t)); walk(c); }); })(state.task);
      return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
    }

    function tasksComponent(root) {
      const vis = visibleSet();
      const list = h('ul', { class: 'task-list' });
      const rows = vis ? root.children.filter(c => vis.has(c.id)) : root.children;
      rows.forEach(c => list.append(taskRow(c, vis)));
      const addInput = h('input', { class: 'input grow', placeholder: 'Add a task and press Enter…',
        onkeydown: async e => {
          if (e.key !== 'Enter' || !e.target.value.trim()) return;
          await api('POST', '/api/tasks', { title: e.target.value.trim(), parent_task_id: root.id });
          focusAdd = true; await reload();
        } });
      if (focusAdd) { setTimeout(() => addInput.focus()); focusAdd = false; }
      return h('section', { class: 'card tasks-panel', id: 'tasks-panel' },
        h('h2', {}, 'Tasks'),
        h('div', { class: 'filters' },
          h('input', { id: 'filter-q', class: 'input', type: 'search', placeholder: 'Search tasks…', value: filter.q,
            oninput: e => { filter.q = e.target.value; focusFilter = true; render(); } }),
          h('div', { class: 'chips' }, usedTags().map(t => h('button', {
            class: 'chip filter-chip' + (filter.tags.has(t.name) ? ' on' : ''),
            style: `--c:${t.color};background:${filter.tags.has(t.name) ? t.color : 'transparent'};color:${filter.tags.has(t.name) ? textColor(t.color) : 'inherit'}`,
            onclick: () => { filter.tags.has(t.name) ? filter.tags.delete(t.name) : filter.tags.add(t.name); render(); } }, t.name)),
            filtering() && h('button', { class: 'btn small', onclick: () => { filter.q = ''; filter.tags.clear(); render(); } }, 'Clear filter'))),
        filtering() ? h('div', { class: 'muted small' }, 'Drag & drop is disabled while filtering.') : null,
        rows.length ? list : h('p', { class: 'muted' }, filtering() ? 'No tasks match.' : 'No tasks yet.'),
        h('div', { class: 'row gap add-row' }, addInput));
    }
    let focusAdd = false;

    function taskRow(n, vis) {
      const hasKids = n.children.length > 0;
      const open = vis ? true : !collapsed.has(n.id);
      const canDrag = !filtering();
      const row = h('div', { class: 'task-row' + (n.done ? ' done' : ''), draggable: canDrag, 'data-id': n.id },
        h('span', { class: 'handle', title: canDrag ? 'Drag to reorder / nest' : '' }, canDrag ? '⋮⋮' : ''),
        canDrag ? moveButtons(n) : null,
        h('button', { class: 'twisty' + (hasKids ? '' : ' hidden'), onclick: () => {
          open ? collapsed.add(n.id) : collapsed.delete(n.id); saveCollapsed(); render(); } }, open ? '▾' : '▸'),
        h('input', { type: 'checkbox', checked: n.done, title: 'Mark as done',
          onchange: e => patch(n.id, { done: e.target.checked }).then(reload) }),
        inlineText(n.title, v => patch(n.id, { title: v }).then(reload), { cls: 'task-title grow' }),
        h('span', { class: 'row-meta' },
          n.due_date && h('span', { class: 'meta-item' + (isOverdue(n) ? ' overdue' : '') }, '📅 ' + fmtDate(n.due_date)),
          n.estimate_value != null && h('span', { class: 'meta-item' }, '⏱ ' + fmtEst(n)),
          progressBar(n.progress)),
        tagEditor(n.tags, async names => { await api('PUT', `/api/tasks/${n.id}/tags`, { tags: names }); reload(); }),
        h('button', { class: 'icon-btn', title: 'Add subtask', onclick: () => addSub(n) }, '＋'),
        h('a', { class: 'icon-btn', title: 'Open / edit task', href: `/task/${n.id}` }, '✎'),
        h('button', { class: 'icon-btn danger', title: 'Delete task', onclick: async () => {
          const k = n.progress.total;
          if (!confirm(`Delete task "${n.title}"` + (k ? ` and its ${k} subtask${k > 1 ? 's' : ''}` : '') + ' and attached files?')) return;
          await api('DELETE', `/api/tasks/${n.id}`); reload(); } }, '🗑'));
      if (canDrag) wireDrag(row, n);
      const li = h('li', { class: 'task-item' }, row);
      if (hasKids && open) {
        const sub = h('ul', { class: 'task-list nested' });
        n.children.filter(c => !vis || vis.has(c.id)).forEach(c => sub.append(taskRow(c, vis)));
        li.append(sub);
      }
      return li;
    }

    /** Up/down arrows: swap with the previous/next sibling (same parent). */
    function moveButtons(n) {
      const sibs = index.get(n.id).parent.children;
      const i = sibs.findIndex(c => c.id === n.id);
      const move = async newIdx => {
        await api('POST', `/api/tasks/${n.id}/move`,
          { parent_task_id: index.get(n.id).parent.id, index: newIdx });
        reload();
      };
      return h('span', { class: 'move-btns' },
        h('button', { class: 'icon-btn', title: 'Move up (higher priority)', disabled: i === 0,
          onclick: () => move(i - 1) }, '▲'),
        h('button', { class: 'icon-btn', title: 'Move down (lower priority)', disabled: i === sibs.length - 1,
          onclick: () => move(i + 1) }, '▼'));
    }

    function addSub(n) {
      const title = prompt(`New subtask under "${n.title}":`);
      if (!title || !title.trim()) return;
      collapsed.delete(n.id); saveCollapsed();
      api('POST', '/api/tasks', { title: title.trim(), parent_task_id: n.id }).then(() => reload());
    }

    // ---- drag & drop (top quarter: before, bottom quarter: after, middle: nest inside)
    function isDescendant(id, ofId) {
      let p = index.get(id)?.parent;
      while (p) { if (p.id === ofId) return true; p = index.get(p.id).parent; }
      return false;
    }
    function zoneOf(e, row) {
      const r = row.getBoundingClientRect(), y = (e.clientY - r.top) / r.height;
      return y < 0.3 ? 'before' : y > 0.7 ? 'after' : 'inside';
    }
    function wireDrag(row, n) {
      row.addEventListener('dragstart', e => {
        dragId = n.id; e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(n.id));
        setTimeout(() => row.classList.add('dragging'), 0);
      });
      row.addEventListener('dragend', () => {
        dragId = null; document.querySelectorAll('.drop-before,.drop-after,.drop-inside,.dragging')
          .forEach(el => el.classList.remove('drop-before', 'drop-after', 'drop-inside', 'dragging'));
      });
      row.addEventListener('dragover', e => {
        if (dragId == null || dragId === n.id || isDescendant(n.id, dragId)) return;
        e.preventDefault(); e.dataTransfer.dropEffect = 'move';
        const z = zoneOf(e, row);
        row.classList.toggle('drop-before', z === 'before');
        row.classList.toggle('drop-after', z === 'after');
        row.classList.toggle('drop-inside', z === 'inside');
      });
      row.addEventListener('dragleave', () => row.classList.remove('drop-before', 'drop-after', 'drop-inside'));
      row.addEventListener('drop', async e => {
        e.preventDefault();
        const z = zoneOf(e, row), id = dragId; dragId = null;
        if (id == null || id === n.id || isDescendant(n.id, id)) return;
        let parentId, idx;
        if (z === 'inside') { parentId = n.id; idx = 1e9; collapsed.delete(n.id); saveCollapsed(); }
        else {
          const parent = index.get(n.id).parent;
          parentId = parent.id;
          const sibs = parent.children.filter(c => c.id !== id);
          idx = sibs.findIndex(c => c.id === n.id) + (z === 'after' ? 1 : 0);
        }
        await api('POST', `/api/tasks/${id}/move`, { parent_task_id: parentId, index: idx });
        reload();
      });
    }

    // ---- resources component
    function resourcesComponent(t) {
      const res = state.resources;
      const fileIn = h('input', { type: 'file', class: 'file-input' });
      const fileDesc = h('input', { class: 'input grow', placeholder: 'Description (optional)' });
      const urlIn = h('input', { class: 'input grow', placeholder: 'https://… link' });
      const linkDesc = h('input', { class: 'input grow', placeholder: 'Description (optional)' });
      const upload = async () => {
        if (!fileIn.files[0]) { toast('Choose a file first', true); return; }
        const fd = new FormData();
        fd.append('file', fileIn.files[0]); fd.append('description', fileDesc.value);
        await api('POST', `/api/tasks/${t.id}/resources`, fd); toast('File uploaded'); reload();
      };
      const addLink = async () => {
        if (!urlIn.value.trim()) { toast('Enter a URL', true); return; }
        await api('POST', `/api/tasks/${t.id}/resources`, { url: urlIn.value, description: linkDesc.value }); reload();
      };
      urlIn.addEventListener('keydown', e => { if (e.key === 'Enter') addLink(); });
      return h('section', { class: 'card resources-panel' },
        h('h2', {}, 'Resources ', h('span', { class: 'muted small' }, `${res.length} incl. all subtasks`)),
        res.length ? h('ul', { class: 'res-list' }, res.map(r => resourceItem(r, t))) : h('p', { class: 'muted' }, 'No files or links yet.'),
        h('div', { class: 'add-box' }, h('div', { class: 'section-label' }, 'Upload a file'),
          h('div', { class: 'row gap wrap' }, fileIn, fileDesc, h('button', { class: 'btn', onclick: upload }, 'Upload'))),
        h('div', { class: 'add-box' }, h('div', { class: 'section-label' }, 'Add a link'),
          h('div', { class: 'row gap wrap' }, urlIn, linkDesc, h('button', { class: 'btn', onclick: addLink }, 'Add link'))));
    }

    function resourceItem(r, t) {
      const isFile = r.resource_type === 'file';
      const title = isFile
        ? h('a', { href: `/resources/${r.id}/download`, class: 'res-name' }, '📎 ' + r.name)
        : h('a', { href: r.path, target: '_blank', rel: 'noopener', class: 'res-name' }, '🔗 ' + r.path);
      return h('li', { class: 'res-item' },
        h('div', { class: 'row gap center' }, title, h('span', { class: 'grow' }),
          h('button', { class: 'icon-btn danger', title: 'Remove', onclick: async () => {
            if (!confirm(`Remove this ${isFile ? 'file (it will be deleted from disk)' : 'link'}?\n${r.name}`)) return;
            await api('DELETE', `/api/resources/${r.id}`); reload(); } }, '🗑')),
        inlineText(r.description, v => api('PATCH', `/api/resources/${r.id}`, { description: v }),
          { cls: 'res-desc', placeholder: 'Add description…', required: false }),
        h('div', { class: 'row gap center wrap small muted' },
          r.task_id !== t.id ? h('span', {}, 'from ', h('a', { href: `/task/${r.task_id}` }, r.task_title)) : h('span', {}, 'attached here'),
          tagEditor(r.tags, async names => { await api('PUT', `/api/resources/${r.id}/tags`, { tags: names }); reload(); })));
    }

    await reload(false);
  }

  return { initIndex, initTask };
})();
