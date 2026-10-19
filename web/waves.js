// ============================================================================
// waves.js - a small GTKWave-style waveform viewer.
// Sources:
//   WaveViewer.fromVcd(window.VERILOG_WAVES)  the real Icarus VCD dump
//   WaveViewer.live(widths)                   signals recorded from the JS model
// Both use the Verilog hierarchical names (tb.dut.u_car0.state, ...).
// ============================================================================
(function (root) {
  'use strict';
  const ROW = 22, AXIS = 22, PERIOD = 10;           // clk period in ns (tb: always #5)
  const STATE = ['IDLE', 'MOVE_UP', 'MOVE_DN', 'DOOR'], DIR = ['NONE', 'UP', 'DN', '?'];

  const leafOf = p => p.slice(p.lastIndexOf('.') + 1);
  function fmt(path, width, v, long) {
    if (v === undefined) return '';
    if (v < 0) return 'x';
    const leaf = leafOf(path);
    if (width === 2 && /^(state\d?|cst)$/.test(leaf)) return STATE[v];
    if (width === 2 && /(^dir\d?$|^ndir\d$|next_dir|^[ce]?n?dir$)/.test(leaf)) return DIR[v];
    if (width === 1) return String(v);
    if (width === 8) return (long ? "8'h" : '') + v.toString(16).padStart(2, '0');
    return String(v);
  }

  // last change index at or before t
  function idxAt(ch, t) {
    let lo = 0, hi = ch.t.length - 1, ans = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (ch.t[m] <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
    return ans;
  }
  const clockAt = t => (t < 0 ? 0 : Math.floor(t / (PERIOD / 2)) % 2);
  function valueAt(sig, t) {
    if (sig.clock) return clockAt(t);
    const i = idxAt(sig.ch, t);
    return i < 0 ? undefined : sig.ch.v[i];
  }

  // ---------------- sources ----------------
  function fromVcd(W) {
    const chans = W.data.map(d => {
      const t = [], v = [];
      let acc = 0;
      for (let i = 0; i < d.length; i += 2) { acc += d[i]; t.push(+acc.toFixed(3)); v.push(d[i + 1]); }
      return { t, v };
    });
    const list = W.signals.map(([path, width, ci]) => ({ path, width, ch: chans[ci], clock: leafOf(path) === 'clk' }));
    return { label: 'build/elevator.vcd · Icarus Verilog', list, byPath: new Map(list.map(s => [s.path, s])), end: () => W.end, replay: true };
  }

  // bit width of a signal: from the Verilog waveform if it is loaded, else guessed from the name
  const vcdWidth = new Map(((root.VERILOG_WAVES && root.VERILOG_WAVES.signals) || []).map(([p, w]) => [p, w]));
  function guessWidth(path) {
    if (vcdWidth.has(path)) return vcdWidth.get(path);
    const l = leafOf(path);
    if (/^(clk|rst|en|valid|door\d?|door_open|call_\w+|\w+_valid|pick_up|pick_car1)$/.test(l)) return 1;
    if (/^(floor\d?|pick_floor|up_floor|dn_floor|dist\d|a|b|d|w)$/.test(l)) return 3;
    if (/^(state\d?|dir\d?|next_dir\d?)$/.test(l)) return 2;
    if (/^timer\d?$/.test(l)) return 4;
    return 8;
  }

  function live(widthOf) {
    const byPath = new Map(), list = [];
    let end = 0;
    const get = path => {
      let s = byPath.get(path);
      if (!s) {
        s = { path, width: (widthOf && widthOf(path)) || guessWidth(path), ch: { t: [], v: [] }, clock: leafOf(path) === 'clk' };
        byPath.set(path, s); list.push(s);
      }
      return s;
    };
    get('tb.clk');
    const src = {
      label: 'live · JS model of the RTL', list, byPath, replay: false,
      end: () => end,
      record(values, t) {
        for (const [path, v] of Object.entries(values)) {
          const ch = get(path).ch, n = ch.v.length;
          if (n && ch.v[n - 1] === v) continue;
          if (n && ch.t[n - 1] === t) ch.v[n - 1] = v;
          else { ch.t.push(t); ch.v.push(v); }
        }
        if (t > end) end = t;
      },
      setEnd(t) { if (t > end) end = t; },
    };
    return src;
  }

  // ---------------- viewer ----------------
  const PRESETS = {
    'Top I/O': ['tb.clk', 'tb.rst', 'tb.hall_up_btn', 'tb.hall_dn_btn', 'tb.car_btn0', 'tb.car_btn1',
      'tb.floor0', 'tb.state0', 'tb.door0', 'tb.floor1', 'tb.state1', 'tb.door1', 'tb.up_pend', 'tb.dn_pend'],
    'Car A': ['tb.clk'].concat(['state', 'floor', 'dir', 'next_dir', 'timer', 'car_calls', 'hall_up_asg', 'hall_dn_asg',
      'targets', 'call_here', 'call_above', 'call_below', 'door_open'].map(s => 'tb.dut.u_car0.' + s)),
    'Car B': ['tb.clk'].concat(['state', 'floor', 'dir', 'next_dir', 'timer', 'car_calls', 'hall_up_asg', 'hall_dn_asg',
      'targets', 'call_here', 'call_above', 'call_below', 'door_open'].map(s => 'tb.dut.u_car1.' + s)),
    'Dispatcher': ['tb.clk', 'tb.hall_up_btn', 'tb.hall_dn_btn'].concat(['up_pend', 'up_asgd', 'up_owner', 'dn_pend', 'dn_asgd',
      'dn_owner', 'free_up', 'free_dn', 'pick_valid', 'pick_up', 'pick_floor', 'dist0', 'dist1', 'pick_car1',
      'served_up', 'served_dn'].map(s => 'tb.dut.u_dispatch.' + s)),
  };

  function create(host) {
    host.innerHTML = `
      <div class="wave-tools">
        <div class="seg wave-presets">${Object.keys(PRESETS).map(p => `<button data-p="${p}">${p}</button>`).join('')}</div>
        <input class="wave-add" list="waveSigList" placeholder="+ add signal (type to search)" spellcheck="false">
        <datalist id="waveSigList"></datalist>
        <span class="wave-zoom">
          <button class="btn" data-z="out" title="Zoom out">−</button>
          <button class="btn" data-z="in" title="Zoom in">+</button>
          <button class="btn" data-z="fit" title="Show everything">Fit</button>
          <button class="btn" data-z="follow" title="Keep the current time in view">Follow</button>
        </span>
      </div>
      <div class="wave-body">
        <div class="wave-names"></div>
        <div class="wave-wrap"><canvas></canvas></div>
      </div>`;
    const namesEl = host.querySelector('.wave-names');
    const wrap = host.querySelector('.wave-wrap');
    const canvas = host.querySelector('canvas');
    const ctx = canvas.getContext('2d');
    const addEl = host.querySelector('.wave-add');
    const listEl = host.querySelector('#waveSigList');
    const followBtn = host.querySelector('[data-z="follow"]');

    let src = null, shown = [], preset = 'Top I/O';
    let scale = 1;           // px per ns
    let viewStart = 0;       // ns at left edge
    let follow = true;
    let cursor = 0, marker = null;
    let rowEls = [];
    const api = { onClick: null };

    function width() { return wrap.clientWidth; }
    function setFollow(f) { follow = f; followBtn.classList.toggle('on', f); }

    function applyPreset(name) {
      preset = name;
      host.querySelectorAll('.wave-presets button').forEach(b => b.classList.toggle('on', b.dataset.p === name));
      setShown(PRESETS[name]);
    }
    function setShown(paths) {
      shown = paths.filter(p => src && src.byPath.has(p));
      buildNames();
    }
    function buildNames() {
      namesEl.innerHTML = `<div class="wave-axis-spacer"><span>signal</span><span>value</span></div>`;
      rowEls = shown.map((p, i) => {
        const row = document.createElement('div');
        row.className = 'wave-name';
        row.title = p;
        const short = p.replace(/^tb\.dut\./, '').replace(/^tb\./, '');
        row.innerHTML = `<span class="n">${short}</span><span class="v"></span><button title="Remove">×</button>`;
        row.querySelector('button').onclick = () => { shown.splice(i, 1); markCustom(); buildNames(); };
        namesEl.appendChild(row);
        return row.querySelector('.v');
      });
    }
    function markCustom() { host.querySelectorAll('.wave-presets button').forEach(b => b.classList.remove('on')); }

    function setSource(s) {
      src = s;
      listEl.innerHTML = s ? s.list.map(x => x.path).sort().map(p => `<option value="${p}">`).join('') : '';
      applyPreset(preset);
      scale = width() / (80 * PERIOD);
      viewStart = 0;
      marker = null;
      setFollow(true);
    }
    // live sources grow new signals as they appear
    function refreshList() {
      if (src && listEl.children.length !== src.list.length) {
        listEl.innerHTML = src.list.map(x => x.path).sort().map(p => `<option value="${p}">`).join('');
        if (shown.length < PRESETS[preset].length) setShown(PRESETS[preset]);
      }
    }

    addEl.addEventListener('change', () => {
      const p = addEl.value.trim();
      if (src && src.byPath.has(p) && !shown.includes(p)) { shown.push(p); markCustom(); buildNames(); }
      addEl.value = '';
    });
    host.querySelectorAll('.wave-presets button').forEach(b => b.onclick = () => applyPreset(b.dataset.p));

    function clampScale(s) {
      const span = Math.max(src ? src.end() : 0, 40 * PERIOD);
      return Math.min(40, Math.max(width() / span / 1.2, s));
    }
    function zoomAt(factor, x) {
      const t = viewStart + x / scale;
      scale = clampScale(scale * factor);
      viewStart = t - x / scale;
    }
    host.querySelectorAll('[data-z]').forEach(b => b.onclick = () => {
      const z = b.dataset.z, w = width();
      if (z === 'in') zoomAt(1.6, follow ? (cursor - viewStart) * scale : w / 2);
      if (z === 'out') zoomAt(1 / 1.6, follow ? (cursor - viewStart) * scale : w / 2);
      if (z === 'fit') { scale = clampScale(w / Math.max(src.end(), PERIOD)); viewStart = 0; setFollow(false); }
      if (z === 'follow') setFollow(!follow);
    });

    // pan / zoom / click
    canvas.addEventListener('wheel', e => {
      e.preventDefault();
      const x = e.offsetX;
      if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.01), x);
      else { viewStart += (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) / scale; setFollow(false); }
    }, { passive: false });
    let drag = null;
    canvas.addEventListener('pointerdown', e => { drag = { x: e.clientX, v: viewStart, moved: false }; canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener('pointermove', e => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      if (Math.abs(dx) > 3) { drag.moved = true; setFollow(false); }
      if (drag.moved) viewStart = drag.v - dx / scale;
    });
    canvas.addEventListener('pointerup', e => {
      if (drag && !drag.moved) {
        const t = viewStart + e.offsetX / scale;
        if (api.onClick && api.onClick(t)) marker = null;
        else marker = marker !== null && Math.abs((marker - t) * scale) < 4 ? null : t;
      }
      drag = null;
    });

    // ---------------- drawing ----------------
    const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    function niceStep(minNs) {
      const p = Math.pow(10, Math.floor(Math.log10(minNs)));
      for (const m of [1, 2, 5, 10]) if (m * p >= minNs) return m * p;
      return 10 * p;
    }

    function render() {
      if (!src) return;
      refreshList();
      const w = width(), h = AXIS + shown.length * ROW, dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
        canvas.style.height = h + 'px';
      }
      const end = src.end();
      if (follow) viewStart = Math.max(0, cursor - (w * 0.8) / scale);
      const t0 = viewStart, t1 = viewStart + w / scale;
      const X = t => (t - t0) * scale;
      const C = { text: css('--text') || '#111', muted: css('--muted') || '#666', line: css('--line') || '#ccc',
                  fill: css('--fill') || '#f2f2f2', hot: css('--hot') || '#c00', a: css('--a') || '#0057b8' };

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.font = '11px ui-monospace, "SF Mono", Menlo, monospace';
      ctx.textBaseline = 'middle';

      // time axis + grid
      const step = niceStep(80 / scale);
      ctx.strokeStyle = C.line; ctx.fillStyle = C.muted; ctx.lineWidth = 1;
      for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) {
        const x = Math.round(X(t)) + 0.5;
        ctx.beginPath(); ctx.moveTo(x, AXIS - 6); ctx.lineTo(x, h); ctx.globalAlpha = 0.5; ctx.stroke(); ctx.globalAlpha = 1;
        ctx.fillText(t >= 1000 ? `${+(t / 1000).toFixed(2)}us` : `${t}ns`, x + 3, AXIS / 2);
      }
      ctx.beginPath(); ctx.moveTo(0, AXIS - 0.5); ctx.lineTo(w, AXIS - 0.5); ctx.strokeStyle = C.text; ctx.stroke();

      // rows
      shown.forEach((path, r) => {
        const sig = src.byPath.get(path), y = AXIS + r * ROW, hi = y + 5, lo = y + ROW - 5, mid = y + ROW / 2;
        ctx.strokeStyle = C.line; ctx.beginPath(); ctx.moveTo(0, y + ROW - 0.5); ctx.lineTo(w, y + ROW - 0.5); ctx.stroke();
        const segEnd = Math.min(t1, end);
        ctx.strokeStyle = C.text; ctx.fillStyle = C.text; ctx.lineWidth = 1;

        if (sig.clock) {
          if (PERIOD / 2 * scale < 3) { ctx.globalAlpha = 0.25; ctx.fillRect(X(Math.max(0, t0)), hi, X(segEnd) - X(Math.max(0, t0)), lo - hi); ctx.globalAlpha = 1; return; }
          ctx.beginPath();
          let t = Math.max(0, Math.floor(t0 / (PERIOD / 2)) * (PERIOD / 2));
          ctx.moveTo(X(t), clockAt(t) ? hi : lo);
          for (; t < segEnd; t += PERIOD / 2) {
            const nt = Math.min(t + PERIOD / 2, segEnd), yv = clockAt(t) ? hi : lo;
            ctx.lineTo(X(t), yv); ctx.lineTo(X(nt), yv);
          }
          ctx.stroke();
          return;
        }

        const ch = sig.ch;
        let i = Math.max(0, idxAt(ch, t0));
        if (!ch.t.length || ch.t[i] > segEnd) return;
        // walk segments
        let busyFrom = null;
        for (; i < ch.t.length && ch.t[i] < segEnd; i++) {
          const ta = Math.max(ch.t[i], t0), tb = Math.min(i + 1 < ch.t.length ? ch.t[i + 1] : segEnd, segEnd);
          const xa = X(ta), xb = X(tb), v = ch.v[i];
          if (xb - xa < 2 && i + 1 < ch.t.length && ch.t[i + 1] < segEnd) {        // too dense: draw a busy block
            if (busyFrom === null) busyFrom = xa;
            continue;
          }
          if (busyFrom !== null) { ctx.globalAlpha = 0.35; ctx.fillRect(busyFrom, hi, xa - busyFrom, lo - hi); ctx.globalAlpha = 1; busyFrom = null; }
          if (v < 0) {                       // x / z
            ctx.fillStyle = C.hot; ctx.globalAlpha = 0.15; ctx.fillRect(xa, hi, xb - xa, lo - hi); ctx.globalAlpha = 1;
            ctx.strokeStyle = C.hot; ctx.strokeRect(xa + 0.5, hi + 0.5, xb - xa - 1, lo - hi - 1);
            ctx.strokeStyle = C.text; ctx.fillStyle = C.text;
            continue;
          }
          if (sig.width === 1) {
            const yv = v ? hi : lo;
            ctx.beginPath();
            if (ch.t[i] >= t0 && i > 0) { ctx.moveTo(xa, ch.v[i - 1] ? hi : lo); ctx.lineTo(xa, yv); } else ctx.moveTo(xa, yv);
            ctx.lineTo(xb, yv); ctx.stroke();
            if (v) { ctx.globalAlpha = 0.12; ctx.fillRect(xa, hi, xb - xa, lo - hi); ctx.globalAlpha = 1; }
          } else {
            const s = Math.min(3, (xb - xa) / 2);
            ctx.beginPath();
            ctx.moveTo(xa, mid); ctx.lineTo(xa + s, hi); ctx.lineTo(xb - s, hi); ctx.lineTo(xb, mid);
            ctx.lineTo(xb - s, lo); ctx.lineTo(xa + s, lo); ctx.closePath(); ctx.stroke();
            const label = fmt(path, sig.width, v);
            const tw = label.length * 6.7;
            if (xb - xa > tw + 8) {
              const cx = Math.max(xa + 4, Math.min((Math.max(xa, 0) + Math.min(xb, w)) / 2 - tw / 2, xb - tw - 4));
              ctx.fillText(label, cx, mid + 0.5);
            }
          }
        }
        if (busyFrom !== null) { ctx.globalAlpha = 0.35; ctx.fillRect(busyFrom, hi, X(segEnd) - busyFrom, lo - hi); ctx.globalAlpha = 1; }
      });

      // future region (replay) / not-yet-simulated region (live)
      const cx = X(cursor);
      if (cx < w) { ctx.fillStyle = C.fill; ctx.globalAlpha = src.replay ? 0.55 : 1; ctx.fillRect(Math.max(cx, 0), AXIS, w - Math.max(cx, 0), h - AXIS); ctx.globalAlpha = 1; }
      // cursor + marker
      ctx.fillStyle = C.hot; ctx.fillRect(Math.round(cx) - 1, 0, 2, h);
      if (marker !== null) {
        const mx = Math.round(X(marker)) + 0.5;
        ctx.strokeStyle = C.a; ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.moveTo(mx, 0); ctx.lineTo(mx, h); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = C.a; ctx.fillText(`${marker.toFixed(0)}ns`, mx + 3, AXIS / 2);
      }

      // value column at marker (if any) else cursor
      const tv = marker !== null ? marker : cursor;
      shown.forEach((path, r) => {
        const sig = src.byPath.get(path);
        rowEls[r].textContent = fmt(path, sig.width, valueAt(sig, tv), true);
      });
    }

    api.setSource = setSource;
    api.setCursor = t => { cursor = t; };
    api.clearMarker = () => { marker = null; };
    api.render = render;
    return api;
  }

  root.WaveViewer = { create, fromVcd, live };
})(window);
