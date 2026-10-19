// ============================================================================
// sound.js - button beeps, arrival chime, and music while the cars move.
// Everything is synthesised with the Web Audio API except the optional music
// file: put your own copy of the track at web/songbird.mp3 and it is played
// while any car is moving. Without it, an original lounge loop is synthesised.
// ============================================================================
(function (root) {
  'use strict';
  const MUSIC_FILE = 'songbird.mp3';
  let ctx = null, master = null, enabled = true;
  let moving = false, musicVol = 0;

  // browsers only allow audio after a user gesture
  function ensure() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.8;
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  ['pointerdown', 'keydown'].forEach(ev => window.addEventListener(ev, ensure, { capture: true }));

  function tone(freq, start, dur, { type = 'sine', vol = 0.2, attack = 0.005, out = master } = {}) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(vol, start + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    o.connect(g); g.connect(out);
    o.start(start); o.stop(start + dur + 0.05);
  }

  // short electronic lift-button beep
  function press() {
    if (!enabled || !ensure()) return;
    const t = ctx.currentTime;
    tone(1046.5, t, 0.11, { type: 'square', vol: 0.06 });
    tone(2093, t, 0.06, { vol: 0.03 });
  }

  // two-note "ding-dong" when a car's doors open
  function ding() {
    if (!enabled || !ctx || ctx.state !== 'running') return;
    const t = ctx.currentTime;
    for (const [f, dt] of [[880, 0], [698.5, 0.38]]) {
      tone(f, t + dt, 1.4, { vol: 0.12, attack: 0.004 });
      tone(f * 2.76, t + dt, 0.5, { vol: 0.025, attack: 0.002 });   // bell overtone
    }
  }

  // ---------------- music ----------------
  const audio = new Audio();
  let useFile = null;              // null = still checking, true/false once known
  audio.loop = true;
  audio.preload = 'auto';
  audio.addEventListener('canplaythrough', () => { if (useFile === null) useFile = true; }, { once: true });
  audio.addEventListener('error', () => { useFile = false; });
  audio.src = MUSIC_FILE;
  setTimeout(() => { if (useFile === null) useFile = false; }, 4000);

  // fallback: an original slow lounge progression (Fmaj7 Em7 Dm7 Cmaj7) on soft keys + bass
  const CHORDS = [[53, 57, 60, 64], [52, 55, 59, 62], [50, 53, 57, 60], [48, 52, 55, 59]];
  const MELODY = [72, null, 69, 71, 72, null, 76, null, 74, null, 72, 71, 69, null, 67, null];
  const midi = n => 440 * Math.pow(2, (n - 69) / 12);
  let synthGain = null, nextBeat = 0, beat = 0;
  const BEAT = 0.5;                // seconds per beat (120 bpm, half-time feel)

  function scheduleSynth() {
    if (!synthGain) { synthGain = ctx.createGain(); synthGain.gain.value = 0; synthGain.connect(master); }
    if (nextBeat < ctx.currentTime) nextBeat = ctx.currentTime + 0.05;
    while (nextBeat < ctx.currentTime + 0.4) {
      const chord = CHORDS[Math.floor(beat / 4) % CHORDS.length];
      if (beat % 4 === 0) {
        chord.forEach(n => tone(midi(n), nextBeat, BEAT * 4, { type: 'triangle', vol: 0.035, attack: 0.08, out: synthGain }));
        tone(midi(chord[0] - 12), nextBeat, BEAT * 1.8, { vol: 0.12, attack: 0.01, out: synthGain });
      }
      if (beat % 4 === 2) tone(midi(chord[0] - 5), nextBeat, BEAT * 1.6, { vol: 0.09, attack: 0.01, out: synthGain });
      const m = MELODY[beat % MELODY.length];
      if (m !== null) tone(midi(m), nextBeat, BEAT * 1.6, { vol: 0.05, attack: 0.03, out: synthGain });
      nextBeat += BEAT; beat++;
    }
  }

  // called every animation frame with dt in seconds
  function update(dt) {
    const target = enabled && moving ? 1 : 0;
    const rate = target > musicVol ? 0.8 : 0.5;          // fade in ~1.2 s, out ~2 s
    musicVol = Math.max(0, Math.min(1, musicVol + Math.sign(target - musicVol) * rate * dt));
    if (!ctx || ctx.state !== 'running') return;

    if (useFile) {
      audio.volume = musicVol * 0.7;
      if (musicVol > 0 && audio.paused) audio.play().catch(() => {});
      if (musicVol === 0 && !audio.paused) audio.pause();
    } else if (useFile === false) {
      if (musicVol > 0) scheduleSynth();
      if (synthGain) synthGain.gain.setTargetAtTime(musicVol, ctx.currentTime, 0.05);
      if (musicVol === 0) nextBeat = 0;
    }
  }

  root.Sound = {
    press, ding, update,
    setMoving(m) { moving = m; },
    setEnabled(e) { enabled = e; if (e) ensure(); },
    get enabled() { return enabled; },
  };
})(window);
