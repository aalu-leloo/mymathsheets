// MathSheets grid: cells, headers, selection, in-cell editor, name box + formula bar, resize,
// clipboard, fill handle and context menu. Talks to the other parts only through Sheet, Menu and Formula.
const Grid = {
  HW: 46, HH: 24,                  // row-header width, column-header height (px, unzoomed)
  colX: [0], rowY: [0], W: 0, H: 0, zoom: 1,
  ed: null,                        // editing state { r, c, orig, src: 'cell'|'bar', enter }
  pick: null,                      // last reference inserted by clicking while typing a formula
  clip: null,                      // internal clipboard { cells, s, cut, tsv }
  overlay: null,                   // layer for Formula's reference highlights (cell coordinates)
  get isEditing() { return !!this.ed; },
  DIRS: { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] },
  MOD: /Mac|iP/.test(navigator.platform) ? '⌘' : 'Ctrl+',

  init() {
    const fb = document.getElementById('formulabar'), grid = document.getElementById('grid');
    fb.innerHTML = `<div class="g-namebox"><input class="g-name" spellcheck="false" aria-label="Name box">` +
      `<span class="g-name-dd">${icon('arrow_drop_down')}</span></div><div class="g-fbdiv"></div>` +
      `<div class="g-fx">${icon('function')}</div><input class="g-bar" spellcheck="false" aria-label="Formula">`;
    grid.innerHTML = `<div class="g-scroll"><div class="g-content">` +
      `<div class="g-top"><div class="g-corner"></div><div class="g-colhdr"><div class="g-rsz g-rszc"></div></div></div>` +
      `<div class="g-body"><div class="g-rowhdr"><div class="g-rsz g-rszr"></div></div><div class="g-cells"><div class="g-rows"></div>` +
      `<div class="g-sel"><div class="g-fill"></div><div class="g-range"></div><div class="g-ants"></div><div class="g-fillprev"></div>` +
      `<div class="g-active"></div><div class="g-handle"></div></div><div class="g-overlay"></div>` +
      `<input class="g-editor" spellcheck="false" autocomplete="off"></div></div><div class="g-guide"></div></div></div>` +
      `<textarea class="g-sink" aria-label="Grid" tabindex="-1"></textarea>`;
    const q = (root, s) => root.querySelector('.g-' + s);
    Object.assign(this, {
      grid, name: q(fb, 'name'), bar: q(fb, 'bar'), scroll: q(grid, 'scroll'), content: q(grid, 'content'),
      colhdr: q(grid, 'colhdr'), rowhdr: q(grid, 'rowhdr'), cells: q(grid, 'cells'), rowsEl: q(grid, 'rows'),
      editor: q(grid, 'editor'), sink: q(grid, 'sink'), guide: q(grid, 'guide'), overlay: q(grid, 'overlay'),
      rszc: q(grid, 'rszc'), rszr: q(grid, 'rszr'), handle: q(grid, 'handle'),
      sel: Object.fromEntries(['fill', 'range', 'ants', 'fillprev', 'active'].map(k => [k, q(grid, k)])),
      ctx: document.createElement('canvas').getContext('2d'),
    });
    this.bindMouse(); this.bindKeys(); this.bindBar(); this.bindClipboard();
    const S = Sheet;
    S.on('structure', () => this.layout());
    S.on('recalc', () => this.render());
    S.on('select', () => this.onSelect());
    S.on('meta', () => { this.zoom = (S.meta.zoom || 100) / 100; this.content.style.zoom = this.zoom; });
    S.on('load', () => { this.clip = null; this.hideAnts(); if (this.ed) this.end(true); });
    S.on('focusgrid', () => this.focus());
    S.command('copy', () => this.clipCmd('copy'));
    S.command('cut', () => this.clipCmd('cut'));
    S.command('paste', () => this.pasteCmd());
    const F = this.F();
    if (F?.attachEditor) { F.attachEditor(this.editor); F.attachEditor(this.bar); }
    this.layout();
  },
  F() { return typeof Formula !== 'undefined' ? Formula : window.Formula; },   // top-level const is not on window
  focus() { if (!this.ed) this.sink.focus({ preventScroll: true }); },

  // ---------- geometry ----------
  cellRect(r, c) { return { x: this.colX[c], y: this.rowY[r], w: Sheet.width(c), h: Sheet.height(r) }; },
  rangeRect(r1, c1, r2, c2) { return { x: this.colX[c1], y: this.rowY[r1], w: this.colX[c2 + 1] - this.colX[c1], h: this.rowY[r2 + 1] - this.rowY[r1] }; },
  find(arr, v) { let lo = 0, hi = arr.length - 2; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (arr[m] <= v) lo = m; else hi = m - 1; } return lo; },
  local(e) { const b = this.cells.getBoundingClientRect(), z = b.width / this.W; return { x: (e.clientX - b.left) / z, y: (e.clientY - b.top) / z }; },
  hit(e) { const p = this.local(e); return { r: this.find(this.rowY, p.y), c: this.find(this.colX, p.x) }; },
  ensureVisible(r, c) {
    const S = Sheet, sc = this.scroll, z = this.zoom;
    r = Math.max(0, Math.min(S.rows - 1, r)); c = Math.max(0, Math.min(S.cols - 1, c));
    const x1 = this.colX[c] * z, x2 = (this.HW + this.colX[c + 1]) * z, y1 = this.rowY[r] * z, y2 = (this.HH + this.rowY[r + 1]) * z;
    if (x1 < sc.scrollLeft) sc.scrollLeft = x1; else if (x2 > sc.scrollLeft + sc.clientWidth) sc.scrollLeft = x2 - sc.clientWidth;
    if (y1 < sc.scrollTop) sc.scrollTop = y1; else if (y2 > sc.scrollTop + sc.clientHeight) sc.scrollTop = y2 - sc.clientHeight;
  },
  font(s) {
    const fam = s.font ? (/[,'"]/.test(s.font) ? s.font : `"${s.font}"`) + ', Arial, sans-serif' : 'Arial, sans-serif';
    return `${s.i ? 'italic ' : ''}${s.b ? 'bold ' : ''}${s.size || 10}pt ${fam}`;
  },
  box(el, x, y, w, h) {
    if (x === false) { el.style.display = 'none'; return; }
    el.style.cssText = `display:block;left:${x}px;top:${y}px;width:${w}px;height:${h}px`;
  },

  // ---------- layout + rendering ----------
  layout() {
    const S = Sheet; let ch = '', rh = '', rows = '';
    this.colX = [0]; for (let c = 0; c < S.cols; c++) this.colX.push(this.colX[c] + S.width(c));
    this.rowY = [0]; for (let r = 0; r < S.rows; r++) this.rowY.push(this.rowY[r] + S.height(r));
    this.W = this.colX[S.cols]; this.H = this.rowY[S.rows];
    for (let c = 0; c < S.cols; c++) ch += `<div class="g-ch" style="left:${this.colX[c]}px;width:${S.width(c)}px">${S.colName(c)}</div>`;
    const cellsRow = '<div class="g-c"></div>'.repeat(S.cols);
    for (let r = 0; r < S.rows; r++) {
      rh += `<div class="g-rh" style="top:${this.rowY[r]}px;height:${S.height(r)}px">${r + 1}</div>`;
      rows += `<div class="g-row" style="top:${this.rowY[r]}px;height:${S.height(r)}px">${cellsRow}</div>`;
    }
    this.colhdr.querySelectorAll('.g-ch').forEach(e => e.remove()); this.colhdr.insertAdjacentHTML('beforeend', ch);
    this.rowhdr.querySelectorAll('.g-rh').forEach(e => e.remove()); this.rowhdr.insertAdjacentHTML('beforeend', rh);
    this.rowsEl.innerHTML = rows;
    this.chEls = [...this.colhdr.querySelectorAll('.g-ch')]; this.rhEls = [...this.rowhdr.querySelectorAll('.g-rh')];
    this.els = [...this.rowsEl.children].map(row => [...row.children]);
    this.content.style.width = this.HW + this.W + 'px'; this.content.style.height = this.HH + this.H + 'px';
    this.colhdr.style.width = this.cells.style.width = this.W + 'px';
    this.rowhdr.style.height = this.cells.style.height = this.H + 'px';
    this.render(); this.onSelect(); if (this.antsOn) this.showAnts();
  },
  cellCss(s, align) {
    let css = '';
    if (s.b) css += 'font-weight:bold;'; if (s.i) css += 'font-style:italic;'; if (s.st) css += 'text-decoration:line-through;';
    if (s.color) css += `color:${s.color};`; if (s.font || s.size) css += `font:${this.font(s)};`;
    if (align !== 'left') css += `justify-content:${align === 'center' ? 'center' : 'flex-end'};text-align:${align};`;
    if (s.va === 'top' || s.va === 'middle') css += `align-items:${s.va === 'top' ? 'flex-start' : 'center'};`;
    if (s.wrap === 'wrap') css += 'white-space:pre-wrap;overflow-wrap:anywhere;';
    if (s.bb) css += 'border-bottom-color:#000;'; if (s.br) css += 'border-right-color:#000;';
    const sh = [s.bt && '0 -1px #000', s.bl && '-1px 0 #000'].filter(Boolean);
    if (sh.length) css += `box-shadow:${sh.join(',')};`;
    return css;
  },
  render() {
    const S = Sheet, ctx = this.ctx;
    for (let r = 0; r < S.rows; r++) {
      const row = this.els[r]; if (!row) continue;
      const ds = []; for (let c = 0; c < S.cols; c++) ds.push(S.display(r, c));
      let coverTo = -1;
      for (let c = 0; c < S.cols; c++) {
        const el = row[c], d = ds[c], s = S.style(r, c), w = S.width(c), align = s.ha || d.align;
        let cls = 'g-c', css = `left:${this.colX[c]}px;`, width = w;
        if (c <= coverTo) cls += ' g-cov';
        // Google-style overflow: unwrapped left-aligned text spills into empty neighbours on the right
        if (d.kind === 'text' && align === 'left' && !s.wrap && !s.br && ds[c + 1]?.kind === 'empty') {
          ctx.font = this.font(s);
          const need = ctx.measureText(d.text).width + 6;
          for (let k = c + 1; width < need && k < S.cols && ds[k].kind === 'empty' && !S.style(r, k).bg; k++) { width += S.width(k); coverTo = k; }
        }
        if (s.bg) css += width > w ? `background:linear-gradient(${s.bg},${s.bg}) 0 0/${w - 1}px 100% no-repeat;` : `background:${s.bg};`;
        if (d.kind === 'error') cls += ' g-err';
        css += `width:${width}px;` + this.cellCss(s, align);
        const key = cls + css + d.text;
        if (el._k === key) continue;
        el._k = key; el.className = cls; el.style.cssText = css; el.textContent = d.text;
        if (d.kind === 'error' || el.title) el.title = d.kind === 'error' ? 'Error: ' + d.text : '';
      }
    }
    if (this.ed) this.placeEditor();
    if (!this.ed && this.bar) this.bar.value = S.raw(S.sel.r, S.sel.c);
  },

  // ---------- selection ----------
  onSelect() {
    const S = Sheet, s = S.sel;
    if (this.ed && (this.ed.r !== s.r || this.ed.c !== s.c)) this.commit(0, 0, true);
    this.drawSel(); this.headers();
    if (document.activeElement !== this.name) this.name.value = S.rangeName();
    if (!this.ed) this.bar.value = S.raw(s.r, s.c);
  },
  drawSel() {
    const s = Sheet.sel, R = this.rangeRect(s.r1, s.c1, s.r2, s.c2), A = this.cellRect(s.r, s.c), multi = s.r1 !== s.r2 || s.c1 !== s.c2;
    this.box(this.sel.active, A.x - 1, A.y - 1, A.w + 1, A.h + 1);
    this.box(this.sel.range, multi && R.x - 1, R.y - 1, R.w + 1, R.h + 1);
    this.box(this.sel.fill, multi && R.x, R.y, R.w, R.h);
    if (multi) {
      const ax = A.x - R.x, ay = A.y - R.y;
      this.sel.fill.style.clipPath = `path(evenodd,"M0 0H${R.w}V${R.h}H0Z M${ax} ${ay}H${ax + A.w}V${ay + A.h}H${ax}Z")`;
    }
    this.box(this.handle, R.x + R.w - 5, R.y + R.h - 5, 8, 8);
  },
  headers() {
    const S = Sheet, s = S.sel, fullC = s.r1 === 0 && s.r2 === S.rows - 1, fullR = s.c1 === 0 && s.c2 === S.cols - 1;
    const set = (els, a, b, full, base) => els.forEach((el, i) => {
      const cls = i >= a && i <= b ? base + (full ? ' g-full' : ' g-hl') : base;
      if (el.className !== cls) el.className = cls;
    });
    set(this.chEls, s.c1, s.c2, fullC, 'g-ch'); set(this.rhEls, s.r1, s.r2, fullR, 'g-rh');
  },
  go(r, c) { Sheet.select(r, c); this.ensureVisible(r, c); },
  move([dr, dc], extend, jump) {
    const S = Sheet, s = S.sel;
    let fr = extend ? (s.r === s.r1 ? s.r2 : s.r1) : s.r, fc = extend ? (s.c === s.c1 ? s.c2 : s.c1) : s.c;
    [fr, fc] = jump ? this.edge(fr, fc, dr, dc) : [fr + dr, fc + dc];
    if (extend) S.select(s.r, s.c, fr, fc); else S.select(fr, fc);
    this.ensureVisible(fr, fc);
  },
  edge(r, c, dr, dc) {   // ⌘+arrow: jump to the edge of the current data block (or the next one)
    const S = Sheet, has = (r, c) => S.raw(r, c) !== '', inb = (r, c) => r >= 0 && c >= 0 && r < S.rows && c < S.cols;
    let nr = r + dr, nc = c + dc;
    if (!inb(nr, nc)) return [r, c];
    if (has(r, c) && has(nr, nc)) { while (inb(nr + dr, nc + dc) && has(nr + dr, nc + dc)) { nr += dr; nc += dc; } return [nr, nc]; }
    while (!has(nr, nc) && inb(nr + dr, nc + dc)) { nr += dr; nc += dc; }
    return [nr, nc];
  },

  // ---------- mouse ----------
  drag(move, up, auto = { x: true, y: true }) {
    let last = null;
    const mv = e => { last = e; move(e); };
    const tick = setInterval(() => {
      if (!last) return;
      const b = this.scroll.getBoundingClientRect(), z = this.zoom, x = last.clientX, y = last.clientY;
      const dx = !auto.x ? 0 : x < b.left + this.HW * z ? -24 : x > b.right - 12 ? 24 : 0;
      const dy = !auto.y ? 0 : y < b.top + this.HH * z ? -24 : y > b.bottom - 12 ? 24 : 0;
      if (dx || dy) { this.scroll.scrollLeft += dx; this.scroll.scrollTop += dy; move(last); }
    }, 40);
    const end = e => { clearInterval(tick); removeEventListener('mousemove', mv); removeEventListener('mouseup', end); up && up(e); };
    addEventListener('mousemove', mv); addEventListener('mouseup', end);
  },
  bindMouse() {
    const S = Sheet;
    this.cells.addEventListener('mousedown', e => this.cellDown(e));
    this.cells.addEventListener('dblclick', e => {
      if (e.target === this.handle) return this.autoFill();
      if (!this.ed && e.target !== this.editor) { const h = this.hit(e); if (h.r === S.sel.r && h.c === S.sel.c) this.startEdit(); }
    });
    this.cells.addEventListener('contextmenu', e => { if (e.target !== this.editor) this.ctxMenu(e, 'cell'); });
    this.scroll.addEventListener('mousedown', e => { if (e.target === this.scroll || e.target === this.content) { if (this.ed) this.commit(0, 0); this.focus(); } });
    this.grid.querySelector('.g-corner').addEventListener('mousedown', e => { e.preventDefault(); if (this.ed) this.commit(0, 0); this.focus(); S.run('selectAll'); });
    for (const [el, axis] of [[this.colhdr, 'col'], [this.rowhdr, 'row']]) {
      const col = axis === 'col', rsz = col ? this.rszc : this.rszr;
      el.addEventListener('mousedown', e => this.hdrDown(e, axis));
      el.addEventListener('contextmenu', e => this.ctxMenu(e, axis));
      el.addEventListener('mousemove', e => {
        if (e.buttons) return;
        const i = this.zone(e, axis), arr = col ? this.colX : this.rowY;
        el.style.cursor = i == null ? '' : col ? 'col-resize' : 'row-resize';
        if (i == null) rsz.style.display = 'none';
        else rsz.style.cssText = `display:block;${col ? 'left' : 'top'}:${arr[i + 1] - 3}px`;
      });
      el.addEventListener('mouseleave', () => { if (!this.resizing) rsz.style.display = 'none'; });
      el.addEventListener('dblclick', e => {
        const i = this.zone(e, axis); if (i == null) return;
        if (col) this.autoFit(i); else this.setSizes('row', i, S.DEFAULT_H);
      });
    }
  },
  cellDown(e) {
    const S = Sheet;
    if (e.target === this.editor) { if (this.ed) this.ed.src = 'cell'; return; }
    if (e.target === this.handle) return this.fillDrag(e);
    if (e.button !== 0) { if (!this.ed) { e.preventDefault(); this.focus(); } return; }
    e.preventDefault();
    if (this.ed && this.canPick()) {   // formula reference picking
      const a = this.hit(e); this.insertRef(a.r, a.c, a.r, a.c);
      this.drag(ev => { const b = this.hit(ev); this.insertRef(Math.min(a.r, b.r), Math.min(a.c, b.c), Math.max(a.r, b.r), Math.max(a.c, b.c)); });
      return;
    }
    if (this.ed) this.commit(0, 0);
    this.focus();
    const a = this.hit(e), s = S.sel;
    if (e.shiftKey) S.select(s.r, s.c, a.r, a.c); else S.select(a.r, a.c);
    const r0 = S.sel.r, c0 = S.sel.c; let lr = a.r, lc = a.c;
    this.drag(ev => { const b = this.hit(ev); if (b.r !== lr || b.c !== lc) { lr = b.r; lc = b.c; S.select(r0, c0, b.r, b.c); } });
  },
  zone(e, axis) {   // index of the column/row whose far edge is under the mouse (resize hot zone), or null
    const col = axis === 'col', p = this.local(e), v = col ? p.x : p.y, arr = col ? this.colX : this.rowY, i = this.find(arr, v), tol = col ? 4 : 3;
    if (arr[i + 1] - v <= tol) return i;
    if (v - arr[i] <= tol && i > 0) return i - 1;
    return null;
  },
  hdrDown(e, axis) {
    if (e.button !== 0) { e.preventDefault(); return; }
    e.preventDefault();
    if (this.ed) this.commit(0, 0);
    const z = this.zone(e, axis); if (z != null) return this.resizeDrag(e, axis, z);
    this.focus();
    const S = Sheet, col = axis === 'col', idx = ev => col ? this.hit(ev).c : this.hit(ev).r;
    const sel = (a, b) => col ? S.select(0, a, S.rows - 1, b) : S.select(a, 0, b, S.cols - 1);
    const i = idx(e), a = e.shiftKey ? (col ? S.sel.c : S.sel.r) : i;
    sel(a, i);
    this.drag(ev => sel(a, idx(ev)), null, { x: col, y: !col });
  },
  resizeDrag(e, axis, i) {
    const col = axis === 'col', arr = col ? this.colX : this.rowY, g = this.guide, start = arr[i], old = arr[i + 1] - start;
    const p0 = col ? this.local(e).x : this.local(e).y;
    let size = old; this.resizing = true;
    const place = () => g.style.cssText = col ? `display:block;left:${this.HW + start + size - 2}px;top:0;bottom:0;width:2px`
      : `display:block;top:${this.HH + start + size - 2}px;left:0;right:0;height:2px`;
    place();
    this.drag(ev => { const p = this.local(ev); size = Math.max(col ? 20 : 15, old + (col ? p.x : p.y) - p0); place(); },
      () => { g.style.display = 'none'; this.resizing = false; this.rszc.style.display = this.rszr.style.display = 'none'; if (Math.round(size) !== old) this.setSizes(axis, i, size); },
      { x: false, y: false });
  },
  setSizes(axis, i, px) {   // resizing one of several fully selected columns/rows resizes them all (like Google)
    const S = Sheet, s = S.sel, col = axis === 'col';
    const full = col ? s.r1 === 0 && s.r2 === S.rows - 1 && i >= s.c1 && i <= s.c2 : s.c1 === 0 && s.c2 === S.cols - 1 && i >= s.r1 && i <= s.r2;
    S.transact(() => { if (full) for (let k = col ? s.c1 : s.r1; k <= (col ? s.c2 : s.r2); k++) S.setSize(axis, k, px); else S.setSize(axis, i, px); });
  },
  autoFit(c) {
    let m = 0;
    for (let r = 0; r < Sheet.rows; r++) { const d = Sheet.display(r, c); if (d.text) { this.ctx.font = this.font(Sheet.style(r, c)); m = Math.max(m, this.ctx.measureText(d.text).width); } }
    this.setSizes('col', c, m ? Math.ceil(m) + 10 : Sheet.DEFAULT_W);
  },

  // ---------- editing ----------
  startEdit(text, src = 'cell', enter = false) {
    const S = Sheet, { r, c } = S.sel;
    if (!this.ed) this.ed = { r, c, orig: S.raw(r, c) };
    Object.assign(this.ed, { src, enter });
    this.hideAnts();
    const v = text === undefined ? this.ed.orig : String(text), inp = src === 'bar' ? this.bar : this.editor;
    this.editor.value = this.bar.value = v;
    this.ensureVisible(r, c); this.placeEditor();
    inp.focus({ preventScroll: true }); inp.setSelectionRange(v.length, v.length);
    this.emitEd();
    if (text !== undefined) inp.dispatchEvent(new Event('input', { bubbles: true }));   // let autocomplete react
  },
  beginBar() {
    const S = Sheet, { r, c } = S.sel;
    this.ed = { r, c, orig: S.raw(r, c), src: 'bar', enter: false };
    this.editor.value = this.bar.value; this.hideAnts(); this.placeEditor(); this.emitEd();
  },
  placeEditor() {
    const ed = this.ed, s = Sheet.style(ed.r, ed.c), A = this.cellRect(ed.r, ed.c), font = this.font(s);
    this.ctx.font = font;
    const w = Math.max(A.w + 1, Math.min(this.ctx.measureText(this.editor.value).width + 24, this.W - A.x + 1));
    const h = Math.max(A.h + 1, Math.ceil((s.size || 10) * 4 / 3 * 1.2) + 6);
    this.cells.classList.add('g-editing');
    this.editor.style.cssText = `display:block;left:${A.x - 1}px;top:${A.y - 1}px;width:${w}px;height:${h}px;font:${font};` +
      `color:${s.color || '#000'};${s.st ? 'text-decoration:line-through;' : ''}`;
  },
  emitEd() { Sheet.emit('editing', { text: this.editor.value, source: this.ed.src }); },
  commit(dr = 0, dc = 0, keepFocus) {
    const ed = this.ed; if (!ed) return;
    const v = this.editor.value;
    this.end(keepFocus);
    if (v !== ed.orig) Sheet.setRaw(ed.r, ed.c, v);
    // Like Sheets: Enter after a run of Tabs returns to the column where the run started
    const t = this.tabRun, inRun = t && t.r === ed.r && t.c === ed.c;
    if (dc) this.tabRun = { r: ed.r, c: ed.c + dc, start: inRun ? t.start : ed.c };
    else { this.tabRun = null; if (dr === 1 && inRun) return this.go(ed.r + 1, t.start); }
    if (dr || dc) this.go(ed.r + dr, ed.c + dc);
  },
  cancel() { this.end(); },
  end(keepFocus) {
    this.ed = null; this.pick = null; this.editor.style.display = 'none'; this.cells.classList.remove('g-editing');
    Sheet.emit('editing', null);
    this.bar.value = Sheet.raw(Sheet.sel.r, Sheet.sel.c);
    if (!keepFocus || document.activeElement === this.editor) this.focus();
  },
  edInput(inp) {   // the in-cell editor and the formula bar mirror each other while typing
    const other = inp === this.bar ? this.editor : this.bar;
    other.value = inp.value; this.placeEditor();
    if (!this._picking) this.pick = null;
    this.emitEd();
  },
  edKey(e, inp) {
    if (e.defaultPrevented || e.isComposing || !this.ed) return;
    const k = e.key, mod = e.metaKey || e.ctrlKey;
    if (k === 'Enter' && !e.altKey) { e.preventDefault(); if (inp === this.bar) this.commit(0, 0); else this.commit(e.shiftKey ? -1 : 1, 0); }
    else if (k === 'Tab') { e.preventDefault(); this.commit(0, e.shiftKey ? -1 : 1); }
    else if (k === 'Escape') { e.preventDefault(); this.cancel(); }
    else if (this.DIRS[k] && this.ed.enter && inp === this.editor && inp.value[0] !== '=' && !e.shiftKey && !mod) { e.preventDefault(); this.commit(...this.DIRS[k]); }
    else if (mod && !e.shiftKey && /^[bi]$/i.test(k)) { e.preventDefault(); Sheet.run(k.toLowerCase() === 'b' ? 'bold' : 'italic'); }
  },
  edInputEl() { return this.ed?.src === 'bar' ? this.bar : this.editor; },
  canPick() {
    const inp = this.edInputEl(), v = inp.value, p = inp.selectionStart, pk = this.pick;
    if (v[0] !== '=') return false;
    if (pk && p === pk.end && v.slice(pk.start, pk.end) === pk.ref) return true;
    return /[=(,+\-*/^&<>:]$/.test(v.slice(0, p).trimEnd());
  },
  insertRef(r1, c1, r2, c2) {
    const inp = this.edInputEl(), v = inp.value, pk = this.pick;
    const ref = Sheet.rangeName({ r1, c1, r2, c2 });
    let a = inp.selectionStart, b = inp.selectionEnd;
    if (pk && a === pk.end && v.slice(pk.start, pk.end) === pk.ref) a = pk.start;
    inp.value = v.slice(0, a) + ref + v.slice(b);
    inp.setSelectionRange(a + ref.length, a + ref.length);
    this.pick = { start: a, end: a + ref.length, ref };
    this._picking = true; this.edInput(inp); this._picking = false;
  },
  bindBar() {
    const S = Sheet, { editor, bar, name } = this;
    editor.addEventListener('input', () => { if (this.ed) this.edInput(editor); });
    editor.addEventListener('focus', () => { if (this.ed) this.ed.src = 'cell'; });
    editor.addEventListener('keydown', e => this.edKey(e, editor));
    bar.addEventListener('focus', () => { if (!this.ed) this.beginBar(); else this.ed.src = 'bar'; });
    bar.addEventListener('input', () => { if (!this.ed) this.beginBar(); this.edInput(bar); });
    bar.addEventListener('keydown', e => this.edKey(e, bar));
    for (const inp of [editor, bar]) inp.addEventListener('blur', e => {
      const t = e.relatedTarget;   // focus moved to another control (not just the window losing focus) -> commit
      if (this.ed && t && t !== editor && t !== bar) this.commit(0, 0, true);
    });
    name.addEventListener('focus', () => name.select());
    name.addEventListener('blur', () => { name.value = S.rangeName(); });
    name.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); name.value = S.rangeName(); this.focus(); }
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const m = /^\s*(\$?[a-z]+\$?\d+)(?::(\$?[a-z]+\$?\d+))?\s*$/i.exec(name.value);
      const a = m && S.parse(m[1]), b = m && (m[2] ? S.parse(m[2]) : a);
      if (a && b) { S.select(a.r, a.c, b.r, b.c); this.ensureVisible(b.r, b.c); this.ensureVisible(a.r, a.c); }
      else S.toast('Invalid range: ' + name.value);
      name.value = S.rangeName(); this.focus();
    });
    const dd = this.grid.parentNode.querySelector('.g-name-dd');
    dd.addEventListener('mousedown', e => e.preventDefault());
    dd.addEventListener('click', () => S.soon('Named ranges'));
  },

  // ---------- keyboard (grid focused) ----------
  bindKeys() {
    document.addEventListener('keydown', e => {
      const t = e.target;
      if (t === this.editor || t === this.bar || t === this.name) return;
      if (t !== this.sink && t !== document.body && !this.grid.contains(t)) return;
      if (e.defaultPrevented || e.isComposing || Menu.isOpen) return;
      this.gridKey(e);
    });
  },
  gridKey(e) {
    const S = Sheet, s = S.sel, k = e.key, low = k.toLowerCase(), mod = e.metaKey || e.ctrlKey, dir = this.DIRS[k];
    const run = n => { e.preventDefault(); S.run(n); };
    if (mod) {
      if (low === 'z') return run(e.shiftKey ? 'redo' : 'undo');
      if (low === 'y') return run('redo');
      if (low === 'b' && !e.shiftKey) return run('bold');
      if (low === 'i' && !e.shiftKey) return run('italic');
      if (low === 'x' && e.shiftKey) return run('strike');
      if (k === '\\') return run('clearFormat');
      if (low === 'a') return run('selectAll');
      if (dir) { e.preventDefault(); return this.move(dir, e.shiftKey, true); }
      if (k === 'Home') { e.preventDefault(); return this.go(0, 0); }
      if (k === 'End') { e.preventDefault(); return this.go(Math.max(0, S.usedRows() - 1), Math.max(0, S.usedCols() - 1)); }
      return;   // ⌘C / ⌘X / ⌘V arrive as native clipboard events
    }
    if (dir) { e.preventDefault(); return this.move(dir, e.shiftKey); }
    switch (k) {
      case 'Enter': e.preventDefault(); return e.shiftKey ? this.go(s.r - 1, s.c) : this.startEdit();
      case 'F2': e.preventDefault(); return this.startEdit();
      case 'Tab': e.preventDefault(); return this.go(s.r, s.c + (e.shiftKey ? -1 : 1));
      case 'Delete': case 'Backspace': return run('clear');
      case 'Escape': return this.hideAnts();
      case 'Home': e.preventDefault(); return this.go(s.r, 0);
      case 'End': { e.preventDefault(); let c = S.cols - 1; while (c > 0 && S.raw(s.r, c) === '') c--; return this.go(s.r, c); }
      case 'PageDown': case 'PageUp': {
        e.preventDefault();
        const n = Math.max(1, Math.floor(this.scroll.clientHeight / this.zoom / S.DEFAULT_H) - 2) * (k === 'PageUp' ? -1 : 1);
        this.scroll.scrollTop += n * S.DEFAULT_H * this.zoom; return this.go(s.r + n, s.c);
      }
    }
    if (k.length === 1 && !e.ctrlKey) { e.preventDefault(); this.startEdit(k, 'cell', true); }
  },

  // ---------- clipboard ----------
  bindClipboard() {
    const ok = () => this._force || (!this.ed && (document.activeElement === this.sink || document.activeElement === document.body));
    document.addEventListener('copy', e => { if (ok()) this.copy(e, false); });
    document.addEventListener('cut', e => { if (ok()) this.copy(e, true); });
    document.addEventListener('paste', e => {
      if (!ok()) return;
      e.preventDefault();
      this.pasteData(e.clipboardData.getData('text/plain'), e.clipboardData.getData('text/html'));
    });
  },
  copy(e, cut) {
    const S = Sheet, s = { ...S.sel }, cells = [], txt = [];
    for (let r = s.r1; r <= s.r2; r++) {
      const row = [], t = [];
      for (let c = s.c1; c <= s.c2; c++) { const cell = S.cell(r, c); row.push(cell ? JSON.parse(JSON.stringify(cell)) : null); t.push(S.display(r, c).text); }
      cells.push(row); txt.push(t);
    }
    const q = v => /[\t\n"]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    const esc = v => v.replace(/[&<>]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
    const tsv = txt.map(r => r.map(q).join('\t')).join('\n');
    const html = '<table>' + txt.map(r => '<tr>' + r.map(v => `<td>${esc(v)}</td>`).join('') + '</tr>').join('') + '</table>';
    if (e) { e.clipboardData.setData('text/plain', tsv); e.clipboardData.setData('text/html', html); e.preventDefault(); }
    else navigator.clipboard?.writeText(tsv).catch(() => {});
    this.clip = { cells, s, cut, tsv };
    this.showAnts();
  },
  clipCmd(kind) {
    this._force = true;
    let ok = false; try { ok = document.execCommand(kind); } catch {}
    this._force = false;
    if (!ok) this.copy(null, kind === 'cut');
  },
  async pasteCmd() {
    try {
      let text = '', html = '';
      for (const it of await navigator.clipboard.read()) {
        if (it.types.includes('text/html')) html = await (await it.getType('text/html')).text();
        if (it.types.includes('text/plain')) text = await (await it.getType('text/plain')).text();
      }
      return this.pasteData(text, html);
    } catch {}
    try { return this.pasteData(await navigator.clipboard.readText(), ''); } catch {}
    if (this.clip) this.pasteCells(this.clip.cells, this.clip); else Sheet.toast(`Use ${this.MOD}V to paste`);
  },
  pasteData(text = '', html = '') {
    const norm = t => t.replace(/\r\n?/g, '\n');
    if (this.clip && text && norm(text) === norm(this.clip.tsv)) return this.pasteCells(this.clip.cells, this.clip);
    const rows = (html && this.parseHTML(html)) || (text ? this.parseTSV(norm(text)) : null);
    if (rows?.length) this.pasteCells(rows.map(r => r.map(v => ({ raw: v }))));
  },
  parseHTML(html) {
    const t = new DOMParser().parseFromString(html, 'text/html').querySelector('table');
    if (!t) return null;
    return [...t.rows].map(tr => [...tr.cells].flatMap(td => {
      td.querySelectorAll('br').forEach(b => b.replaceWith('\u0001'));
      const v = td.textContent.replace(/ /g, ' ').replace(/\s+/g, ' ').trim().replace(/ ?\u0001 ?/g, '\n');
      return [v, ...Array(Math.max(0, (td.colSpan || 1) - 1)).fill('')];
    }));
  },
  parseTSV(text) {
    const rows = []; let row = [], cell = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quoted) { if (ch !== '"') cell += ch; else if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
      else if (ch === '"' && cell === '') quoted = true;
      else if (ch === '\t') { row.push(cell); cell = ''; }
      else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += ch;
    }
    row.push(cell); rows.push(row);
    if (rows.length > 1 && rows.at(-1).length === 1 && rows.at(-1)[0] === '') rows.pop();
    return rows;
  },
  shift(raw, dr, dc) { const F = this.F(); return typeof raw === 'string' && raw[0] === '=' && F?.offsetRefs ? F.offsetRefs(raw, dr, dc) : raw; },
  pasteCells(cells, clip) {   // clip given -> internal paste (raw + style, formulas shifted); else plain values
    const S = Sheet, s = { ...S.sel }, h = cells.length, w = Math.max(...cells.map(r => r.length));
    const sh = s.r2 - s.r1 + 1, sw = s.c2 - s.c1 + 1;
    const R = sh > h && sh % h === 0 ? sh : h, C = sw > w && sw % w === 0 ? sw : w;   // tile into a multiple-sized selection
    S.transact(() => {
      if (s.r1 + R > S.rows) S.insertRows(S.rows, s.r1 + R - S.rows);
      if (s.c1 + C > S.cols) S.insertCols(S.cols, s.c1 + C - S.cols);
      if (clip?.cut) S.forSel((r, c) => S.setCell(r, c, null), clip.s);
      for (let i = 0; i < R; i++) for (let j = 0; j < C; j++) {
        const src = cells[i % h][j % w], r = s.r1 + i, c = s.c1 + j;
        if (!clip) { S.setRaw(r, c, src?.raw ?? ''); continue; }
        const cell = src && { ...src };
        if (cell && !clip.cut) cell.raw = this.shift(cell.raw, r - clip.s.r1 - i % h, c - clip.s.c1 - j % w);
        S.setCell(r, c, cell);
      }
    });
    if (clip?.cut) { this.clip = null; this.hideAnts(); }
    S.select(s.r1, s.c1, s.r1 + R - 1, s.c1 + C - 1);
  },
  showAnts() {
    const s = this.clip?.s; if (!s) return;
    const R = this.rangeRect(s.r1, s.c1, Math.min(s.r2, Sheet.rows - 1), Math.min(s.c2, Sheet.cols - 1));
    this.antsOn = true; this.box(this.sel.ants, R.x - 1, R.y - 1, R.w + 1, R.h + 1);
  },
  hideAnts() { this.antsOn = false; this.sel.ants.style.display = 'none'; },

  // ---------- fill handle ----------
  fillDrag(e) {
    e.preventDefault(); e.stopPropagation();
    if (this.ed) this.commit(0, 0);
    const src = { ...Sheet.sel }; let tgt = null;
    this.drag(ev => {
      const { r, c } = this.hit(ev);
      const dv = r > src.r2 ? r - src.r2 : r < src.r1 ? src.r1 - r : 0, dh = c > src.c2 ? c - src.c2 : c < src.c1 ? src.c1 - c : 0;
      tgt = !dv && !dh ? null : dv >= dh ? { ...src, r1: Math.min(src.r1, r), r2: Math.max(src.r2, r) } : { ...src, c1: Math.min(src.c1, c), c2: Math.max(src.c2, c) };
      const R = tgt && this.rangeRect(tgt.r1, tgt.c1, tgt.r2, tgt.c2);
      this.box(this.sel.fillprev, !!R && R.x - 1, R?.y - 1, R?.w + 1, R?.h + 1);
    }, () => { this.sel.fillprev.style.display = 'none'; if (tgt) this.fill(src, tgt); this.focus(); });
  },
  autoFill() {   // double-click on the handle: fill down as far as the neighbouring column has data
    const S = Sheet, s = { ...S.sel }, col = s.c1 > 0 && S.raw(s.r2 + 1, s.c1 - 1) !== '' ? s.c1 - 1 : s.c2 + 1;
    let end = s.r2; while (end + 1 < S.rows && col < S.cols && S.raw(end + 1, col) !== '') end++;
    if (end > s.r2) this.fill(s, { ...s, r2: end });
  },
  series(raws) {   // fn(k) -> raw for offset k from the first source cell, or null to just copy
    const n = raws.length, ar = v => n === 1 ? 1 : v[1] - v[0], isAr = (v, d) => v.every((x, i) => Math.abs(x - (v[0] + d * i)) < 1e-9);
    if (n >= 2 && raws.every(v => v !== '' && v[0] !== '=' && isFinite(v))) {
      const v = raws.map(Number), d = ar(v);
      if (isAr(v, d)) return k => String(+(v[0] + d * k).toFixed(10));
    }
    const m = raws.map(v => v[0] !== '=' && !isFinite(v) && /^(.*?)(\d+)$/.exec(v));
    if (m.every(x => x && x[1] === m[0][1])) {   // "Item 1" -> "Item 2" ...
      const v = m.map(x => +x[2]), d = ar(v);
      if (isAr(v, d)) return k => m[0][1] + Math.abs(v[0] + d * k);
    }
    return null;
  },
  fill(src, t) {
    const S = Sheet, vert = t.r1 !== src.r1 || t.r2 !== src.r2;
    const n = vert ? src.r2 - src.r1 + 1 : src.c2 - src.c1 + 1, from = vert ? t.r1 - src.r1 : t.c1 - src.c1, to = vert ? t.r2 - src.r1 : t.c2 - src.c1;
    S.transact(() => {
      for (let L = vert ? src.c1 : src.r1; L <= (vert ? src.c2 : src.r2); L++) {
        const at = i => vert ? [src.r1 + i, L] : [L, src.c1 + i];
        const series = this.series([...Array(n)].map((_, i) => String(S.raw(...at(i)))));
        for (let k = from; k <= to; k++) {
          if (k >= 0 && k < n) continue;
          const [sr, sc] = at(((k % n) + n) % n), [tr, tc] = at(k), cell = S.cell(sr, sc);
          const raw = series ? series(k) : this.shift(cell?.raw ?? '', tr - sr, tc - sc);
          S.setCell(tr, tc, raw || cell?.s ? { raw, s: cell?.s } : null);
        }
      }
    });
    if (src.r1 === t.r1 && src.c1 === t.c1) S.select(src.r1, src.c1, t.r2, t.c2); else S.select(t.r1, t.c1, t.r2, t.c2);
  },

  // ---------- context menu ----------
  ctxMenu(e, kind) {
    e.preventDefault();
    if (this.ed) this.commit(0, 0);
    const S = Sheet, h = this.hit(e), s = S.sel, M = this.MOD;
    const inC = h.c >= s.c1 && h.c <= s.c2, inR = h.r >= s.r1 && h.r <= s.r2;
    if (kind === 'cell' && !(inC && inR)) S.select(h.r, h.c);
    if (kind === 'col' && !(inC && s.r1 === 0 && s.r2 === S.rows - 1)) S.select(0, h.c, S.rows - 1, h.c);
    if (kind === 'row' && !(inR && s.c1 === 0 && s.c2 === S.cols - 1)) S.select(h.r, 0, h.r, S.cols - 1);
    this.focus();
    const n = S.sel, nr = n.r2 - n.r1 + 1, nc = n.c2 - n.c1 + 1, pl = (k, w) => `${k} ${w}${k > 1 ? 's' : ''}`;
    const delR = nr > 1 ? `Delete rows ${n.r1 + 1} - ${n.r2 + 1}` : 'Delete row';
    const delC = nc > 1 ? `Delete columns ${S.colName(n.c1)} - ${S.colName(n.c2)}` : 'Delete column';
    const items = [
      { label: 'Cut', icon: 'content_cut', shortcut: M + 'X', cmd: 'cut' },
      { label: 'Copy', icon: 'content_copy', shortcut: M + 'C', cmd: 'copy' },
      { label: 'Paste', icon: 'content_paste', shortcut: M + 'V', cmd: 'paste' },
      { sep: true },
    ];
    const rowIns = [{ label: `Insert ${pl(nr, 'row')} above`, icon: 'add', cmd: 'insertRowAbove' }, { label: `Insert ${pl(nr, 'row')} below`, icon: 'add', cmd: 'insertRowBelow' }];
    const colIns = [{ label: `Insert ${pl(nc, 'column')} left`, icon: 'add', cmd: 'insertColLeft' }, { label: `Insert ${pl(nc, 'column')} right`, icon: 'add', cmd: 'insertColRight' }];
    if (kind === 'cell') items.push(...rowIns, ...colIns, { sep: true },
      { label: delR, icon: 'delete', cmd: 'deleteRows' }, { label: delC, icon: 'delete', cmd: 'deleteCols' },
      { label: 'Delete values', icon: 'backspace', cmd: 'clear' }, { sep: true },
      { label: 'Clear formatting', icon: 'format_clear', shortcut: M + '\\', cmd: 'clearFormat' });
    else if (kind === 'col') items.push(...colIns, { sep: true },
      { label: delC, icon: 'delete', cmd: 'deleteCols' }, { label: `Clear ${nc > 1 ? 'columns' : 'column'}`, icon: 'close', cmd: 'clear' }, { sep: true },
      { label: `Resize ${nc > 1 ? 'columns' : 'column'}`, icon: 'width', soon: true });
    else items.push(...rowIns, { sep: true },
      { label: delR, icon: 'delete', cmd: 'deleteRows' }, { label: `Clear ${nr > 1 ? 'rows' : 'row'}`, icon: 'close', cmd: 'clear' }, { sep: true },
      { label: `Resize ${nr > 1 ? 'rows' : 'row'}`, icon: 'height', soon: true });
    Menu.open(items, e.clientX, e.clientY);
  },
};