// Small VCD (waveform file) reader shared by verify.js and vcd2js.js.
// read(file) -> { vars: [{ path, width, id }], byId: Map(id -> { t: [], v: [] }),
//                 chanOf: { path -> channel }, endTime, valueAt(channel, t) }
// Times are in ns; values are numbers (-1 for x/z).
const fs = require('fs');

function read(file) {
  const tokens = fs.readFileSync(file, 'utf8').split(/\s+/);
  const scopes = [], vars = [], byId = new Map();
  let scale = 1, p = 0;
  for (; p < tokens.length; p++) {
    const tk = tokens[p];
    if (tk === '$timescale') {
      const m = tokens.slice(p + 1, p + 4).join('').match(/^(\d+)(s|ms|us|ns|ps|fs)/);
      scale = +m[1] * { s: 1e9, ms: 1e6, us: 1e3, ns: 1, ps: 1e-3, fs: 1e-6 }[m[2]];
    } else if (tk === '$scope') {
      scopes.push({ kind: tokens[p + 1], name: tokens[p + 2] }); p += 3;
    } else if (tk === '$upscope') {
      scopes.pop(); p++;
    } else if (tk === '$var') {
      const [type, width, id, ref] = tokens.slice(p + 1, p + 5);
      p += 5;
      while (tokens[p] !== '$end') p++;
      if (type === 'parameter') continue;
      const names = scopes.map(s => s.name);
      names[0] = 'tb';
      vars.push({ path: names.concat(ref).join('.'), width: +width, id });
      if (!byId.has(id)) byId.set(id, { t: [], v: [] });
    } else if (tk === '$enddefinitions') { p++; break; }
  }

  let now = 0;
  function set(id, val) {
    const ch = byId.get(id);
    if (!ch) return;
    const v = /[xz]/i.test(val) ? -1 : parseInt(val, 2);
    if (ch.v.length && ch.v[ch.v.length - 1] === v) return;
    if (ch.t.length && ch.t[ch.t.length - 1] === now) { ch.v[ch.v.length - 1] = v; return; }
    ch.t.push(now); ch.v.push(v);
  }
  for (; p < tokens.length; p++) {
    const tk = tokens[p];
    if (!tk || tk[0] === '$') continue;
    const c = tk[0];
    if (c === '#') now = +tk.slice(1) * scale;
    else if (c === 'b' || c === 'B' || c === 'r' || c === 'R') { set(tokens[p + 1], tk.slice(1)); p++; }
    else if ('01xXzZ'.includes(c)) set(tk.slice(1), c);
  }

  const valueAt = (ch, t) => {           // last change at or before t
    let lo = 0, hi = ch.t.length - 1, ans = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (ch.t[m] <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
    return ans < 0 ? -1 : ch.v[ans];
  };
  const chanOf = Object.fromEntries(vars.map(v => [v.path, byId.get(v.id)]));
  return { vars, byId, chanOf, endTime: now, valueAt };
}

// Timing used by the testbench: rising edges at 5, 15, 25, ... ns; reset is
// released at 16 ns and stimulus line k is applied at 16 + 10k ns. So the
// register values produced by line k appear at the rising edge T(k + 1).
const T = k => 10 * k + 15;
const unpack = w => ({ hall_up: (w >>> 24) & 255, hall_dn: (w >>> 16) & 255, car0: (w >>> 8) & 255, car1: w & 255 });

module.exports = { read, T, unpack };
