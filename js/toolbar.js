// MathSheets title bar (logo, file name, menus), editing toolbar, sheet tab bar, toasts and auto-save.
// Talks to the rest of the app only through Sheet (commands, styles, events), Menu/icon (ui-kit.js) and Grid.startEdit.
const Toolbar = (() => {
  const S = Sheet, MAC = /Mac|iPhone|iPad/.test(navigator.platform), STORE = 'mathsheets.v2';
  const sc = k => MAC ? k.replace('mod+', '⌘').replace('shift+', '⇧').replace('alt+', '⌥') : k.replace('mod+', 'Ctrl+').replace('shift+', 'Shift+').replace('alt+', 'Alt+');
  const h = (tag, cls, html = '') => { const e = document.createElement(tag); if (cls) e.className = cls; e.innerHTML = html; return e; };
  const noFocus = e => e.preventDefault();
  const focusGrid = () => S.emit('focusgrid');
  const cur = () => S.style(S.sel.r, S.sel.c);
  const fn = name => window.Grid?.startEdit ? Grid.startEdit('=' + name + '(') : S.soon('Insert function');
  const SIZES = [6, 7, 8, 9, 10, 11, 12, 14, 18, 24, 36];
  const ZOOMS = [50, 75, 90, 100, 125, 150, 200];
  const FONTS = ['Arial', 'Roboto', 'Calibri', 'Comic Sans MS', 'Courier New', 'Georgia', 'Times New Roman', 'Trebuchet MS', 'Verdana'];
  const FORMATS = [['auto', 'Automatic'], ['text', 'Plain text'], null, ['number', 'Number', '1,000.12'], ['percent', 'Percent', '10.12%'],
    ['scientific', 'Scientific', '1.01E+03'], null, ['currency', 'Currency', '$1,000.12'], null, ['date', 'Date', '9/26/2008'],
    ['time', 'Time', '3:59:00 PM'], ['datetime', 'Date time', '9/26/2008 15:59:00']];
  const HA = { left: 'format_align_left', center: 'format_align_center', right: 'format_align_right' };
  const VA = { top: 'vertical_align_top', middle: 'vertical_align_center', bottom: 'vertical_align_bottom' };
  const WRAP = { overflow: 'format_text_overflow', wrap: 'wrap_text', clip: 'format_text_clip' };
  const PALETTE = [
    '#000000 #434343 #666666 #999999 #b7b7b7 #cccccc #d9d9d9 #efefef #f3f3f3 #ffffff',
    '#980000 #ff0000 #ff9900 #ffff00 #00ff00 #00ffff #4a86e8 #0000ff #9900ff #ff00ff',
    '#e6b8af #f4cccc #fce5cd #fff2cc #d9ead3 #d0e0e3 #c9daf8 #cfe2f3 #d9d2e9 #ead1dc',
    '#dd7e6b #ea9999 #f9cb9c #ffe599 #b6d7a8 #a2c4c9 #a4c2f4 #9fc5e8 #b4a7d6 #d5a6bd',
    '#cc4125 #e06666 #f6b26b #ffd966 #93c47d #76a5af #6d9eeb #6fa8dc #8e7cc3 #c27ba0',
    '#a61c00 #cc0000 #e69138 #f1c232 #6aa84f #45818e #3c78d8 #3d85c6 #674ea7 #a64d79',
    '#85200c #990000 #b45f06 #bf9000 #38761d #134f5c #1155cc #0b5394 #351c75 #741b47',
    '#5b0f00 #660000 #783f04 #7f6000 #274e13 #0c343d #1c4587 #073763 #20124d #4c1130'].map(r => r.split(' '));
  const els = {}, lastColor = { color: '#000000', bg: '#ffff00' };
  let stat = 'Sum', paint = null, menubarOpen = null, saveTimer;

  // ---------- dropdown helpers ----------
  // Menu (list) dropdown under an anchor; clicking the anchor again closes it.
  function drop(anchor, items, cls = '', up = false) {
    if (Menu.isOpen && Menu.opts?.anchor === anchor) return Menu.close();
    closePop();
    const b = anchor.getBoundingClientRect();
    Menu.open(typeof items === 'function' ? items() : items, b.left, b.bottom + (cls ? 0 : 2), { anchor, className: cls });
    const m = Menu.stack[0]; if (up && m) m.style.top = Math.max(4, b.top - m.offsetHeight - 2) + 'px';   // sheet bar menus open upwards
  }
  // Custom popup card (palette, borders, alignment) styled like .ms-menu.
  let pop = null;
  function popup(anchor, el) {
    if (pop?.anchor === anchor) return closePop();
    closePop(); Menu.close();
    el.classList.add('ms-menu', 'tb-pop'); document.body.appendChild(el);
    const b = anchor.getBoundingClientRect();
    el.style.left = Math.max(4, Math.min(b.left, innerWidth - el.offsetWidth - 4)) + 'px'; el.style.top = b.bottom + 2 + 'px';
    anchor.classList.add('ms-open');
    pop = { el, anchor,
      out: e => { if (!el.contains(e.target) && !anchor.contains(e.target)) closePop(); },
      key: e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePop(); focusGrid(); } } };
    setTimeout(() => { document.addEventListener('mousedown', pop?.out); document.addEventListener('keydown', pop?.key, true); });
  }
  function closePop() {
    if (!pop) return;
    pop.el.remove(); pop.anchor.classList.remove('ms-open');
    document.removeEventListener('mousedown', pop.out); document.removeEventListener('keydown', pop.key, true); pop = null;
  }
  const done = () => { closePop(); focusGrid(); };
  // A popup made of icon buttons: rows = [[icon, title, fn, active?], ...]
  function iconPopup(anchor, rows) {
    const el = h('div', 'tb-iconpop');
    rows.forEach(row => { const r = el.appendChild(h('div', 'tb-iconrow'));
      row.forEach(([ic, tip, act, on]) => { const b = r.appendChild(h('div', 'tb-btn' + (on ? ' tb-on' : ''), icon(ic)));
        b.title = tip; b.onmousedown = noFocus; b.onclick = () => { act(); done(); }; }); });
    popup(anchor, el);
  }

  // ---------- menus (functions, so labels/checks are current) ----------
  const soon = (label, ic, shortcut) => ({ label, icon: ic, shortcut, soon: true });
  const fmtNow = () => cur().fmt || 'auto';
  const numberItems = () => FORMATS.map(f => f ? { label: f[1], shortcut: f[2] || '', checked: fmtNow() === f[0], cmd: 'format', arg: f[0] } : { sep: true })
    .concat({ sep: true }, soon('Custom currency'), soon('Custom date and time'), soon('Custom number format'));
  const zoomItems = () => ZOOMS.map(z => ({ label: z + '%', checked: (S.meta.zoom || 100) === z, action: () => setMeta({ zoom: z }) }));
  const sizeItems = () => SIZES.map(z => ({ label: String(z), checked: (cur().size || 10) === z, action: () => S.styleSel({ size: z }) }));
  const choice = (key, map, labels, def) => Object.keys(map).map((v, i) => ({ label: labels[i], icon: map[v], checked: (cur()[key] || def) === v,
    action: () => S.styleSel({ [key]: v === def ? null : v }) }));
  const FUNCS = ['SUM', 'AVERAGE', 'COUNT', 'MAX', 'MIN'], MORE = ['IF', 'COUNTIF', 'SUMIF', 'VLOOKUP', 'CONCAT', 'ROUND', 'ABS', 'TODAY'];
  const funcItems = () => {
    const items = FUNCS.map(n => ({ label: n, action: () => fn(n) })).concat({ sep: true }, MORE.map(n => ({ label: n, action: () => fn(n) })));
    const all = window.Formula?.FUNCS;
    if (Array.isArray(all) && all.length) items.push({ sep: true }, { label: 'All functions', items: [...all].sort((a, b) => a.name.localeCompare(b.name))
      .map(f => ({ label: f.name, shortcut: '', action: () => fn(f.name) })) });
    return items.concat({ sep: true }, soon('Learn more'));
  };
  const count = () => ({ r: S.sel.r2 - S.sel.r1 + 1, c: S.sel.c2 - S.sel.c1 + 1 });
  const plural = (n, w) => n === 1 ? w : `${n} ${w.toLowerCase().replace(/^(row|column)/, '$1s')}`;
  const MENUS = {
    File: () => [{ label: 'New', icon: 'add_box', cmd: 'new' }, soon('Open', 'folder_open', sc('mod+O')), soon('Import', 'upload'), soon('Make a copy', 'file_copy'), { sep: true },
      soon('Share', 'person_add'), soon('Email', 'mail'), { label: 'Download', icon: 'download', items: [{ label: 'Comma-separated values (.csv)', cmd: 'downloadCSV' }] }, { sep: true },
      { label: 'Rename', icon: 'drive_file_rename_outline', action: rename }, soon('Version history', 'history'), { sep: true },
      soon('Settings', 'settings'), { label: 'Print', icon: 'print', shortcut: sc('mod+P'), action: () => window.print() }],
    Edit: () => [{ label: 'Undo', icon: 'undo', shortcut: sc('mod+Z'), cmd: 'undo', disabled: !S._undo.length },
      { label: 'Redo', icon: 'redo', shortcut: sc('mod+shift+Z'), cmd: 'redo', disabled: !S._redo.length }, { sep: true },
      { label: 'Cut', icon: 'content_cut', shortcut: sc('mod+X'), cmd: 'cut' }, { label: 'Copy', icon: 'content_copy', shortcut: sc('mod+C'), cmd: 'copy' },
      { label: 'Paste', icon: 'content_paste', shortcut: sc('mod+V'), cmd: 'paste' }, { sep: true },
      { label: 'Delete values', icon: 'backspace', cmd: 'clear' }, { label: 'Delete ' + plural(count().r, 'Row'), icon: 'delete', cmd: 'deleteRows' },
      { label: 'Delete ' + plural(count().c, 'Column'), icon: 'delete', cmd: 'deleteCols' }, { sep: true }, soon('Find and replace', 'find_replace', sc('mod+shift+H'))],
    View: () => [{ label: 'Show', icon: 'visibility', items: [soon('Gridlines'), soon('Formula bar')] },
      { label: 'Freeze', icon: 'view_column', items: [soon('No rows'), soon('1 row'), soon('2 rows'), { sep: true }, soon('No columns'), soon('1 column')] }, { sep: true },
      { label: 'Zoom', icon: 'zoom_in', items: zoomItems() }, { label: 'Full screen', icon: 'fullscreen', checked: !!document.fullscreenElement, action: fullscreen }],
    Insert: () => [{ label: plural(count().r, 'Row') + ' above', icon: 'add', cmd: 'insertRowAbove' }, { label: plural(count().r, 'Row') + ' below', icon: 'add', cmd: 'insertRowBelow' },
      { label: plural(count().c, 'Column') + ' left', icon: 'add', cmd: 'insertColLeft' }, { label: plural(count().c, 'Column') + ' right', icon: 'add', cmd: 'insertColRight' }, { sep: true },
      soon('Chart', 'insert_chart'), soon('Image', 'image'), soon('Checkbox', 'check_box'), { label: 'Function', icon: 'functions', items: funcItems() }, { sep: true },
      soon('Link', 'link', sc('mod+K')), soon('Comment', 'add_comment', sc('mod+alt+M'))],
    Format: () => [soon('Theme', 'palette'), { sep: true }, { label: 'Number', icon: 'tag', items: numberItems() },
      { label: 'Text', icon: 'format_bold', items: [{ label: 'Bold', icon: 'format_bold', checked: !!cur().b, shortcut: sc('mod+B'), cmd: 'bold' },
        { label: 'Italic', icon: 'format_italic', checked: !!cur().i, shortcut: sc('mod+I'), cmd: 'italic' },
        { label: 'Strikethrough', icon: 'strikethrough_s', checked: !!cur().st, shortcut: sc('mod+shift+X'), cmd: 'strike' }] },
      { label: 'Alignment', icon: 'format_align_left', items: [...choice('ha', HA, ['Left', 'Center', 'Right'], ''), { sep: true }, ...choice('va', VA, ['Top', 'Middle', 'Bottom'], 'bottom')] },
      { label: 'Wrapping', icon: 'wrap_text', items: choice('wrap', WRAP, ['Overflow', 'Wrap', 'Clip'], 'overflow') },
      soon('Rotation', 'text_rotation_none'), { sep: true }, { label: 'Font size', icon: 'format_size', items: sizeItems() }, soon('Merge cells', 'cell_merge'), { sep: true },
      soon('Conditional formatting', 'format_paint'), soon('Alternating colors', 'opacity'), { sep: true },
      { label: 'Clear formatting', icon: 'format_clear', shortcut: sc('mod+\\'), cmd: 'clearFormat' }],
    Data: () => [{ label: 'Sort sheet A → Z', icon: 'sort_by_alpha', cmd: 'sortAZ' }, { label: 'Sort sheet Z → A', icon: 'sort_by_alpha', cmd: 'sortZA' }, { sep: true },
      soon('Create a filter', 'filter_alt'), soon('Filter views', 'filter_list'), soon('Data validation', 'rule'), soon('Named ranges', 'bookmark'), { sep: true },
      soon('Data cleanup', 'cleaning_services'), soon('Split text to columns', 'vertical_split')],
    Tools: () => [soon('Create a new form', 'list_alt'), soon('Spelling', 'spellcheck'), soon('Suggestion controls', 'tips_and_updates'), { sep: true },
      soon('Notification settings', 'notifications'), soon('Accessibility', 'accessibility_new')],
    Help: () => [soon('Help', 'help'), soon('Training', 'school'), soon('Updates', 'new_releases'), { sep: true },
      { label: 'Keyboard shortcuts', icon: 'keyboard', shortcut: sc('mod+/'), action: shortcuts }, { label: 'About MathSheets', icon: 'info', action: () => S.toast('MathSheets — a spreadsheet in plain HTML, CSS and JavaScript') }],
  };

  // ---------- actions ----------
  function setMeta(p) { Object.assign(S.meta, p); S.emit('meta'); }
  function rename() { els.title.focus(); els.title.select(); }
  function fullscreen() { document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.().catch(() => S.toast('Full screen is not available')); }
  function toggleFmt(f) { S.run('format', fmtNow() === f ? 'auto' : f); }
  function decimals(d) {
    const s = cur(), shown = (/\.(\d+)/.exec(S.display(S.sel.r, S.sel.c).text.replace(/E.*$/, '')) || ['', ''])[1].length;
    S.styleSel({ dec: Math.max(0, Math.min(10, (s.dec ?? shown) + d)) });
  }
  function stepSize(d) {
    const z = cur().size || 10, next = d > 0 ? SIZES.find(x => x > z) : [...SIZES].reverse().find(x => x < z);
    if (next) S.styleSel({ size: next });
  }
  function borders(mode) {
    const s = S.sel;
    S.transact(() => S.forSel((r, c) => {
      const t = r === s.r1, b = r === s.r2, l = c === s.c1, ri = c === s.c2, p = {};
      const set = (k, on) => { if (on) p[k] = true; };
      if (mode === 'none') Object.assign(p, { bt: null, bb: null, bl: null, br: null });
      if (mode === 'all') Object.assign(p, { bt: true, bb: true, bl: true, br: true });
      if (mode === 'inner' || mode === 'horizontal') { set('bt', !t); set('bb', !b); }
      if (mode === 'inner' || mode === 'vertical') { set('bl', !l); set('br', !ri); }
      if (mode === 'outer' || mode === 'top') set('bt', t);
      if (mode === 'outer' || mode === 'bottom') set('bb', b);
      if (mode === 'outer' || mode === 'left') set('bl', l);
      if (mode === 'outer' || mode === 'right') set('br', ri);
      if (Object.keys(p).length) S.setStyle(r, c, p);
    }));
  }
  function palette(anchor, key) {
    const now = cur()[key], el = h('div', 'tb-palette');
    el.innerHTML = `<div class="tb-pal-reset" data-c="">${icon('format_color_reset')}Reset</div>` +
      PALETTE.map(row => `<div class="tb-pal-row">${row.map(c => `<i data-c="${c}" title="${c}" style="background:${c}"${c === now ? ' class="tb-cur"' : ''}></i>`).join('')}</div>`).join('') +
      `<div class="tb-pal-custom">CUSTOM<label title="Custom color">${icon('add')}<input type="color" value="${now || lastColor[key]}"></label></div>`;
    const apply = c => { if (c) { lastColor[key] = c; } S.styleSel({ [key]: c || null }); sync(); };
    el.onmousedown = e => { if (e.target.tagName !== 'INPUT' && !e.target.closest('label')) e.preventDefault(); };
    el.onclick = e => { const t = e.target.closest('[data-c]'); if (t) { apply(t.dataset.c); done(); } };
    el.querySelector('input').onchange = e => { apply(e.target.value); done(); };
    popup(anchor, el);
  }
  function paintFormat() {
    if (paint) return endPaint();
    paint = { ...cur() }; els.paint.classList.add('tb-on');
    document.addEventListener('keydown', paint.key = e => { if (e.key === 'Escape') { e.stopPropagation(); endPaint(); } }, true);
  }
  function endPaint() { if (!paint) return; document.removeEventListener('keydown', paint.key, true); paint = null; els.paint.classList.remove('tb-on'); }
  function onSelectPaint() {
    if (!paint || paint.waiting) return;
    paint.waiting = true;
    document.addEventListener('mouseup', () => {
      const st = paint; if (!st) return; delete st.waiting; delete st.key; const s = { ...st };
      S.transact(() => S.forSel((r, c) => S.setCell(r, c, { raw: S.raw(r, c), s: Object.keys(s).length ? s : undefined })));
      endPaint(); focusGrid();
    }, { once: true });
  }
  function shortcuts() {
    const rows = [['Undo', 'mod+Z'], ['Redo', 'mod+shift+Z'], ['Cut', 'mod+X'], ['Copy', 'mod+C'], ['Paste', 'mod+V'], ['Bold', 'mod+B'], ['Italic', 'mod+I'],
      ['Strikethrough', 'mod+shift+X'], ['Clear formatting', 'mod+\\'], ['Select all', 'mod+A'], ['Edit cell', 'Enter / F2'], ['Delete values', 'Delete']];
    const bg = h('div', 'tb-dialog-bg', `<div class="tb-dialog"><div class="tb-dialog-head">Keyboard shortcuts<span class="tb-btn tb-round" title="Close">${icon('close')}</span></div>` +
      `<table>${rows.map(([a, k]) => `<tr><td>${a}</td><td>${sc(k)}</td></tr>`).join('')}</table></div>`);
    const close = () => { bg.remove(); document.removeEventListener('keydown', key, true); focusGrid(); };
    const key = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    bg.onclick = e => { if (e.target === bg || e.target.closest('.tb-round')) close(); };
    document.addEventListener('keydown', key, true); document.body.appendChild(bg);
  }

  // ---------- title bar ----------
  const LOGO = `<svg class="tb-logo" viewBox="0 0 32 32" width="32" height="32" aria-label="MathSheets"><rect width="32" height="32" rx="8" fill="#4f46e5"/>` +
    `<path d="M10 8.5h12v3.2H15l4.6 4.3-4.6 4.3h7v3.2H10v-2.6l5.4-4.9L10 11.1z" fill="#fff"/></svg>`;
  function buildTitlebar() {
    const tb = document.getElementById('titlebar');
    tb.innerHTML = LOGO + `<div class="tb-titlerow"><input class="tb-title" spellcheck="false" aria-label="Rename"><span class="tb-badges"></span></div>` +
      `<div class="tb-menubar"></div><div class="tb-right"></div>`;
    const t = els.title = tb.querySelector('.tb-title');
    t.title = 'Rename';
    t.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') { t.blur(); } if (e.key === 'Escape') { t.value = S.meta.title; t.blur(); } };
    t.oninput = fitTitle;
    t.onblur = () => { const v = t.value.trim() || 'Untitled spreadsheet'; if (v !== S.meta.title) setMeta({ title: v }); else syncTitle(); focusGrid(); };
    const badges = tb.querySelector('.tb-badges');
    els.star = badges.appendChild(round('star', 'Star', () => { setMeta({ starred: !S.meta.starred }); S.toast(S.meta.starred ? 'Starred' : 'Removed from Starred'); }));
    els.cloud = badges.appendChild(round('cloud_done', 'Saved to this browser', () => S.toast(els.cloud.title)));
    const mb = tb.querySelector('.tb-menubar');
    for (const name in MENUS) {
      const m = mb.appendChild(h('div', 'tb-mitem', name));
      const open = () => { drop(m, MENUS[name], 'tb-dropmenu'); menubarOpen = Menu.isOpen ? m : null; if (Menu.opts) Menu.opts.onClose = () => { menubarOpen = null; }; };
      m.onmousedown = e => { e.preventDefault(); open(); };
      m.onmouseenter = () => { if (menubarOpen && menubarOpen !== m) open(); };
    }
    const right = tb.querySelector('.tb-right');
    right.append(round('history', 'Last edit / version history', () => S.soon('Version history'), 'tb-r40'),
      round('comment', 'Open comment history', () => S.soon('Comments'), 'tb-r40'));
    const share = right.appendChild(h('div', 'tb-share', icon('lock') + 'Share'));
    share.title = 'Private to only me'; share.onmousedown = noFocus; share.onclick = () => S.soon('Share');
    const av = right.appendChild(h('div', 'tb-avatar', 'M')); av.title = 'MathSheets account'; av.onclick = () => S.soon('Account');
  }
  function round(ic, tip, act, cls = '') { const b = h('div', 'tb-btn tb-round ' + cls, icon(ic)); b.title = tip; b.onmousedown = noFocus; b.onclick = act; return b; }
  function fitTitle() {
    const c = fitTitle.c || (fitTitle.c = document.createElement('canvas').getContext('2d'));
    c.font = '18px Roboto, Arial, sans-serif';
    els.title.style.width = Math.ceil(c.measureText(els.title.value || ' ').width) + 16 + 'px';
  }
  function syncTitle() {
    if (document.activeElement !== els.title) els.title.value = S.meta.title;
    document.title = S.meta.title + ' - MathSheets'; fitTitle();
    els.star.classList.toggle('tb-starred', !!S.meta.starred);
    els.star.title = S.meta.starred ? 'Starred' : 'Star';
  }

  // ---------- toolbar ----------
  function btn(ic, tip, act, opts = {}) {
    const b = h('div', 'tb-btn' + (opts.caret ? ' tb-dd' : ''), (opts.html || icon(ic)) + (opts.caret ? icon('arrow_drop_down', 'tb-caret') : ''));
    b.title = tip + (opts.key ? ` (${sc(opts.key)})` : '');
    b.onmousedown = noFocus;
    b.onclick = () => { act(b); if (!opts.caret && !opts.keep) focusGrid(); };
    return b;
  }
  const cmdBtn = (ic, tip, cmd, key) => btn(ic, tip, () => S.run(cmd), { key });
  const soonBtn = (ic, tip, what = tip, key) => btn(ic, tip, () => S.soon(what), { key });
  function combo(cls, tip, act) {
    const b = h('div', 'tb-btn tb-combo ' + cls, `<span class="tb-combo-label"></span>${icon('arrow_drop_down', 'tb-caret')}`);
    b.title = tip; b.onmousedown = noFocus; b.onclick = () => act(b); return b;
  }
  const colorBtn = (ic, tip, key) => btn(ic, tip, b => palette(b, key), { html: `<span class="tb-colorbtn">${icon(ic)}<i class="tb-bar"></i></span>`, keep: true });
  function buildToolbar() {
    const bar = document.getElementById('toolbar'), sep = () => h('div', 'tb-sep');
    els.undo = cmdBtn('undo', 'Undo', 'undo', 'mod+Z'); els.redo = cmdBtn('redo', 'Redo', 'redo', 'mod+shift+Z');
    els.paint = btn('format_paint', 'Paint format', paintFormat, { keep: true });
    els.zoom = combo('tb-zoom', 'Zoom', b => drop(b, zoomItems));
    els.currency = btn('attach_money', 'Format as currency', () => toggleFmt('currency'));
    els.percent = btn('percent', 'Format as percent', () => toggleFmt('percent'));
    els.font = combo('tb-font', 'Font', b => drop(b, () => [{ label: 'Default (Arial)', checked: !cur().font, action: () => S.styleSel({ font: null }) }, { sep: true },
      ...FONTS.map(f => ({ label: `<span style="font-family:'${f}'">${f}</span>`, checked: cur().font === f, action: () => S.styleSel({ font: f }) }))]));
    els.sizeBox = h('div', 'tb-size', '<input aria-label="Font size">'); els.size = els.sizeBox.firstChild; els.size.title = 'Font size';
    const sz = els.size;
    sz.onfocus = () => { sz.select(); if (!Menu.isOpen) drop(els.sizeBox, sizeItems); };
    sz.onkeydown = e => {
      e.stopPropagation();
      if (e.key === 'Enter') { const v = Math.round(parseFloat(sz.value)); if (v > 0) S.styleSel({ size: Math.min(400, v) }); Menu.close(); sz.blur(); focusGrid(); }
      if (e.key === 'Escape') { Menu.close(); sz.blur(); focusGrid(); }
    };
    sz.onblur = () => sync();
    els.bold = cmdBtn('format_bold', 'Bold', 'bold', 'mod+B'); els.italic = cmdBtn('format_italic', 'Italic', 'italic', 'mod+I');
    els.strike = cmdBtn('strikethrough_s', 'Strikethrough', 'strike', 'mod+shift+X');
    els.color = colorBtn('format_color_text', 'Text color', 'color'); els.bg = colorBtn('format_color_fill', 'Fill color', 'bg');
    const B = m => [`border_${m}`, m[0].toUpperCase() + m.slice(1) + ' borders', () => borders(m)];
    els.borders = btn('border_all', 'Borders', b => iconPopup(b, [['all', 'inner', 'horizontal', 'vertical', 'outer'].map(B),
      [...['left', 'top', 'right', 'bottom'].map(B), ['border_clear', 'Clear borders', () => borders('none')]]]), { keep: true });
    const align = (key, map, def, label) => b => iconPopup(b, [Object.keys(map).map(v => [map[v], label + ' ' + v, () => S.styleSel({ [key]: v === def ? null : v }), (cur()[key] || def) === v])]);
    els.ha = btn('format_align_left', 'Horizontal align', align('ha', HA, '', 'Align'), { caret: true });
    els.va = btn('vertical_align_bottom', 'Vertical align', align('va', VA, 'bottom', 'Align'), { caret: true });
    els.wrap = btn('wrap_text', 'Text wrapping', align('wrap', WRAP, 'overflow', 'Wrapping:'), { caret: true });
    const collapse = btn('keyboard_arrow_up', 'Hide the menus', b => {
      const hide = document.body.classList.toggle('tb-compact');
      b.innerHTML = icon(hide ? 'keyboard_arrow_down' : 'keyboard_arrow_up'); b.title = hide ? 'Show the menus' : 'Hide the menus';
      dispatchEvent(new Event('resize'));
    });
    collapse.classList.add('tb-collapse');
    bar.append(soonBtn('search', 'Search the menus', 'Search the menus', 'alt+/'), sep(),
      els.undo, els.redo, btn('print', 'Print', () => window.print(), { key: 'mod+P' }), els.paint, els.zoom, sep(),
      els.currency, els.percent, btn('decimal_decrease', 'Decrease decimal places', () => decimals(-1)), btn('decimal_increase', 'Increase decimal places', () => decimals(1)),
      combo('tb-123', 'More formats', b => drop(b, numberItems)), sep(), els.font, sep(),
      btn('remove', 'Decrease font size', () => stepSize(-1), { key: 'mod+shift+,' }), els.sizeBox, btn('add', 'Increase font size', () => stepSize(1), { key: 'mod+shift+.' }), sep(),
      els.bold, els.italic, els.strike, els.color, sep(),
      els.bg, els.borders, btn('cell_merge', 'Merge cells', () => S.soon('Merge cells'), { caret: true }), sep(),
      els.ha, els.va, els.wrap, btn('text_rotation_none', 'Text rotation', () => S.soon('Text rotation'), { caret: true }), sep(),
      soonBtn('link', 'Insert link', 'Insert link', 'mod+K'), soonBtn('add_comment', 'Insert comment', 'Insert comment', 'mod+alt+M'), soonBtn('insert_chart', 'Insert chart'),
      soonBtn('filter_alt', 'Create a filter'), btn('functions', 'Functions', b => drop(b, funcItems), { caret: true }),
      h('div', 'tb-spacer'), collapse);
    els.zoom.querySelector('.tb-combo-label').textContent = '100%';
    els.n123 = bar.querySelector('.tb-123 .tb-combo-label'); els.n123.textContent = '123';
  }

  // ---------- sheet bar ----------
  function buildSheetbar() {
    const sb = document.getElementById('sheetbar');
    const tab = h('div', 'tb-tab', `<span>Sheet1</span>${icon('arrow_drop_down', 'tb-caret')}`);
    const tabMenu = () => ['Delete', 'Duplicate', 'Copy to', 'Rename', 'Change color', 'Protect sheet', 'Hide sheet'].map(l => soon(l));
    tab.onmousedown = noFocus;
    tab.querySelector('.tb-caret').onclick = () => drop(tab, tabMenu, '', true);
    tab.oncontextmenu = e => { e.preventDefault(); drop(tab, tabMenu, '', true); };
    els.stat = h('div', 'tb-stat'); els.stat.onmousedown = noFocus;
    els.stat.onclick = () => drop(els.stat, () => Object.entries(stats() || {}).map(([k, v]) => ({ label: `${k}: ${v}`, checked: k === stat, action: () => { stat = k; syncStats(); } })), 'tb-statmenu', true);
    sb.append(round('add', 'Add Sheet', () => S.soon('Add Sheet')), round('menu', 'All Sheets', b => drop(b, [{ label: 'Sheet1', checked: true, action: () => {} }], '', true)),
      tab, h('div', 'tb-spacer'), els.stat);
  }
  function stats() {
    const s = S.sel; if (s.r1 === s.r2 && s.c1 === s.c2) return null;
    const nums = []; let filled = 0, first = null;
    for (let r = s.r1; r <= Math.min(s.r2, s.r1 + 5000); r++) for (let c = s.c1; c <= s.c2; c++) {
      const v = S.value(r, c); if (v === '' || v == null) continue; filled++;
      if (typeof v === 'number' && isFinite(v)) { nums.push(v); first = first || { r, c }; }
    }
    if (!filled) return null;
    if (!nums.length) return { Count: filled };
    const st = S.style(first.r, first.c), fmt = ['currency', 'percent', 'number'].includes(st.fmt || S.valueFmt[S.id(first.r, first.c)]) ? st.fmt || S.valueFmt[S.id(first.r, first.c)] : 'auto';
    const f = v => fmt === 'auto' ? v.toLocaleString('en-US', { maximumFractionDigits: 2 }) : S.formatNumber(v, fmt, st.dec), sum = nums.reduce((a, b) => a + b, 0);
    return { Sum: f(sum), Average: f(sum / nums.length), Min: f(Math.min(...nums)), Max: f(Math.max(...nums)), Count: filled, 'Count numbers': nums.length };
  }
  function syncStats() {
    const st = stats(); els.stat.style.display = st ? '' : 'none'; if (!st) return;
    const k = st[stat] !== undefined ? stat : 'Count';
    els.stat.innerHTML = `${k}: ${st[k]}${icon('arrow_drop_down', 'tb-caret')}`; els.stat.title = 'Explore selection statistics';
  }

  // ---------- state sync ----------
  function sync() {
    const s = cur(), on = (el, v) => el.classList.toggle('tb-on', !!v), fmt = s.fmt || 'auto';
    on(els.bold, s.b); on(els.italic, s.i); on(els.strike, s.st);
    on(els.currency, fmt === 'currency'); on(els.percent, fmt === 'percent');
    els.undo.classList.toggle('tb-disabled', !S._undo.length); els.redo.classList.toggle('tb-disabled', !S._redo.length);
    els.font.querySelector('.tb-combo-label').textContent = s.font || 'Default (Arial)';
    if (document.activeElement !== els.size) els.size.value = s.size || 10;
    els.ha.firstChild.textContent = HA[s.ha || (S.display(S.sel.r, S.sel.c).kind === 'number' ? 'right' : 'left')] || HA.left;
    els.va.firstChild.textContent = VA[s.va || 'bottom']; els.wrap.firstChild.textContent = WRAP[s.wrap || 'overflow'];
    els.color.querySelector('.tb-bar').style.background = lastColor.color; els.bg.querySelector('.tb-bar').style.background = lastColor.bg;
    els.zoom.querySelector('.tb-combo-label').textContent = (S.meta.zoom || 100) + '%';
    syncStats();
  }

  // ---------- toasts ----------
  function toast(text) {
    const box = document.getElementById('toasts'), t = h('div', 'tb-toast'); t.textContent = text;
    while (box.children.length > 2) box.firstChild.remove();
    box.appendChild(t); requestAnimationFrame(() => t.classList.add('tb-show'));
    setTimeout(() => { t.classList.remove('tb-show'); setTimeout(() => t.remove(), 250); }, 3000);
  }

  // ---------- auto-save ----------
  function cloud(state) {
    const [ic, tip] = { ok: ['cloud_done', 'Saved to this browser'], pending: ['cloud_sync', 'Saving…'], off: ['cloud_off', 'Not saved: browser storage is unavailable'] }[state];
    els.cloud.innerHTML = icon(ic); els.cloud.title = tip;
  }
  function queueSave() {
    cloud('pending'); clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { try { localStorage.setItem(STORE, JSON.stringify(S.serialize())); cloud('ok'); } catch (e) { cloud('off'); } }, 300);
  }

  function init() {
    buildTitlebar(); buildToolbar(); buildSheetbar();
    S.on('toast', toast);
    ['select', 'change', 'recalc', 'meta', 'load'].forEach(ev => S.on(ev, sync));
    ['meta', 'load'].forEach(ev => S.on(ev, syncTitle));
    S.on('select', onSelectPaint);
    document.addEventListener('fullscreenchange', () => dispatchEvent(new Event('resize')));
    document.fonts?.ready.then(fitTitle);
    try { const d = localStorage.getItem(STORE); if (d) S.load(JSON.parse(d)); cloud('ok'); } catch (e) { cloud('off'); }
    S.on('change', queueSave); S.on('meta', queueSave);
    syncTitle(); sync();
  }
  return { init };
})();