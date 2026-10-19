// Generates build/stim.hex: one 32-bit word per clock cycle,
// {hall_up[7:0], hall_dn[7:0], car_btn0[7:0], car_btn1[7:0]}.
// Usage: node scripts/gen_stimulus.js [cycles] [seed]
const fs = require('fs');
const path = require('path');

const CYCLES = parseInt(process.argv[2] || '4000', 10);
let seed = parseInt(process.argv[3] || '2026', 10) >>> 0;
const N = 8;

function rand() { // mulberry32
  seed = (seed + 0x6D2B79F5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const floor = () => Math.floor(rand() * N);

const lines = [];
for (let c = 0; c < CYCLES; c++) {
  let up = 0, dn = 0, c0 = 0, c1 = 0;
  if (rand() < 0.035) { const f = floor(); if (f < N - 1) up |= 1 << f; }
  if (rand() < 0.035) { const f = floor(); if (f > 0) dn |= 1 << f; }
  if (rand() < 0.015) c0 |= 1 << floor();
  if (rand() < 0.015) c1 |= 1 << floor();
  const word = ((up << 24) | (dn << 16) | (c0 << 8) | c1) >>> 0;
  lines.push(word.toString(16).padStart(8, '0'));
}

const out = path.join(__dirname, '..', 'build', 'stim.hex');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, lines.join('\n') + '\n');
console.log(`wrote ${CYCLES} cycles of stimulus to build/stim.hex`);
