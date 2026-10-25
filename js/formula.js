// MathSheets formula engine (Google Sheets semantics).
// Pipeline: tokenize -> recursive-descent parse -> AST -> closures (cached per raw string), then a full recalc
// pass with memoization + cycle detection. Also: reference rewriting for copy/fill (offsetRefs) and
// insert/delete (shiftRefs), function autocomplete + argument hint for editors, colored range highlights.
// Errors travel as the strings in Sheet.ERRORS; inside evaluation they are thrown and caught per cell.
const Formula = (() => {
  const S = Sheet, ERR = new Set(S.ERRORS), INF = Infinity;
  const isErr = v => typeof v === 'string' && ERR.has(v);
  const fail = e => { throw e; };
  const cols = [], cn = c => cols[c] || (cols[c] = S.colName(c));
  const fix = n => n === 0 ? 0 : +n.toPrecision(15);              // strip float noise: 0.1+0.2 -> 0.3
  const numText = n => String(fix(n));

  // ---------- literals typed into cells: numbers, $, %, booleans, dates/times ----------
  const NUM = /^[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d*)?(?:e[+-]?\d+)?$/i;
  const TIME = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?$/i;
  const litCache = new Map();
  function lit(raw) {
    let r = litCache.get(raw);
    if (!r) { if (litCache.size > 20000) litCache.clear(); litCache.set(raw, r = parseLiteral(raw)); }
    return r;
  }
  function toNum(t) { return /\d/.test(t) && NUM.test(t) ? +t.replace(/,/g, '') : NaN; }
  function parseLiteral(raw) {
    const t = raw.trim(); let m, n;
    if (!t) return { v: raw };
    if (!isNaN(n = toNum(t))) return { v: n };
    if ((m = /^([+-]?)\$\s*([+-]?)(.+)$/.exec(t)) && !isNaN(n = toNum(m[3]))) return { v: (m[1] === '-' ^ m[2] === '-' ? -n : n), fmt: 'currency' };
    if ((m = /^(.+)%$/.exec(t)) && !isNaN(n = toNum(m[1].trim()))) return { v: fix(n / 100), fmt: 'percent' };
    if (/^(true|false)$/i.test(t)) return { v: t.toLowerCase() === 'true' };
    if ((m = TIME.exec(t))) { const s = timeOf(m); if (s != null) return { v: s, fmt: 'time' }; }
    if ((m = /^(?:(\d{1,2})\/(\d{1,2})\/(\d{4})|(\d{4})-(\d{1,2})-(\d{1,2}))(?:\s+(.+))?$/.exec(t))) {
      const [y, mo, d] = m[1] ? [+m[3], +m[1], +m[2]] : [+m[4], +m[5], +m[6]], dt = new Date(y, mo - 1, d);
      const tm = m[7] ? TIME.exec(m[7]) : null, frac = tm ? timeOf(tm) : 0;
      if (dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d && frac != null && (!m[7] || tm))
        return { v: Math.round(S.dateToSerial(dt)) + frac, fmt: m[7] ? 'datetime' : 'date' };
    }
    return { v: raw };
  }
  function timeOf(m) {
    let h = +m[1]; const mi = +m[2], s = +(m[3] || 0), ap = (m[4] || '').toLowerCase();
    if (ap) { if (h < 1 || h > 12) return null; h = h % 12 + (ap === 'pm' ? 12 : 0); }
    return h < 24 && mi < 60 && s < 60 ? (h * 3600 + mi * 60 + s) / 86400 : null;
  }

  // ---------- tokenizer ----------
  // groups: 1-2 string (2 = closing quote), 3 error literal, 4 function name, 5 reference, 6 number, 7 name, 8 operator, 9 bad char
  const TOK = /\s*(?:"((?:[^"]|"")*)("?)|(#(?:DIV\/0!|REF!|NAME\?|VALUE!|N\/A|NUM!|ERROR!))|([A-Za-z_][\w.]*)(?=\s*\()|(\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?|\$?[A-Za-z]{1,3}:\$?[A-Za-z]{1,3}|\$?\d+:\$?\d+)(?![\w(.])|(\d+\.?\d*(?:e[+-]?\d+)?|\.\d+(?:e[+-]?\d+)?)|([A-Za-z_][\w.]*)|(<>|<=|>=|[-+*/^&=<>%(),])|(\S))/iy;
  const KINDS = [, 'str', , 'err', 'fn', 'ref', 'num', 'name', 'op', 'bad'];
  function tokenize(src) {
    const out = []; let m; TOK.lastIndex = 0;
    while (TOK.lastIndex < src.length && (m = TOK.exec(src))) {
      const g = m.findIndex((x, i) => i > 0 && i !== 2 && x !== undefined), e = TOK.lastIndex;
      const t = { k: KINDS[g], v: m[g], s: e - m[0].trimStart().length, e };
      if (g === 1) { t.v = m[1].replace(/""/g, '"'); if (!m[2]) t.k = 'bad'; }
      if (g === 3) t.v = t.v.toUpperCase();
      if (g === 5) t.ref = refOf(m[5]);
      out.push(t);
    }
    return out;
  }
  // "A$1:$B2" -> { a: {c, r, ac, ar}, b }  (c or r is null for whole rows / columns)
  function refOf(text) {
    const [a, b] = text.split(':').map(p => {
      const m = /^(\$?)([A-Z]*)(\$?)(\d*)$/i.exec(p);
      return { c: m[2] ? S.colIndex(m[2]) : null, r: m[4] ? +m[4] - 1 : null, ac: !!(m[2] && m[1]), ar: m[2] ? !!m[3] : !!(m[1] || m[3]) };
    });
    return { a, b: b || null };
  }
  const partText = p => (p.c != null ? (p.ac ? '$' : '') + S.colName(p.c) : '') + (p.r != null ? (p.ar ? '$' : '') + (p.r + 1) : '');
  function bounds(ref) {   // normalized cell box, or null when (partly) outside the sheet
    const a = ref.a, b = ref.b || a;
    const r1 = Math.min(a.r ?? 0, b.r ?? 0), r2 = a.r == null ? S.rows - 1 : Math.max(a.r, b.r);
    const c1 = Math.min(a.c ?? 0, b.c ?? 0), c2 = a.c == null ? S.cols - 1 : Math.max(a.c, b.c);
    return r1 < 0 || c1 < 0 || r2 >= S.rows || c2 >= S.cols ? null : { r1, c1, r2, c2 };
  }

  // ---------- parser: tokens -> AST (throws SYNTAX) ----------
  const SYNTAX = { syntax: true };
  function parse(src) {
    const toks = tokenize(src); let i = 0;
    if (toks.some(t => t.k === 'bad')) throw SYNTAX;
    const isOp = (...ops) => toks[i] && toks[i].k === 'op' && ops.includes(toks[i].v);
    const expect = v => isOp(v) ? i++ : fail(SYNTAX);
    const level = (sub, ops) => () => { let a = sub(); while (isOp(...ops)) { const op = toks[i++].v; a = { t: 'bin', op, a, b: sub() }; } return a; };
    const pow = level(unary, ['^']), mul = level(pow, ['*', '/']), add = level(mul, ['+', '-']);
    const cat = level(add, ['&']), expr = level(cat, ['=', '<>', '<', '>', '<=', '>=']);
    function unary() {
      if (isOp('-', '+')) { const op = toks[i++].v; return { t: 'un', op, a: unary() }; }
      let a = primary();
      while (isOp('%')) { i++; a = { t: 'pct', a }; }
      return a;
    }
    function primary() {
      const t = toks[i++] || fail(SYNTAX), u = t.v.toUpperCase();
      switch (t.k) {
        case 'num': return { t: 'lit', v: +t.v };
        case 'str': case 'err': return { t: 'lit', v: t.v };
        case 'ref': return { t: 'ref', ref: t.ref };
        case 'name': return u === 'TRUE' || u === 'FALSE' ? { t: 'lit', v: u === 'TRUE' } : { t: 'lit', v: '#NAME?' };
        case 'fn': {
          expect('('); const args = [];
          if (isOp(')')) i++;
          else { do args.push(isOp(',', ')') ? { t: 'lit', v: null } : expr()); while (isOp(',') && ++i); expect(')'); }
          return { t: 'fn', name: u, args };
        }
        case 'op': if (t.v === '(') { const e = expr(); expect(')'); return e; }
      }
      throw SYNTAX;
    }
    const ast = expr();
    if (i < toks.length) throw SYNTAX;
    return ast;
  }

  // ---------- values & coercion ----------
  class Rng {   // a reference result; consumers decide whether they need one value or all cells
    constructor(b, ctx) { Object.assign(this, b); this.ctx = ctx; }
    each(fn) { for (let r = this.r1; r <= this.r2; r++) for (let c = this.c1; c <= this.c2; c++) fn(this.ctx.cell(r, c), r - this.r1, c - this.c1); }
    vals() { const out = []; this.each(v => out.push(v)); return out; }
  }
  // A multi-cell range used as one value is #VALUE! (Sheets would spill an array; we don't support arrays).
  const sc = v => v instanceof Rng ? (v.r1 === v.r2 && v.c1 === v.c2 ? v.ctx.cell(v.r1, v.c1) : '#VALUE!') : v;
  function num(v) {
    v = sc(v);
    if (typeof v === 'number') return v;
    if (v == null || v === '') return 0;
    if (typeof v === 'boolean') return +v;
    if (isErr(v)) throw v;
    const l = lit(v).v;
    return typeof l === 'number' ? l : fail('#VALUE!');
  }
  function txt(v) {
    v = sc(v);
    if (isErr(v)) throw v;
    return v == null ? '' : typeof v === 'number' ? numText(v) : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : v;
  }
  function truth(v) {
    v = sc(v);
    if (isErr(v)) throw v;
    if (typeof v === 'string' && v !== '') { const u = v.toUpperCase(); return u === 'TRUE' || (u === 'FALSE' ? false : fail('#VALUE!')); }
    return !!v;
  }
  const rank = v => typeof v === 'number' ? 0 : typeof v === 'string' ? 1 : 2;   // Sheets: numbers < text < booleans
  function cmp(a, b) {
    a = sc(a); b = sc(b);
    if (isErr(a)) throw a; if (isErr(b)) throw b;
    const blank = (v, o) => typeof o === 'number' ? 0 : typeof o === 'boolean' ? false : '';
    if (a == null || a === '') a = blank(a, b);
    if (b == null || b === '') b = blank(b, a);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if (typeof a === 'string') { a = a.toLowerCase(); b = b.toLowerCase(); } else if (typeof a === 'number') { a = fix(a); b = fix(b); }
    return a < b ? -1 : a > b ? 1 : 0;
  }
  const pow = (a, b) => { const x = num(a), y = num(b); if (x === 0 && y < 0) throw '#DIV/0!'; const r = x ** y; return isNaN(r) ? fail('#NUM!') : r; };
  const OPS = {
    '+': (a, b) => num(a) + num(b), '-': (a, b) => num(a) - num(b), '*': (a, b) => num(a) * num(b),
    '/': (a, b) => { const x = num(a), y = num(b); return y === 0 ? fail('#DIV/0!') : x / y; },
    '^': pow, '&': (a, b) => txt(a) + txt(b),
    '=': (a, b) => cmp(a, b) === 0, '<>': (a, b) => cmp(a, b) !== 0, '<': (a, b) => cmp(a, b) < 0,
    '>': (a, b) => cmp(a, b) > 0, '<=': (a, b) => cmp(a, b) <= 0, '>=': (a, b) => cmp(a, b) >= 0,
  };

  // ---------- AST -> closures (ctx) => value | Rng ----------
  function compile(n) {
    switch (n.t) {
      case 'lit': { const v = n.v; return () => v; }
      case 'ref': { const ref = n.ref; return ctx => { const b = bounds(ref); return b ? new Rng(b, ctx) : '#REF!'; }; }
      case 'un': { const a = compile(n.a); return n.op === '-' ? ctx => -num(a(ctx)) : ctx => num(a(ctx)); }
      case 'pct': { const a = compile(n.a); return ctx => num(a(ctx)) / 100; }
      case 'bin': {
        const a = compile(n.a), b = compile(n.b), op = OPS[n.op];
        return ctx => { const v = op(a(ctx), b(ctx)); return typeof v === 'number' && !isFinite(v) ? fail('#NUM!') : v; };
      }
      case 'fn': {
        const F = FN[n.name];
        if (!F) return () => '#NAME?';
        if (n.args.length < F.min || n.args.length > F.max) return () => '#N/A';
        const args = n.args.map(compile);
        if (F.lazy) return ctx => F.fn(args, ctx);
        return ctx => {
          const vs = args.map(a => a(ctx));
          if (!F.errs) for (const v of vs) if (isErr(v)) throw v;
          return F.fn(vs, ctx);
        };
      }
    }
  }

  // ---------- functions ----------
  function nums(args) {   // ranges contribute only real numbers; direct arguments are coerced
    const out = [];
    for (const a of args) {
      if (a instanceof Rng) a.each(v => { if (isErr(v)) throw v; if (typeof v === 'number') out.push(v); });
      else if (a != null) out.push(num(a));
    }
    return out;
  }
  function bools(args) {
    const out = [];
    for (const a of args) {
      if (a instanceof Rng) a.each(v => { if (isErr(v)) throw v; if (typeof v === 'number' || typeof v === 'boolean') out.push(!!v); });
      else if (a != null) out.push(truth(a));
    }
    return out.length ? out : fail('#VALUE!');
  }
  const flat = a => a instanceof Rng ? a.vals() : [a];
  const sum = xs => xs.reduce((s, x) => s + x, 0);
  const round = (x, p, mode) => {   // half away from zero ('round'), or towards/away for ROUNDDOWN/UP
    p = Math.trunc(p); const y = Math[mode](fix(Math.abs(x) * 10 ** p));
    return Math.sign(x) * (p >= 0 ? y / 10 ** p : y * 10 ** -p);
  };
  function wild(p) {   // Sheets criteria wildcards: * any run, ? one char, ~ escapes
    return new RegExp('^' + p.replace(/~([*?~])|([*?])|[.+^${}()|[\]\\]/g, (m, esc, w) =>
      esc ? '\\' + esc : w === '*' ? '[\\s\\S]*' : w === '?' ? '[\\s\\S]' : '\\' + m) + '$', 'i');
  }
  function criterion(c) {
    c = sc(c);
    if (isErr(c)) throw c;
    if (typeof c === 'number') return v => typeof v === 'number' && fix(v) === fix(c);
    if (typeof c === 'boolean') return v => v === c;
    const [, op = '', rhs] = /^(<=|>=|<>|<|>|=)?([\s\S]*)$/.exec(c || ''), n = rhs.trim() ? lit(rhs).v : null;
    if (typeof n === 'number') {
      const test = OPS[op || '='];
      return v => typeof v === 'number' ? test(v, n) : op === '<>';
    }
    if (rhs === '' && op !== '<' && op !== '>' && op !== '<=' && op !== '>=') return op === '<>' ? v => v != null && v !== '' : v => v == null || v === '';
    if (op === '' || op === '=' || op === '<>') {
      const re = wild(rhs), eq = v => (typeof v === 'string' || typeof v === 'boolean') && re.test(txt(v));
      return op === '<>' ? v => !eq(v) : eq;
    }
    const test = OPS[op];
    return v => typeof v === 'string' && !isErr(v) && test(v, rhs);
  }
  function vlookup([key, rng, index, sorted]) {
    key = sc(key);
    if (isErr(key)) throw key;
    if (!(rng instanceof Rng)) throw '#N/A';
    const k = Math.trunc(num(index)), approx = sorted === undefined || truth(sorted);
    if (k < 1) throw '#VALUE!';
    if (k > rng.c2 - rng.c1 + 1) throw '#REF!';
    let hit = -1;
    for (let r = rng.r1; r <= rng.r2; r++) {
      const v = rng.ctx.cell(r, rng.c1);
      if (v == null || v === '' || isErr(v) || rank(v) !== rank(key)) continue;
      const d = cmp(v, key);
      if (!approx) { if (d === 0) { hit = r; break; } } else if (d <= 0) hit = r; else break;
    }
    return hit < 0 ? fail('#N/A') : rng.ctx.cell(hit, rng.c1 + k - 1);
  }
  const N = a => num(a), T = a => txt(a);
  const V = 'value1, [value2, ...]';
  // [name, args, description, minArgs, maxArgs, fn(args, ctx), flags]  flags: lazy (args are closures), errs (handles error args)
  const DEFS = [
    ['SUM', V, 'Returns the sum of a series of numbers and/or cells.', 1, INF, a => sum(nums(a))],
    ['AVERAGE', V, 'Returns the numerical average value in a dataset, ignoring text.', 1, INF, a => { const x = nums(a); return x.length ? sum(x) / x.length : fail('#DIV/0!'); }],
    ['MIN', V, 'Returns the minimum value in a numeric dataset.', 1, INF, a => { const x = nums(a); return x.length ? x.reduce((m, v) => Math.min(m, v)) : 0; }],
    ['MAX', V, 'Returns the maximum value in a numeric dataset.', 1, INF, a => { const x = nums(a); return x.length ? x.reduce((m, v) => Math.max(m, v)) : 0; }],
    ['COUNT', V, 'Returns a count of the number of numeric values in a dataset.', 1, INF,
      a => a.reduce((n, x) => n + (x instanceof Rng ? x.vals().filter(v => typeof v === 'number').length : typeof x === 'number' || (typeof x === 'string' && typeof lit(x).v === 'number') ? 1 : 0), 0), { errs: true }],
    ['COUNTA', V, 'Returns a count of the number of values in a dataset.', 1, INF,
      a => a.reduce((n, x) => n + (x instanceof Rng ? x.vals().filter(v => v != null && v !== '').length : x != null ? 1 : 0), 0), { errs: true }],
    ['ROUND', 'value, [places]', 'Rounds a number to a certain number of decimal places according to standard rules.', 1, 2, a => round(N(a[0]), a.length > 1 ? N(a[1]) : 0, 'round')],
    ['ROUNDUP', 'value, [places]', 'Rounds a number to a certain number of decimal places, always rounding up to the next valid increment.', 1, 2, a => round(N(a[0]), a.length > 1 ? N(a[1]) : 0, 'ceil')],
    ['ROUNDDOWN', 'value, [places]', 'Rounds a number to a certain number of decimal places, always rounding down to the next valid increment.', 1, 2, a => round(N(a[0]), a.length > 1 ? N(a[1]) : 0, 'floor')],
    ['INT', 'value', 'Rounds a number down to the nearest integer that is less than or equal to it.', 1, 1, a => Math.floor(N(a[0]))],
    ['ABS', 'value', 'Returns the absolute value of a number.', 1, 1, a => Math.abs(N(a[0]))],
    ['SQRT', 'value', 'Returns the positive square root of a positive number.', 1, 1, a => { const x = N(a[0]); return x < 0 ? fail('#NUM!') : Math.sqrt(x); }],
    ['POWER', 'base, exponent', 'Returns a number raised to a power.', 2, 2, a => pow(a[0], a[1])],
    ['PRODUCT', 'factor1, [factor2, ...]', 'Returns the result of multiplying a series of numbers together.', 1, INF, a => nums(a).reduce((p, x) => p * x, 1)],
    ['MOD', 'dividend, divisor', 'Returns the result of the modulo operator, the remainder after a division operation.', 2, 2,
      a => { const x = N(a[0]), y = N(a[1]); return y === 0 ? fail('#DIV/0!') : x - y * Math.floor(x / y); }],
    ['IF', 'logical_expression, value_if_true, [value_if_false]', 'Returns one value if a logical expression is TRUE and another if it is FALSE.', 2, 3,
      (a, ctx) => truth(a[0](ctx)) ? a[1](ctx) : a[2] ? a[2](ctx) : false, { lazy: true }],
    ['IFERROR', 'value, [value_if_error]', 'Returns the first argument if it is not an error value, otherwise returns the second argument if present, or a blank if the second argument is absent.', 1, 2,
      (a, ctx) => { let v; try { v = sc(a[0](ctx)); } catch (e) { if (!isErr(e)) throw e; v = e; } return isErr(v) ? (a[1] ? a[1](ctx) : '') : v; }, { lazy: true }],
    ['AND', 'logical_expression1, [logical_expression2, ...]', 'Returns true if all of the provided arguments are logically true, and false if any of the provided arguments are logically false.', 1, INF, a => bools(a).every(Boolean)],
    ['OR', 'logical_expression1, [logical_expression2, ...]', 'Returns true if any of the provided arguments are logically true, and false if all of the provided arguments are logically false.', 1, INF, a => bools(a).some(Boolean)],
    ['NOT', 'logical_expression', 'Returns the opposite of a logical value - NOT(TRUE) returns FALSE; NOT(FALSE) returns TRUE.', 1, 1, a => !truth(a[0])],
    ['COUNTIF', 'range, criterion', 'Returns a conditional count across a range.', 2, 2, a => flat(a[0]).filter(criterion(a[1])).length],
    ['SUMIF', 'range, criterion, [sum_range]', 'Returns a conditional sum across a range.', 2, 3, ([range, crit, sr], ctx) => {
      const test = criterion(crit), rows = S.rows, colsN = S.cols; let s = 0;
      const add = v => { if (isErr(v)) throw v; if (typeof v === 'number') s += v; };
      const visit = (v, i, j) => { if (!test(v)) return; if (!(sr instanceof Rng)) return add(sr === undefined ? v : null);
        const r = sr.r1 + i, c = sr.c1 + j; if (r < rows && c < colsN) add(ctx.cell(r, c)); };
      if (range instanceof Rng) range.each(visit); else visit(range, 0, 0);
      return s;
    }],
    ['CONCAT', 'value1, value2', 'Returns the concatenation of two values. Equivalent to the `&` operator.', 2, INF, a => a.flatMap(flat).map(T).join('')],
    ['CONCATENATE', 'string1, [string2, ...]', 'Appends strings to one another.', 1, INF, a => a.flatMap(flat).map(T).join('')],
    ['LEN', 'text', 'Returns the length of a string.', 1, 1, a => T(a[0]).length],
    ['UPPER', 'text', 'Converts a specified string to uppercase.', 1, 1, a => T(a[0]).toUpperCase()],
    ['LOWER', 'text', 'Converts a specified string to lowercase.', 1, 1, a => T(a[0]).toLowerCase()],
    ['TRIM', 'text', 'Removes leading, trailing, and repeated spaces in text.', 1, 1, a => T(a[0]).replace(/^ +| +$/g, '').replace(/ {2,}/g, ' ')],
    ['LEFT', 'string, [number_of_characters]', 'Returns a substring from the beginning of a specified string.', 1, 2,
      a => { const n = a.length > 1 ? Math.trunc(N(a[1])) : 1; return n < 0 ? fail('#VALUE!') : T(a[0]).slice(0, n); }],
    ['RIGHT', 'string, [number_of_characters]', 'Returns a substring from the end of a specified string.', 1, 2,
      a => { const n = a.length > 1 ? Math.trunc(N(a[1])) : 1, s = T(a[0]); return n < 0 ? fail('#VALUE!') : n ? s.slice(-n) : ''; }],
    ['MID', 'string, starting_at, extract_length', 'Returns a segment of a string.', 3, 3,
      a => { const st = Math.trunc(N(a[1])), n = Math.trunc(N(a[2])); return st < 1 || n < 0 ? fail('#VALUE!') : T(a[0]).substr(st - 1, n); }],
    ['TODAY', '', 'Returns the current date as a date value.', 0, 0, () => Math.floor(S.dateToSerial(new Date()))],
    ['NOW', '', 'Returns the current date and time as a date value.', 0, 0, () => S.dateToSerial(new Date())],
    ['VLOOKUP', 'search_key, range, index, [is_sorted]', 'Vertical lookup. Searches down the first column of a range for a key and returns the value of a specified cell in the row found.', 3, 4, vlookup],
  ];
  const FN = {};
  for (const [name, args, desc, min, max, fn, flags] of DEFS) FN[name] = { name, args, desc, min, max, fn, ...flags };
  const FUNCS = DEFS.map(([name, args, desc]) => ({ name, args, desc })).sort((a, b) => a.name < b.name ? -1 : 1);

  // ---------- implicit result formats (TODAY -> date, =A1*2 with A1 currency -> currency, ...) ----------
  const KEEP_FMT = new Set(['SUM', 'AVERAGE', 'MIN', 'MAX', 'ROUND', 'ROUNDUP', 'ROUNDDOWN', 'INT', 'ABS', 'IFERROR']);
  const isDate = f => f === 'date' || f === 'datetime';
  function fmtOf(n, ctx) {
    switch (n.t) {
      case 'ref': {
        const b = bounds(n.ref); if (!b) return null;
        for (let r = b.r1; r <= b.r2; r++) for (let c = b.c1; c <= b.c2; c++) { const f = ctx.fmt(cn(c) + (r + 1)); if (f) return f; }
        return null;
      }
      case 'un': return fmtOf(n.a, ctx);
      case 'bin': {
        if (!'+-*/'.includes(n.op)) return null;
        const a = fmtOf(n.a, ctx), b = fmtOf(n.b, ctx);
        if (n.op === '+') return a || b;
        if (n.op === '-') return isDate(a) && isDate(b) ? null : a || b;
        return a === 'currency' || b === 'currency' ? 'currency' : null;
      }
      case 'fn':
        if (n.name === 'TODAY') return 'date';
        if (n.name === 'NOW') return 'datetime';
        if (n.name === 'IF') return (n.args[1] && fmtOf(n.args[1], ctx)) || (n.args[2] && fmtOf(n.args[2], ctx)) || null;
        return KEEP_FMT.has(n.name) && n.args[0] ? fmtOf(n.args[0], ctx) : null;
    }
    return null;
  }

  // ---------- evaluation ----------
  const compiledCache = new Map();
  function compiled(raw) {
    let c = compiledCache.get(raw);
    if (!c) {
      try { const ast = parse(raw.slice(1)); c = { ast, f: compile(ast) }; } catch (e) { c = {}; }
      if (compiledCache.size > 20000) compiledCache.clear();
      compiledCache.set(raw, c);
    }
    return c;
  }
  // One raw string -> { v, fmt }. Errors thrown anywhere below become the cell's value.
  function compute(raw, ctx, style) {
    if (raw == null || raw === '') return { v: '' };
    raw = String(raw);
    if (style && style.fmt === 'text') return { v: raw };
    if (raw[0] !== '=') return lit(raw);
    const c = compiled(raw);
    if (!c.f) return { v: '#ERROR!' };
    try {
      let v = sc(c.f(ctx));
      if (v == null) v = '';
      if (typeof v !== 'number') return { v };
      if (!isFinite(v)) throw '#NUM!';
      return { v: fix(v), fmt: fmtOf(c.ast, ctx) };
    } catch (e) {
      if (e instanceof RangeError || e.defer) throw e;   // stack trouble: handled by ctx.settle
      return { v: isErr(e) ? e : '#ERROR!' };
    }
  }
  // Evaluation context for one pass: memoized cell values (null = empty) + cycle detection.
  // Dependency chains deeper than MAX_DEPTH are not recursed into: the deep cell is "deferred", evaluated
  // first from the top of the stack by settle(), and the original evaluation is retried (trampoline).
  const MAX_DEPTH = 200;
  function makeCtx(vals, fmts, visiting) {
    let depth = 0;
    const ctx = {
      fmt: id => fmts[id],
      cell(r, c) {
        const id = cn(c) + (r + 1);
        let v = vals[id];
        if (v === undefined) {
          const cell = S.cells[id];
          if (!cell || cell.raw == null || cell.raw === '') return null;
          if (visiting.has(id)) throw '#REF!';   // circular dependency
          v = ctx.run(id, cell);
        }
        return v === '' ? null : v;
      },
      run(id, cell) {
        if (depth >= MAX_DEPTH) throw { defer: id };
        depth++; visiting.add(id);
        try { const res = compute(cell.raw, ctx, cell.s); vals[id] = res.v; if (res.fmt) fmts[id] = res.fmt; return res.v; }
        finally { depth--; visiting.delete(id); }
      },
      settle(fn) {
        const todo = [];
        for (;;) {
          try {
            if (!todo.length) return fn();
            const id = todo[todo.length - 1];
            if (vals[id] === undefined) ctx.run(id, S.cells[id]);
            todo.pop();
          } catch (e) {
            if (!e || !e.defer) throw e;
            if (todo.includes(e.defer)) vals[e.defer] = '#REF!';   // a long circular chain
            else todo.push(e.defer);
          }
        }
      },
    };
    return ctx;
  }
  function recalc() {
    const vals = {}, fmts = {}, ctx = makeCtx(vals, fmts, new Set());
    const ids = Object.keys(S.cells).map(id => [id, S.parse(id)]).filter(x => x[1]).sort((a, b) => a[1].r - b[1].r || a[1].c - b[1].c);
    for (const [id] of ids) {
      const cell = S.cells[id];
      if (vals[id] !== undefined || cell.raw == null || cell.raw === '') continue;
      try { ctx.settle(() => ctx.run(id, cell)); } catch (e) { vals[id] = '#ERROR!'; }   // never expected
    }
    S.values = vals; S.valueFmt = fmts;
    S.emit('recalc');
  }
  function evaluate(raw, atId) {
    const ctx = makeCtx({}, {}, new Set(atId ? [atId] : []));
    try { return ctx.settle(() => compute(raw, ctx, atId && S.cells[atId] ? S.cells[atId].s : null).v); } catch (e) { return '#ERROR!'; }
  }

  // ---------- reference rewriting ----------
  function rewrite(raw, fn) {   // fn(ref, tokenText) -> replacement text | null (keep)
    if (typeof raw !== 'string' || raw[0] !== '=') return raw;
    const body = raw.slice(1); let out = '', last = 0;
    for (const t of tokenize(body)) {
      if (t.k !== 'ref') continue;
      const s = fn(t.ref);
      if (s != null) { out += body.slice(last, t.s) + s; last = t.e; }
    }
    return '=' + out + body.slice(last);
  }
  function offsetRefs(raw, dr, dc) {
    if (!dr && !dc) return raw;
    return rewrite(raw, ref => {
      const parts = [ref.a, ref.b].filter(Boolean).map(p => ({ ...p, r: p.r == null || p.ar ? p.r : p.r + dr, c: p.c == null || p.ac ? p.c : p.c + dc }));
      const out = parts.some(p => (p.r != null && (p.r < 0 || p.r >= S.rows)) || (p.c != null && (p.c < 0 || p.c >= S.cols)));
      return out ? '#REF!' : parts.map(partText).join(':');
    });
  }
  function shiftRefs(raw, axis, at, delta) {
    const k = axis === 'row' ? 'r' : 'c';
    return rewrite(raw, ref => {
      const a = ref.a, b = ref.b || a;
      if (a[k] == null) return null;   // a whole column is unaffected by row changes (and vice versa)
      const lo0 = Math.min(a[k], b[k]), hi0 = Math.max(a[k], b[k]), end = at - delta;
      const move = (x, isHi) => delta > 0 ? (x >= at ? x + delta : x) : x < at ? x : x >= end ? x + delta : isHi ? at - 1 : at;
      const lo = move(lo0, false), hi = move(hi0, true);
      if (hi < lo) return '#REF!';
      if (lo === lo0 && hi === hi0) return null;
      const swap = a[k] > b[k], na = { ...a, [k]: swap ? hi : lo };
      return ref.b ? partText(na) + ':' + partText({ ...b, [k]: swap ? lo : hi }) : partText(na);
    });
  }

  // ---------- editor UI: autocomplete dropdown + argument hint ----------
  let list = null, hint = null, ac = null;   // ac = { input, items, i, start, n }
  const div = cls => { const d = document.createElement('div'); d.className = cls; d.hidden = true; d.onmousedown = e => e.preventDefault(); document.body.appendChild(d); return d; };
  function place(el, input) {
    const r = input.getBoundingClientRect(); el.hidden = false;
    el.style.left = Math.max(4, Math.min(r.left, innerWidth - el.offsetWidth - 4)) + 'px';
    el.style.top = (r.bottom + 2 + el.offsetHeight > innerHeight ? Math.max(4, r.top - 2 - el.offsetHeight) : r.bottom + 2) + 'px';
  }
  function closeAll() { ac = null; if (list) list.hidden = true; if (hint) hint.hidden = true; }
  function attachEditor(input) {
    const update = () => suggest(input);
    input.addEventListener('input', update);
    input.addEventListener('click', update);
    input.addEventListener('keyup', e => { if (/^(Arrow(Left|Right)|Home|End)$/.test(e.key)) update(); });
    input.addEventListener('blur', closeAll);
    input.addEventListener('keydown', e => {
      if (!ac || ac.input !== input || list.hidden) return;
      const n = ac.items.length;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { ac.i = (ac.i + (e.key === 'ArrowDown' ? 1 : n - 1)) % n; renderList(); }
      else if (e.key === 'Enter' || e.key === 'Tab') accept(ac.i);
      else if (e.key === 'Escape') { ac = null; list.hidden = true; showHint(input); }
      else return;
      e.preventDefault(); e.stopImmediatePropagation();
    }, true);
  }
  function suggest(input) {
    const text = input.value, pos = input.selectionStart ?? text.length;
    if (text[0] !== '=' || input.selectionEnd !== pos) return closeAll();
    const before = text.slice(0, pos), m = /[A-Za-z][\w.]*$/.exec(before);
    const quoteOpen = (before.match(/"/g) || []).length % 2 === 1;
    if (m && !quoteOpen && /[=+\-*/^&(,<>%\s]/.test(before[m.index - 1]) && text[pos] !== '(') {
      const pre = m[0].toUpperCase(), items = FUNCS.filter(f => f.name.startsWith(pre)).slice(0, 8);
      if (items.length) {
        ac = { input, items, i: 0, start: m.index, n: pre.length };
        if (hint) hint.hidden = true;
        return renderList();
      }
    }
    ac = null; if (list) list.hidden = true;
    showHint(input);
  }
  function renderList() {
    list = list || div('ms-menu fx-ac');
    const { items, i, n } = ac;
    list.innerHTML = items.map((f, j) => `<div class="fx-ac-item${j === i ? ' fx-on' : ''}" data-i="${j}">` +
      `<div class="fx-ac-sig"><b>${f.name.slice(0, n)}</b>${f.name.slice(n)}<span class="fx-ac-args">(${f.args})</span></div>` +
      (j === i ? `<div class="fx-ac-desc">${f.desc}</div>` : '') + '</div>').join('');
    list.onclick = e => { const it = e.target.closest('.fx-ac-item'); if (it && ac) accept(+it.dataset.i); };
    list.onmousemove = e => { const it = e.target.closest('.fx-ac-item'); if (it && ac && +it.dataset.i !== ac.i) { ac.i = +it.dataset.i; renderList(); } };
    place(list, ac.input);
  }
  function accept(i) {
    const { input, items, start } = ac, f = items[i], v = input.value, pos = input.selectionStart;
    input.value = v.slice(0, start) + f.name + '(' + v.slice(pos);
    const p = start + f.name.length + 1;
    input.setSelectionRange(p, p);
    ac = null; list.hidden = true;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  // "SUM(value1, [value2, ...])" with the argument under the caret in bold
  function showHint(input) {
    const stack = []; let fn = null;
    for (const t of tokenize(input.value.slice(1, input.selectionStart))) {
      if (t.k === 'fn') { fn = t.v.toUpperCase(); continue; }
      if (t.k === 'op' && t.v === '(') stack.push({ name: fn, arg: 0 });
      else if (t.k === 'op' && t.v === ',' && stack.length) stack[stack.length - 1].arg++;
      else if (t.k === 'op' && t.v === ')') stack.pop();
      fn = null;
    }
    const top = stack[stack.length - 1], f = top && FN[top.name];
    if (!f || input.value[0] !== '=') { if (hint) hint.hidden = true; return; }
    const parts = f.args.match(/\[[^\]]*\]|[^,\s][^,]*/g) || [], last = parts.length - 1;
    const k = top.arg > last && /\.\.\./.test(parts[last] || '') ? last : top.arg;
    hint = hint || div('fx-hint');
    hint.innerHTML = `${f.name}(${parts.map((p, j) => j === k ? `<b>${p}</b>` : p).join(', ')})`;
    place(hint, input);
  }

  // ---------- colored boxes over the cells referenced by the formula being edited ----------
  const COLORS = ['#1a73e8', '#d93025', '#9334e6', '#188038', '#e37400', '#007b83', '#c5221f', '#b06000'];
  let marks = [];
  function highlight(ed) {
    marks.forEach(m => m.remove()); marks = [];
    const G = typeof Grid !== 'undefined' ? Grid : typeof window !== 'undefined' && window.Grid;   // top-level const isn't on window
    if (!ed || !G || !G.overlay || typeof G.cellRect !== 'function' || typeof ed.text !== 'string' || ed.text[0] !== '=') return;
    const colorOf = new Map();
    for (const t of tokenize(ed.text.slice(1))) {
      if (t.k !== 'ref') continue;
      const key = t.v.toUpperCase().replace(/\$/g, '');
      if (colorOf.has(key)) continue;   // same ref text -> one box in one color
      colorOf.set(key, COLORS[colorOf.size % COLORS.length]);
      const b = bounds(t.ref); if (!b) continue;
      const p = G.cellRect(b.r1, b.c1), q = G.cellRect(b.r2, b.c2), col = colorOf.get(key);
      const x = Math.min(p.x, q.x), y = Math.min(p.y, q.y);
      const m = document.createElement('div');
      m.className = 'fx-ref';
      Object.assign(m.style, { left: x + 'px', top: y + 'px', width: Math.max(p.x + p.w, q.x + q.w) - x + 'px', height: Math.max(p.y + p.h, q.y + q.h) - y + 'px', borderColor: col, background: col + '1f' });
      G.overlay.appendChild(m); marks.push(m);
    }
  }

  return {
    FUNCS, recalc, evaluate, offsetRefs, shiftRefs, attachEditor, tokenize,
    init() {
      S.hooks.shiftRefs = shiftRefs;
      S.on('change', recalc);
      S.on('editing', ed => { highlight(ed); if (!ed) closeAll(); });
      recalc();
    },
  };
})();