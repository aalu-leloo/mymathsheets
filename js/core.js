// MathSheets core: data model, undo/redo, selection, commands and value formatting.
// Every part talks to the others only through `Sheet` (and the `Menu` helper in ui-kit.js).
const Sheet = {
  rows: 100, cols: 26, DEFAULT_W: 100, DEFAULT_H: 21,
  // "A1" -> { raw: '=SUM(A2:A5)', s: style }. Style keys (all optional):
  //   b bold · i italic · st strikethrough · color text color · bg fill · font family · size (pt, default 10)
  //   ha 'left'|'center'|'right' · va 'top'|'middle'|'bottom' (default bottom) · wrap 'wrap'|'clip' (default overflow)
  //   fmt 'auto'|'text'|'number'|'percent'|'scientific'|'currency'|'date'|'time'|'datetime' · dec decimals
  //   bt bb bl br  true = 1px solid black border on top/bottom/left/right side
  cells: {},
  values: {},     // "A1" -> computed value: number | string | boolean | error string. Filled by Formula.
  valueFmt: {},   // "A1" -> implicit format detected from input/result ('date' | 'datetime' | 'percent' | 'currency')
  colW: {}, rowH: {},                       // custom sizes in px, keyed by index
  meta: { title: 'Untitled spreadsheet', starred: false, zoom: 100 },
  sel: { r: 0, c: 0, r1: 0, c1: 0, r2: 0, c2: 0 },   // active cell (r,c) + normalized range
  ERRORS: ['#DIV/0!', '#REF!', '#NAME?', '#VALUE!', '#N/A', '#NUM!', '#ERROR!'],
  hooks: { shiftRefs: null },               // Formula sets (raw, axis 'row'|'col', at, delta) => raw
  _ev: {}, _undo: [], _redo: [], _tx: 0, _cmds: {},

  // ---- events ----
  on(name, fn) { (this._ev[name] = this._ev[name] || []).push(fn); },
  emit(name, data) { (this._ev[name] || []).forEach(fn => fn(data)); },
  toast(text) { this.emit('toast', text); },
  soon(what) { this.toast((what ? what + ': ' : '') + 'Coming soon'); },

  // ---- addressing ----
  colName(c) { let s = ''; for (c++; c > 0; c = Math.floor((c - 1) / 26)) s = String.fromCharCode(65 + (c - 1) % 26) + s; return s; },
  colIndex(name) { let n = 0; for (const ch of name.toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; },
  id(r, c) { return this.colName(c) + (r + 1); },
  parse(id) { const m = /^\$?([A-Z]+)\$?(\d+)$/i.exec(id); return m && { r: +m[2] - 1, c: this.colIndex(m[1]) }; },
  rangeName(s = this.sel) { const a = this.id(s.r1, s.c1), b = this.id(s.r2, s.c2); return a === b ? a : a + ':' + b; },

  // ---- read ----
  cell(r, c) { return this.cells[this.id(r, c)]; },
  raw(r, c) { return this.cell(r, c)?.raw ?? ''; },
  style(r, c) { return this.cell(r, c)?.s || {}; },
  value(r, c) { const v = this.values[this.id(r, c)]; return v === undefined ? this.raw(r, c) : v; },
  width(c) { return this.colW[c] || this.DEFAULT_W; },
  height(r) { return this.rowH[r] || this.DEFAULT_H; },
  isError(v) { return typeof v === 'string' && this.ERRORS.includes(v); },
  usedRows() { let n = 0; for (const k in this.cells) if (this.cells[k].raw) n = Math.max(n, this.parse(k).r + 1); return n; },
  usedCols() { let n = 0; for (const k in this.cells) if (this.cells[k].raw) n = Math.max(n, this.parse(k).c + 1); return n; },

  // ---- write: every mutation goes through transact() so it becomes one undo step ----
  _snap() { return JSON.stringify({ cells: this.cells, colW: this.colW, rowH: this.rowH, rows: this.rows, cols: this.cols }); },
  transact(fn) {
    if (this._tx++ === 0) { this._before = this._snap(); this._structural = false; }
    try { fn(); } finally {
      if (--this._tx === 0) {
        if (this._snap() !== this._before) {
          this._undo.push(this._before); if (this._undo.length > 200) this._undo.shift();
          this._redo = [];
          this._changed();
        }
      }
    }
  },
  _changed() {
    if (this._structural) { this._structural = false; this.clampSel(); this.emit('structure'); }
    this.emit('change');   // Formula recalculates on this, then emits 'recalc' for the Grid
  },
  _restore(json) { Object.assign(this, JSON.parse(json)); this._structural = true; this._changed(); },
  undo() { if (!this._undo.length) return; this._redo.push(this._snap()); this._restore(this._undo.pop()); },
  redo() { if (!this._redo.length) return; this._undo.push(this._snap()); this._restore(this._redo.pop()); },

  setRaw(r, c, raw) {
    this.transact(() => {
      const k = this.id(r, c), cell = this.cells[k] || (this.cells[k] = {});
      cell.raw = raw;
      if (!raw && !cell.s) delete this.cells[k];
    });
  },
  setStyle(r, c, props) {
    this.transact(() => {
      const k = this.id(r, c), cell = this.cells[k] || (this.cells[k] = { raw: '' });
      const s = Object.assign(cell.s || {}, props);
      for (const p in s) if (s[p] == null || s[p] === '' || s[p] === false) delete s[p];
      if (Object.keys(s).length) cell.s = s; else delete cell.s;
      if (!cell.raw && !cell.s) delete this.cells[k];
    });
  },
  setCell(r, c, cell) {   // replace whole cell ({raw, s}) or delete it (null) — used by paste/fill/sort
    this.transact(() => { const k = this.id(r, c); if (cell && (cell.raw || cell.s)) this.cells[k] = JSON.parse(JSON.stringify(cell)); else delete this.cells[k]; });
  },
  setSize(axis, i, px) { this.transact(() => { (axis === 'col' ? this.colW : this.rowH)[i] = Math.max(axis === 'col' ? 20 : 15, Math.round(px)); this._structural = true; }); },

  // ---- selection ----
  select(r, c, r2 = r, c2 = c) {   // (r,c) = active/anchor cell, (r2,c2) = opposite corner
    const cl = (v, max) => Math.max(0, Math.min(max - 1, v));
    r = cl(r, this.rows); c = cl(c, this.cols); r2 = cl(r2, this.rows); c2 = cl(c2, this.cols);
    this.sel = { r, c, r1: Math.min(r, r2), c1: Math.min(c, c2), r2: Math.max(r, r2), c2: Math.max(c, c2) };
    this.emit('select', this.sel);
  },
  clampSel() { const s = this.sel; this.select(s.r, s.c, s.r === s.r1 ? s.r2 : s.r1, s.c === s.c1 ? s.c2 : s.c1); },
  forSel(fn, s = this.sel) { for (let r = s.r1; r <= s.r2; r++) for (let c = s.c1; c <= s.c2; c++) fn(r, c); },
  styleSel(props) { this.transact(() => this.forSel((r, c) => this.setStyle(r, c, props))); },
  toggleSel(key) { const on = !this.style(this.sel.r, this.sel.c)[key]; this.styleSel({ [key]: on }); },
  clearSel() { this.transact(() => this.forSel((r, c) => { if (this.raw(r, c)) this.setRaw(r, c, ''); })); },

  // ---- structure ----
  _remap(map, axis, at, delta) {
    const out = {};
    for (const [k, cell] of Object.entries(this.cells)) { const p = this.parse(k), q = map(p.r, p.c); if (q) out[this.id(q.r, q.c)] = cell; }
    this.cells = out;
    if (this.hooks.shiftRefs) for (const cell of Object.values(out)) if (typeof cell.raw === 'string' && cell.raw[0] === '=') cell.raw = this.hooks.shiftRefs(cell.raw, axis, at, delta);
    this._structural = true;
  },
  _shiftSizes(obj, at, delta) {
    const out = {};
    for (const [i, v] of Object.entries(obj)) { const n = +i; if (delta < 0 && n >= at && n < at - delta) continue; out[n >= at ? n + delta : n] = v; }
    return out;
  },
  insertRows(at, n = 1) { this.transact(() => { this._remap((r, c) => ({ r: r >= at ? r + n : r, c }), 'row', at, n); this.rowH = this._shiftSizes(this.rowH, at, n); this.rows += n; }); },
  insertCols(at, n = 1) { this.transact(() => { this._remap((r, c) => ({ r, c: c >= at ? c + n : c }), 'col', at, n); this.colW = this._shiftSizes(this.colW, at, n); this.cols += n; }); },
  deleteRows(at, n = 1) {
    n = Math.min(n, this.rows - 1); if (n < 1) return;
    this.transact(() => { this._remap((r, c) => r < at ? { r, c } : r < at + n ? null : { r: r - n, c }, 'row', at, -n); this.rowH = this._shiftSizes(this.rowH, at, -n); this.rows -= n; });
  },
  deleteCols(at, n = 1) {
    n = Math.min(n, this.cols - 1); if (n < 1) return;
    this.transact(() => { this._remap((r, c) => c < at ? { r, c } : c < at + n ? null : { r, c: c - n }, 'col', at, -n); this.colW = this._shiftSizes(this.colW, at, -n); this.cols -= n; });
  },
  sortSel(asc) {   // multi-row selection: sort that range; otherwise sort the whole sheet by the active column
    let { r1, r2, c1, c2, c: key } = this.sel;
    if (r1 === r2) { r1 = 0; r2 = this.usedRows() - 1; c1 = 0; c2 = this.cols - 1; }
    if (r2 <= r1) return;
    const rank = v => v === '' || v == null ? 2 : typeof v === 'number' ? 0 : 1;
    const rows = [];
    for (let r = r1; r <= r2; r++) { const row = []; for (let c = c1; c <= c2; c++) row.push(this.cell(r, c) || null); rows.push({ row, v: this.value(r, key) }); }
    rows.sort((a, b) => {
      const ra = rank(a.v), rb = rank(b.v);
      if (ra === 2 || rb === 2 || ra !== rb) return ra === rb ? 0 : ra === 2 ? 1 : rb === 2 ? -1 : (ra - rb) * (asc ? 1 : -1);
      const d = ra === 0 ? a.v - b.v : String(a.v).localeCompare(String(b.v), undefined, { sensitivity: 'base' });
      return asc ? d : -d;
    });
    this.transact(() => rows.forEach((x, i) => x.row.forEach((cell, j) => this.setCell(r1 + i, c1 + j, cell))));
  },

  // ---- commands: menus/toolbars/shortcuts call Sheet.run(name); unknown names show "Coming soon" ----
  command(name, fn) { this._cmds[name] = fn; },
  run(name, ...args) { const fn = this._cmds[name]; if (fn) fn(...args); else this.soon(); },

  // ---- display formatting ----
  serialToDate(n) { const d = new Date(1899, 11, 30 + Math.floor(n)); d.setMilliseconds(Math.round((n - Math.floor(n)) * 864e5)); return d; },
  dateToSerial(d) { const base = new Date(1899, 11, 30); const day = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - base) / 864e5); return day + (d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()) / 86400; },
  formatNumber(v, fmt, dec, implicit) {
    const group = (n, d) => n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
    switch (fmt) {
      case 'number': return group(v, dec ?? 2);
      case 'percent': return group(v * 100, dec ?? (implicit && Number.isInteger(+(v * 100).toFixed(8)) ? 0 : 2)) + '%';
      case 'currency': return (v < 0 ? '-$' : '$') + group(Math.abs(v), dec ?? 2);
      case 'scientific': return v.toExponential(dec ?? 2).toUpperCase().replace(/E([+-])(\d)$/, 'E$10$2');
      case 'date': return this.serialToDate(v).toLocaleDateString('en-US');
      case 'time': return this.serialToDate(v).toLocaleTimeString('en-US');
      case 'datetime': { const d = this.serialToDate(v); return d.toLocaleDateString('en-US') + ' ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: false }); }
      default: return dec != null ? v.toFixed(dec) : String(Number.isInteger(v) ? v : +v.toPrecision(10));
    }
  },
  // What a cell shows: { text, align, kind: 'empty'|'number'|'text'|'bool'|'error' }
  display(r, c) {
    const k = this.id(r, c), cell = this.cells[k], s = cell?.s || {};
    let v = this.values[k]; if (v === undefined) v = cell?.raw ?? '';
    const own = s.fmt && s.fmt !== 'auto', fmt = own ? s.fmt : (this.valueFmt[k] || 'auto');
    if (v === '' || v == null) return { text: '', align: s.ha || 'left', kind: 'empty' };
    if (this.isError(v)) return { text: v, align: s.ha || 'center', kind: 'error' };
    if (typeof v === 'boolean') return { text: v ? 'TRUE' : 'FALSE', align: s.ha || 'center', kind: 'bool' };
    if (typeof v === 'number' && fmt !== 'text' && isFinite(v)) return { text: this.formatNumber(v, fmt, s.dec, !own), align: s.ha || 'right', kind: 'number' };
    return { text: String(v), align: s.ha || 'left', kind: 'text' };
  },

  // ---- persistence / export ----
  serialize() { return { cells: this.cells, colW: this.colW, rowH: this.rowH, rows: this.rows, cols: this.cols, meta: this.meta }; },
  load(data = {}) {
    this.cells = data.cells || {}; this.colW = data.colW || {}; this.rowH = data.rowH || {};
    this.rows = data.rows || 100; this.cols = data.cols || 26;
    this.meta = Object.assign({ title: 'Untitled spreadsheet', starred: false, zoom: 100 }, data.meta);
    this._undo = []; this._redo = [];
    this._structural = true; this._changed(); this.emit('meta'); this.emit('load');
  },
  toCSV() {
    const q = t => /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t, out = [];
    for (let r = 0; r < this.usedRows(); r++) { const row = []; for (let c = 0; c < this.usedCols(); c++) row.push(q(this.display(r, c).text)); out.push(row.join(',')); }
    return out.join('\n');
  },
};

