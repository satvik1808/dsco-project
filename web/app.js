// ============================================================================
// app.js - visualisation for the elevator coordinator RTL.
// Two sources drive the same renderer:
//   live   : ElevatorRTL (JS port of the Verilog) clocked in the browser,
//            inputs come from your clicks / random traffic
//   replay : register values from build/elevator.vcd, recorded by Icarus Verilog
//            (web/verilog_trace.js); each row is also re-computed with the JS
//            model and the badge shows whether they agree
// ============================================================================
(function () {
  'use strict';
  const RTL = window.ElevatorRTL;
  const { S_IDLE, S_UP, S_DN, S_DOOR, D_UP, D_DN, STATE_NAMES, DIR_NAMES } = RTL;
  const model = RTL.create();
  const { N, TRAVEL_TICKS, DOOR_TICKS } = model.params;
  const TRACE = window.VERILOG_TRACE || null;
  const CAR = ['A', 'B'];
  const ARROW = ['', '▲', '▼'];
  const $ = id => document.getElementById(id);
  const clone = o => JSON.parse(JSON.stringify(o));
  const bit = (v, i) => (v >> i) & 1;

  // waveform viewer: real VCD in replay mode, signals recorded from the JS model in live mode
  const T = k => 10 * k + 15;        // testbench time (ns) of the posedge that produces register state #k
  const viewer = WaveViewer.create($('waves'));
  const vcdSource = window.VERILOG_WAVES ? WaveViewer.fromVcd(window.VERILOG_WAVES) : null;
  const vcdWidth = vcdSource ? (p => (vcdSource.byPath.get(p) || {}).width) : null;
  let liveSource = null;

  // ---------------- simulation state ----------------
  let mode = 'live';
  let running = true;
  let hz = 12;
  let traffic = true;
  let prev, cur;                     // register snapshots either side of the last clock edge
  let pending = { hall_up: 0, hall_dn: 0, car0: 0, car1: 0 };
  let passengerQueue = [];           // destination presses made by passengers who just boarded
  let replayIdx = 0;
  let history = [];
  let doorAge = [0, 0], doorPrev = [0, 0], doorCur = [0, 0];
  let hotEdge = [null, null];
  let waitStart = { up: {}, dn: {} }, servedCount = 0, waitTotal = 0;
  let lastTickAt = performance.now(), acc = 0, stepAnimAt = 0;

  // ---------------- build DOM ----------------
  const floorsEl = $('floors');
  const hallBtn = { up: [], dn: [] }, stopMark = [[], []];
  for (let f = N - 1; f >= 0; f--) {
    const row = document.createElement('div');
    row.className = 'floor';
    row.innerHTML = `<div class="floor-label">F${f}</div>
      <div class="hall-btns">
        <button class="hall up ${f === N - 1 ? 'hidden' : ''}" title="Hall call UP at floor ${f}">▲</button>
        <button class="hall dn ${f === 0 ? 'hidden' : ''}" title="Hall call DOWN at floor ${f}">▼</button>
      </div>
      <div class="shaft-cell a-col"><span class="stop-mark"></span></div>
      <div class="shaft-cell b-col"><span class="stop-mark"></span></div>`;
    const [up, dn] = row.querySelectorAll('.hall');
    up.onclick = () => press('hall_up', f);
    dn.onclick = () => press('hall_dn', f);
    hallBtn.up[f] = up; hallBtn.dn[f] = dn;
    const marks = row.querySelectorAll('.stop-mark');
    stopMark[0][f] = marks[0]; stopMark[1][f] = marks[1];
    floorsEl.appendChild(row);
  }
  const layer = document.createElement('div');
  layer.className = 'car-layer';
  layer.innerHTML = [0, 1].map(i => `
    <div class="track ${i ? 'b' : 'a'}">
      <div class="cable"></div>
      <div class="car"><div class="inside">F0</div><div class="arrow"></div>
        <div class="door l"></div><div class="door r"></div></div>
    </div>`).join('');
  floorsEl.appendChild(layer);
  const carEl = [...layer.querySelectorAll('.car')];
  const cableEl = [...layer.querySelectorAll('.cable')];

  // FSM diagram geometry: IDLE left, MOVE_UP top, MOVE_DN bottom, DOOR right
  const NODES = [[48, 85], [150, 22], [150, 148], [252, 85]];
  const HW = 36, HH = 12;                 // half width / height of a state box
  const EDGES = [[0, 1], [0, 2], [0, 3], [1, 3], [2, 3], [3, 1], [3, 2], [3, 0], [1, 0], [2, 0]];
  // Each pair of states has two straight parallel arrows, one each way, offset
  // to the right of the direction of travel. Both ends stop GAP px outside the
  // boxes so every arrowhead is fully visible.
  function edgePath(a, b) {
    const [ax, ay] = NODES[a], [bx, by] = NODES[b];
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
    const nx = -dy / len * 5, ny = dx / len * 5, GAP = 3;
    const inBox = (x, y, [cx, cy]) => Math.abs(x - cx) <= HW + GAP && Math.abs(y - cy) <= HH + GAP;
    const at = t => [ax + nx + dx * t, ay + ny + dy * t];
    let t0 = 0, t1 = 1;
    while (t0 < 1 && inBox(...at(t0), NODES[a])) t0 += 0.002;
    while (t1 > 0 && inBox(...at(t1), NODES[b])) t1 -= 0.002;
    const [sx, sy] = at(t0), [ex, ey] = at(t1);
    return `M${sx.toFixed(1)},${sy.toFixed(1)} L${ex.toFixed(1)},${ey.toFixed(1)}`;
  }
  function fsmSvg(i) {
    return `<svg class="fsm" viewBox="0 0 300 170" aria-label="Car ${CAR[i]} state machine">
      <defs>
        <marker id="m${i}d" viewBox="0 0 8 8" refX="8" refY="4" markerUnits="userSpaceOnUse" markerWidth="7" markerHeight="7" orient="auto"><path class="mk" d="M0,0 L8,4 L0,8z"/></marker>
        <marker id="m${i}h" viewBox="0 0 8 8" refX="8" refY="4" markerUnits="userSpaceOnUse" markerWidth="8" markerHeight="8" orient="auto"><path class="mk h" d="M0,0 L8,4 L0,8z"/></marker>
      </defs>
      ${NODES.map(([x, y], s) => `<g class="node" data-s="${s}"><rect x="${x - HW}" y="${y - HH}" width="${2 * HW}" height="${2 * HH}"/><text x="${x}" y="${y}">${STATE_NAMES[s]}</text></g>`).join('')}
      ${EDGES.map(([a, b]) => `<path class="edge" data-e="${a}${b}" d="${edgePath(a, b)}" marker-end="url(#m${i}d)"/>`).join('')}
    </svg>`;
  }
  const carUI = [0, 1].map(i => {
    const p = $('carPanel' + i);
    const keyOrder = [];
    for (let f = N - 2; f >= 0; f -= 2) keyOrder.push(f, f + 1);
    p.innerHTML = `
      <div class="panel-head"><h2><span class="dot"></span>Car ${CAR[i]}</h2><span class="meta">u_car${i}</span></div>
      <div class="car-body">
        <div class="keypad">${keyOrder.map(f => `<button class="key" data-f="${f}" title="Cabin call to floor ${f}">${f}</button>`).join('')}</div>
        <div>
          ${fsmSvg(i)}
          <dl class="sigs">
            <dt>floor</dt><dd data-k="floor"></dd>
            <dt>dir / next</dt><dd data-k="dir"></dd>
            <dt>car_calls</dt><dd data-k="calls"></dd>
            <dt>timer</dt><dd><span data-k="timer"></span><div class="timer-bar"><i></i></div></dd>
          </dl>
        </div>
      </div>`;
    const keys = [];
    p.querySelectorAll('.key').forEach(k => { const f = +k.dataset.f; keys[f] = k; k.onclick = () => press('car' + i, f); });
    const sig = {};
    p.querySelectorAll('[data-k]').forEach(d => sig[d.dataset.k] = d);
    return {
      keys, sig, bar: p.querySelector('.timer-bar i'),
      nodes: [...p.querySelectorAll('.node')],
      edges: Object.fromEntries([...p.querySelectorAll('.edge')].map(e => [e.dataset.e, e])),
      marker: i,
    };
  });

  // Register view
  const REGS = [
    ['up_pend', r => r.up_pend, (r, b) => ownerClass(r.up_asgd, r.up_owner, b)],
    ['up_asgd', r => r.up_asgd, (r, b) => ownerClass(r.up_asgd, r.up_owner, b)],
    ['up_owner', r => r.up_owner, (r, b) => bit(r.up_asgd, b) ? 'cb' : ''],
    ['dn_pend', r => r.dn_pend, (r, b) => ownerClass(r.dn_asgd, r.dn_owner, b)],
    ['dn_asgd', r => r.dn_asgd, (r, b) => ownerClass(r.dn_asgd, r.dn_owner, b)],
    ['dn_owner', r => r.dn_owner, (r, b) => bit(r.dn_asgd, b) ? 'cb' : ''],
    ['calls0', r => r.cars[0].calls, () => 'ca'],
    ['calls1', r => r.cars[1].calls, () => 'cb'],
  ];
  function ownerClass(asgd, owner, b) { return bit(asgd, b) ? (bit(owner, b) ? 'cb' : 'ca') : ''; }
  const regCells = REGS.map(([name]) => {
    const nameEl = document.createElement('div'); nameEl.className = 'name'; nameEl.textContent = name;
    $('regs').appendChild(nameEl);
    const bits = [];
    for (let b = N - 1; b >= 0; b--) {
      const c = document.createElement('div'); c.className = 'bit'; c.textContent = '0';
      $('regs').appendChild(c); bits[b] = c;
    }
    const hex = document.createElement('div'); hex.className = 'hex'; $('regs').appendChild(hex);
    return { bits, hex };
  });

  // ---------------- inputs ----------------
  function press(kind, f) {
    if (mode !== 'live') return;
    Sound.press();
    pending[kind] |= 1 << f;
    if (!running) tick(true);           // paused: clock one edge so the press is visible
  }

  function randomTraffic(inp) {
    const r = Math.random, fl = () => Math.floor(r() * N);
    if (r() < 0.03) { const f = fl(); if (f < N - 1) inp.hall_up |= 1 << f; }
    if (r() < 0.03) { const f = fl(); if (f > 0) inp.hall_dn |= 1 << f; }
    if (r() < 0.006) inp.car0 |= 1 << fl();
    if (r() < 0.006) inp.car1 |= 1 << fl();
  }

  // ---------------- clocking ----------------
  const carPos = c => c.floor + (c.state === S_UP ? c.timer / TRAVEL_TICKS : c.state === S_DN ? -c.timer / TRAVEL_TICKS : 0);
  const CAR_FIELDS = ['floor', 'state', 'dir', 'timer', 'calls'];
  const HALL_FIELDS = ['up_pend', 'up_asgd', 'up_owner', 'dn_pend', 'dn_asgd', 'dn_owner'];
  const sameRegs = (a, b) => HALL_FIELDS.every(k => a[k] === b[k]) &&
    [0, 1].every(i => CAR_FIELDS.every(k => a.cars[i][k] === b.cars[i][k]));
  const unpack = w => ({ hall_up: (w >>> 24) & 255, hall_dn: (w >>> 16) & 255, car0: (w >>> 8) & 255, car1: w & 255 });
  function rowToRegs(row) {
    const [c, f0, s0, d0, t0, k0, f1, s1, d1, t1, k1, up, ua, uo, dp, da, dw] = row;
    return {
      cycle: c + 1,
      cars: [{ floor: f0, state: s0, dir: d0, timer: t0, calls: k0 }, { floor: f1, state: s1, dir: d1, timer: t1, calls: k1 }],
      up_pend: up, up_asgd: ua, up_owner: uo, dn_pend: dp, dn_asgd: da, dn_owner: dw,
    };
  }

  function tick(manual) {
    let inputs, info, match = null;
    if (mode === 'live') {
      inputs = pending;
      pending = { hall_up: 0, hall_dn: 0, car0: 0, car1: 0 };
      if (traffic) {
        randomTraffic(inputs);
        passengerQueue = passengerQueue.filter(p => (p.at <= cur.cycle ? (inputs['car' + p.car] |= 1 << p.floor, false) : true));
      }
      prev = cur;
      model.step(inputs);
      cur = clone(model.regs);
      info = model.last;
      liveSource.record(info.sig, T(cur.cycle - 1) + 1);       // inputs + combinational nets
      liveSource.record(model.regSignals(cur), T(cur.cycle));  // registers update on posedge
    } else {
      if (replayIdx >= TRACE.rows.length) { resetSim(); return; }
      inputs = unpack(TRACE.stim[replayIdx]);
      prev = cur;
      model.load(prev);
      model.step(inputs);                       // JS recomputation (for decision info + check)
      info = model.last;
      cur = rowToRegs(TRACE.rows[replayIdx]);   // what Verilog actually produced
      match = sameRegs(model.regs, cur);
      replayIdx++;
    }
    if (manual) stepAnimAt = performance.now();
    afterTick(inputs, info, match);
  }

  const doorOpenness = (c, age) => c.state === S_DOOR ? Math.min(1, age / 3, (DOOR_TICKS - c.timer) / 3) : 0;

  // ---------------- per-tick bookkeeping & DOM updates ----------------
  function afterTick(inputs, info, match) {
    for (let i = 0; i < 2; i++) {
      const p = prev.cars[i], c = cur.cars[i];
      doorAge[i] = c.state === S_DOOR ? (p.state === S_DOOR ? doorAge[i] + 1 : 1) : 0;
      doorPrev[i] = doorCur[i];
      doorCur[i] = doorOpenness(c, doorAge[i]);
      if (p.state !== c.state) hotEdge[i] = { e: `${p.state}${c.state}`, t: performance.now() };
      if (c.state === S_DOOR && p.state !== S_DOOR) Sound.ding();
      if (c.state === S_DOOR && p.state !== S_DOOR) log(`<span class="c${CAR[i].toLowerCase()}">Car ${CAR[i]}</span> doors open at F${c.floor}`);
    }
    logEvents(inputs, info);
    history.push([carPos(cur.cars[0]), carPos(cur.cars[1])]);
    if (history.length > 400) history.shift();

    $('cycle').textContent = cur.cycle;
    const badge = $('matchBadge');
    if (match === null) badge.hidden = true;
    else {
      badge.hidden = false;
      badge.className = 'badge' + (match ? '' : ' bad');
      badge.textContent = match ? 'Verilog = JS ✓' : 'Verilog ≠ JS';
    }
    renderPanels();
  }

  function logEvents(inp, info) {
    for (let f = 0; f < N; f++) {
      for (const d of ['up', 'dn']) {
        const was = bit(prev[d + '_pend'], f), is = bit(cur[d + '_pend'], f);
        const arrow = d === 'up' ? '▲' : '▼';
        if (!was && is) { waitStart[d][f] = cur.cycle; log(`hall ${arrow} pressed at F${f}`); }
        if (was && !is) {
          const owner = bit(prev[d + '_owner'], f);
          const w = cur.cycle - (waitStart[d][f] ?? cur.cycle);
          servedCount++; waitTotal += w;
          log(`<span class="c${CAR[owner].toLowerCase()}">Car ${CAR[owner]}</span> answered ${arrow} at F${f} after ${w} cycles`);
          // the passenger boards and picks a destination in that direction
          if (mode === 'live' && traffic) {
            const lo = d === 'up' ? f + 1 : 0, hi = d === 'up' ? N - 1 : f - 1;
            if (hi >= lo) passengerQueue.push({ car: owner, floor: lo + Math.floor(Math.random() * (hi - lo + 1)), at: cur.cycle + 3 });
          }
        }
      }
    }
    if (info && info.pick) {
      const { up, floor, car, dist } = info.pick;
      const parts = [0, 1].map(i =>
        `<span class="c${CAR[i].toLowerCase()}">${CAR[i]}</span>: F${prev.cars[i].floor} is <b>${dist[i]}</b> floor${dist[i] === 1 ? '' : 's'} away`);
      $('decision').innerHTML = `cycle ${cur.cycle}: assign <b>${up ? '▲' : '▼'} F${floor}</b><br>${parts.join(' &nbsp;·&nbsp; ')}<br>→ <b class="c${CAR[car].toLowerCase()}">Car ${CAR[car]}</b> (nearer car${dist[0] === dist[1] ? ', tie → A' : ''})`;
      log(`${up ? '▲' : '▼'} F${floor} assigned to <span class="c${CAR[car].toLowerCase()}">Car ${CAR[car]}</span> (distance A ${dist[0]} / B ${dist[1]})`);
    }
    for (let i = 0; i < 2; i++) {
      const added = cur.cars[i].calls & ~prev.cars[i].calls;
      for (let f = 0; f < N; f++) if (bit(added, f)) log(`<span class="c${CAR[i].toLowerCase()}">Car ${CAR[i]}</span> cabin call → F${f}`);
    }
    $('stats').textContent = servedCount ? `served ${servedCount} · avg wait ${(waitTotal / servedCount).toFixed(0)} cyc` : '';
  }

  const logEl = $('log');
  function log(html) {
    const li = document.createElement('li');
    li.className = 'new';
    li.innerHTML = `<span class="c">${String(cur.cycle).padStart(5, ' ')}</span>${html}`;
    logEl.prepend(li);
    while (logEl.children.length > 80) logEl.lastChild.remove();
  }

  function renderPanels() {
    const r = cur;
    for (let f = 0; f < N; f++) {
      for (const d of ['up', 'dn']) {
        const el = hallBtn[d][f];
        const pend = bit(r[d + '_pend'], f), asg = bit(r[d + '_asgd'], f), own = bit(r[d + '_owner'], f);
        el.classList.toggle('pend', !!pend);
        el.classList.toggle('own0', !!(pend && asg && !own));
        el.classList.toggle('own1', !!(pend && asg && own));
      }
    }
    for (let i = 0; i < 2; i++) {
      const c = r.cars[i], ui = carUI[i];
      const upAsg = r.up_pend & r.up_asgd & (i ? r.up_owner : ~r.up_owner);
      const dnAsg = r.dn_pend & r.dn_asgd & (i ? r.dn_owner : ~r.dn_owner);
      const targets = c.calls | upAsg | dnAsg;
      for (let f = 0; f < N; f++) {
        stopMark[i][f].classList.toggle('on', !!bit(targets, f));
        ui.keys[f].classList.toggle('lit', !!bit(c.calls, f));
      }
      const nd = model.nextDirOf ? nextDir(i) : 0;
      ui.nodes.forEach((n, s) => n.classList.toggle('on', s === c.state));
      ui.sig.floor.textContent = c.floor;
      ui.sig.dir.textContent = `${DIR_NAMES[c.dir]} / ${DIR_NAMES[nd]}`;
      ui.sig.calls.textContent = c.calls.toString(2).padStart(N, '0');
      ui.sig.timer.textContent = `${c.timer} / ${c.state === S_DOOR ? DOOR_TICKS : TRAVEL_TICKS}`;
      ui.bar.style.width = (c.state === S_IDLE ? 0 : 100 * (c.timer + 1) / (c.state === S_DOOR ? DOOR_TICKS : TRAVEL_TICKS)) + '%';
      const showDir = c.state === S_DOOR ? nd : c.dir;
      $(i ? 'indB' : 'indA').textContent = `F${c.floor} ${ARROW[showDir]}`;
      carEl[i].querySelector('.inside').textContent = 'F' + c.floor;
      carEl[i].querySelector('.arrow').textContent = ARROW[showDir];
    }
    REGS.forEach(([, get, cls], k) => {
      const v = get(r), pv = get(prev), cell = regCells[k];
      for (let b = 0; b < N; b++) {
        const el = cell.bits[b], one = bit(v, b);
        el.textContent = one;
        el.className = 'bit' + (one ? ' one ' + cls(r, b) : '');
        if (one !== bit(pv, b)) { void el.offsetWidth; el.classList.add('flash'); }
      }
      cell.hex.textContent = '0x' + v.toString(16).padStart(2, '0');
    });
  }

  // next_dir is combinational: evaluate it on the current registers
  function nextDir(i) {
    if (mode === 'replay') model.load(cur);
    return model.nextDirOf(i);
  }

  // ---------------- per-frame animation ----------------
  const chart = $('chart'), ctx = chart.getContext('2d');
  let theme = {};
  function readTheme() {
    const cs = getComputedStyle(document.documentElement), v = n => cs.getPropertyValue(n).trim();
    theme = { muted: v('--muted'), grid: v('--grid'), a: v('--a'), b: v('--b') };
    $('theme').textContent = cs.colorScheme === 'dark' ? 'Light' : 'Dark';
  }
  function drawChart() {
    const dpr = window.devicePixelRatio || 1, w = chart.clientWidth, h = 150;
    if (chart.width !== Math.round(w * dpr)) { chart.width = Math.round(w * dpr); chart.height = h * dpr; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const padL = 26, padT = 8, padB = 8, ph = h - padT - padB, pw = w - padL - 4;
    const y = p => padT + ph - (p / (N - 1)) * ph;
    ctx.font = '11px ui-monospace, Menlo, Consolas, monospace'; ctx.fillStyle = theme.muted; ctx.textBaseline = 'middle';
    for (let f = 0; f < N; f++) {
      ctx.strokeStyle = theme.grid; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(padL, y(f)); ctx.lineTo(w - 4, y(f)); ctx.stroke();
      ctx.fillText('F' + f, 2, y(f));
    }
    const cols = [theme.a, theme.b];
    for (let i = 0; i < 2; i++) {
      ctx.strokeStyle = cols[i]; ctx.lineWidth = 1.5; ctx.lineJoin = 'miter';
      ctx.beginPath();
      history.forEach((h, k) => {
        const x = padL + (k + 400 - history.length) / 399 * pw;
        k ? ctx.lineTo(x, y(h[i])) : ctx.moveTo(x, y(h[i]));
      });
      ctx.stroke();
    }
  }

  function frame(now) {
    const dt = now - lastTickAt; lastTickAt = now;
    const period = 1000 / hz;
    let frac = 1;
    if (running) {
      acc += Math.min(dt, 250);
      let n = 0;
      while (acc >= period && n++ < 20) { tick(false); acc -= period; }
      frac = Math.min(1, acc / period);
    } else if (stepAnimAt) {
      frac = Math.min(1, (now - stepAnimAt) / 180);
    }
    const rowH = floorsEl.querySelector('.floor').offsetHeight;
    for (let i = 0; i < 2; i++) {
      const pos = carPos(prev.cars[i]) + (carPos(cur.cars[i]) - carPos(prev.cars[i])) * frac;
      const bottom = pos * rowH + 4;
      carEl[i].style.bottom = bottom + 'px';
      cableEl[i].style.height = Math.max(0, floorsEl.offsetHeight - bottom - (rowH - 8)) + 'px';
      const open = doorPrev[i] + (doorCur[i] - doorPrev[i]) * frac;
      carEl[i].querySelector('.door.l').style.transform = `translateX(${-open * 92}%)`;
      carEl[i].querySelector('.door.r').style.transform = `translateX(${open * 92}%)`;
      const h = hotEdge[i];
      Object.entries(carUI[i].edges).forEach(([k, e]) => {
        const hot = h && h.e === k;      // the last transition taken stays green
        e.classList.toggle('hot', !!hot);
        e.setAttribute('marker-end', `url(#m${i}${hot ? 'h' : 'd'})`);
      });
    }
    drawChart();
    const cursorT = T(cur.cycle) + 1 + frac * 8;
    if (mode === 'live') liveSource.setEnd(cursorT);
    viewer.setCursor(cursorT);
    viewer.render();
    Sound.setMoving(running && cur.cars.some(c => c.state === S_UP || c.state === S_DN));
    Sound.update(Math.min(dt, 250) / 1000);
    requestAnimationFrame(frame);
  }

  // ---------------- controls ----------------
  function resetSim() {
    model.reset();
    cur = prev = clone(model.regs);
    pending = { hall_up: 0, hall_dn: 0, car0: 0, car1: 0 };
    passengerQueue = []; replayIdx = 0; history = [];
    doorAge = [0, 0]; doorPrev = [0, 0]; doorCur = [0, 0]; hotEdge = [null, null];
    waitStart = { up: {}, dn: {} }; servedCount = 0; waitTotal = 0; acc = 0;
    logEl.innerHTML = '';
    $('decision').textContent = mode === 'live' ? 'Waiting for a hall call…' : 'Replaying the Icarus Verilog simulation…';
    $('cycle').textContent = 0;
    $('matchBadge').hidden = true;
    $('stats').textContent = '';
    liveSource = WaveViewer.live(vcdWidth);
    liveSource.record(Object.assign({ 'tb.rst': 1 }, model.regSignals(cur)), 0);
    liveSource.record({ 'tb.rst': 0 }, 16);
    const src = mode === 'live' ? liveSource : vcdSource;
    viewer.setSource(src);
    $('waveSrc').textContent = src ? src.label : 'run ./run.sh to generate web/verilog_waves.js';
    renderPanels();
  }

  // Replay: jump straight to register state #k of the Verilog trace
  function seekReplay(k) {
    k = Math.max(0, Math.min(TRACE.rows.length, k));
    setRunning(false);
    model.reset();
    const r0 = clone(model.regs);
    const regsAt = j => (j === 0 ? r0 : rowToRegs(TRACE.rows[j - 1]));
    cur = regsAt(k); prev = k ? regsAt(k - 1) : cur;
    replayIdx = k; stepAnimAt = 0; acc = 0;
    history = [];
    for (let j = Math.max(0, k - 399); j <= k; j++) { const r = regsAt(j); history.push([carPos(r.cars[0]), carPos(r.cars[1])]); }
    for (let i = 0; i < 2; i++) {
      let age = 0;
      for (let j = k; j > 0 && regsAt(j).cars[i].state === S_DOOR; j--) age++;
      doorAge[i] = age; doorCur[i] = doorPrev[i] = doorOpenness(cur.cars[i], age);
    }
    hotEdge = [null, null];
    // rebuild wait-time statistics up to cycle k
    waitStart = { up: {}, dn: {} }; servedCount = 0; waitTotal = 0;
    for (let j = 1; j <= k; j++) {
      const a = regsAt(j - 1), b = regsAt(j);
      for (const d of ['up', 'dn']) for (let f = 0; f < N; f++) {
        const was = bit(a[d + '_pend'], f), is = bit(b[d + '_pend'], f);
        if (!was && is) waitStart[d][f] = j;
        if (was && !is) { servedCount++; waitTotal += j - waitStart[d][f]; }
      }
    }
    $('stats').textContent = servedCount ? `served ${servedCount} · avg wait ${(waitTotal / servedCount).toFixed(0)} cyc` : '';
    logEl.innerHTML = '';
    log(`jumped to cycle ${k} (from the waveform)`);
    $('decision').textContent = 'Paused after a jump; press Run or Step clk to continue.';
    $('cycle').textContent = k;
    if (k) {
      model.load(prev); model.step(unpack(TRACE.stim[k - 1]));
      const ok = sameRegs(model.regs, cur), badge = $('matchBadge');
      badge.hidden = false; badge.className = 'badge' + (ok ? '' : ' bad'); badge.textContent = ok ? 'Verilog = JS ✓' : 'Verilog ≠ JS';
    }
    renderPanels();
  }
  viewer.onClick = t => {
    if (mode !== 'replay') return false;          // live: just place a marker
    seekReplay(Math.floor((t - 15) / 10));
    return true;
  };

  function setMode(m) {
    mode = m;
    $('modeLive').classList.toggle('on', m === 'live');
    $('modeReplay').classList.toggle('on', m === 'replay');
    $('trafficWrap').classList.toggle('disabled', m === 'replay');
    $('traffic').disabled = m === 'replay';
    document.querySelectorAll('.hall, .key').forEach(b => b.disabled = m === 'replay');
    resetSim();
    setRunning(true);
  }

  function setRunning(r) { running = r; $('play').textContent = r ? 'Pause' : 'Run'; }

  $('modeLive').onclick = () => setMode('live');
  $('modeReplay').onclick = () => setMode('replay');
  if (!TRACE) {
    $('modeReplay').disabled = true;
    $('modeReplay').title = 'Run ./run.sh first to generate web/verilog_trace.js';
  }
  $('play').onclick = () => setRunning(!running);
  $('step').onclick = () => { setRunning(false); tick(true); };
  $('reset').onclick = resetSim;
  $('speed').oninput = e => { hz = +e.target.value; $('speedVal').textContent = hz + ' Hz'; };
  $('traffic').onchange = e => { traffic = e.target.checked; };
  $('theme').onclick = () => {
    const t = $('theme').textContent === 'Dark' ? 'dark' : 'light';
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem('theme', t); } catch (e) {}
    readTheme();
  };
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', readTheme);
  readTheme();
  $('sound').onchange = e => Sound.setEnabled(e.target.checked);
  $('music').onclick = e => {
    if (e.shiftKey) Sound.forget(); else $('musicFile').click();
  };
  $('musicFile').onchange = e => { const f = e.target.files[0]; if (f) Sound.pick(f); e.target.value = ''; };
  Sound.onTrack(name => {
    $('music').classList.toggle('on', !!name);
    $('music').title = (name ? 'Playing while the cars move: ' + name : 'No song loaded: a synthesised loop plays. Click to pick a song (e.g. Songbird)')
      + ' · shift-click to clear a picked song';
  });
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT') return;
    if (e.code === 'Space') { e.preventDefault(); setRunning(!running); }
    if (e.key === 's' || e.key === 'ArrowRight') { setRunning(false); tick(true); }
  });

  // #replay starts in replay mode; #replay@1200 / #live@300 also fast-forward that many cycles
  const m = location.hash.match(/^#(replay|live)(?:@(\d+))?$/);
  if (m && (m[1] === 'live' || TRACE)) {
    setMode(m[1]);
    for (let k = +(m[2] || 0); k > 0; k--) tick(false);
  } else resetSim();
  requestAnimationFrame(frame);
})();
