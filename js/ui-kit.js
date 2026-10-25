// Shared UI helpers: icons and a Google-Sheets-style dropdown/context menu used by every part.
const icon = (name, cls = '') => `<span class="msi ${cls}">${name}</span>`;

// Menu.open(items, x, y, opts) — items: [{ label, icon, shortcut, cmd | action, items (submenu), checked, disabled, soon }, { sep: true }]
//   cmd: 'bold' -> Sheet.run('bold') · action: fn · soon: true -> "Coming soon" toast
//   opts: { onClose, className, anchor (element shown as "open" while the menu is up) }
const Menu = {
  stack: [],
  open(items, x, y, opts = {}) {
    this.close();
    this.opts = opts; opts.anchor?.classList.add('ms-open');
    this._build(items, x, y, 0);
    this._timer = setTimeout(() => {
      document.addEventListener('mousedown', this._outside = e => { if (!e.target.closest('.ms-menu') && !(opts.anchor && opts.anchor.contains(e.target))) this.close(); });
      document.addEventListener('keydown', this._key = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.close(); Sheet.emit('focusgrid'); } }, true);
    });
  },
  get isOpen() { return this.stack.length > 0; },
  close() {
    if (!this.stack.length) return;
    clearTimeout(this._timer);
    this.stack.forEach(m => m.remove()); this.stack = [];
    document.removeEventListener('mousedown', this._outside); document.removeEventListener('keydown', this._key, true);
    this.opts?.anchor?.classList.remove('ms-open');
    const cb = this.opts?.onClose; this.opts = null; cb && cb();
  },
  _build(items, x, y, level) {
    this.stack.splice(level).forEach(m => m.remove());
    const m = document.createElement('div');
    m.className = 'ms-menu ' + (level === 0 ? this.opts?.className || '' : '');
    for (const it of items) {
      if (it.sep) { m.insertAdjacentHTML('beforeend', '<div class="ms-sep"></div>'); continue; }
      const el = document.createElement('div');
      el.className = 'ms-item' + (it.disabled ? ' ms-disabled' : '');
      el.innerHTML = `<span class="ms-icon">${it.checked ? icon('check') : it.icon ? icon(it.icon) : ''}</span>` +
        `<span class="ms-label">${it.label}</span><span class="ms-shortcut">${it.shortcut || ''}</span>` +
        (it.items ? icon('arrow_right', 'ms-sub') : '');
      el.onmouseenter = () => {
        m.querySelectorAll('.ms-active').forEach(a => a.classList.remove('ms-active'));
        if (it.items) { el.classList.add('ms-active'); const b = el.getBoundingClientRect(); this._build(it.items, b.right - 2, b.top - 6, level + 1); }
        else this.stack.splice(level + 1).forEach(s => s.remove());
      };
      el.onmousedown = e => e.preventDefault();   // keep focus where it is
      el.onclick = () => {
        if (it.disabled || it.items) return;
        this.close();
        if (it.soon) Sheet.soon(it.label); else if (it.cmd) Sheet.run(it.cmd, it.arg); else it.action?.();
        Sheet.emit('focusgrid');
      };
      m.appendChild(el);
    }
    document.body.appendChild(m);
    const w = m.offsetWidth, h = m.offsetHeight;
    m.style.left = Math.max(4, Math.min(x, innerWidth - w - 4)) + 'px';
    m.style.top = Math.max(4, Math.min(y, innerHeight - h - 4)) + 'px';
    this.stack[level] = m;
    return m;
  },
};