// ---- built-in commands ----
(() => {
  const S = Sheet, n = s => ({ rows: s.r2 - s.r1 + 1, cols: s.c2 - s.c1 + 1 });
  const cmds = {
    undo: () => S.undo(), redo: () => S.redo(),
    bold: () => S.toggleSel('b'), italic: () => S.toggleSel('i'), strike: () => S.toggleSel('st'),
    clear: () => S.clearSel(),
    clearFormat: () => S.transact(() => S.forSel((r, c) => S.setStyle(r, c, Object.fromEntries(Object.keys(S.style(r, c)).map(k => [k, null]))))),
    selectAll: () => S.select(0, 0, S.rows - 1, S.cols - 1),
    insertRowAbove: () => S.insertRows(S.sel.r1, n(S.sel).rows),
    insertRowBelow: () => S.insertRows(S.sel.r2 + 1, n(S.sel).rows),
    insertColLeft: () => S.insertCols(S.sel.c1, n(S.sel).cols),
    insertColRight: () => S.insertCols(S.sel.c2 + 1, n(S.sel).cols),
    deleteRows: () => S.deleteRows(S.sel.r1, n(S.sel).rows),
    deleteCols: () => S.deleteCols(S.sel.c1, n(S.sel).cols),
    sortAZ: () => S.sortSel(true), sortZA: () => S.sortSel(false),
    format: fmt => S.styleSel({ fmt: fmt === 'auto' ? null : fmt, dec: null }),
    new: () => { if (confirm('Start a new, empty spreadsheet? The current one will be replaced.')) { S.load({}); S.select(0, 0); } },
    downloadCSV: () => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([S.toCSV()], { type: 'text/csv' }));
      a.download = (S.meta.title || 'MathSheets') + ' - Sheet1.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    },
  };
  for (const k in cmds) S.command(k, cmds[k]);
})();
/* Events
   change      data/style/structure changed (after each transaction)  -> Formula recalculates
   recalc      Sheet.values updated                                    -> Grid re-renders cells
   structure   rows/cols inserted/deleted/resized, or sheet loaded     -> Grid rebuilds layout (always followed by change)
   select      selection changed (Sheet.sel)
   meta        title/starred/zoom changed
   load        whole sheet replaced (after structure/change)
   editing     {text, source}  live text of the cell editor / formula bar while typing
   focusgrid   UI asks the grid to take keyboard focus back
   toast       text to show in a small toast
*/