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
  // Source order: a track the viewer picked (kept in IndexedDB), else web/songbird.mp3,
  // else the synthesised loop. The synth only stands in until a file is ready.
  const audio = new Audio();
  let useFile = false, picked = false, onTrack = () => {};
  audio.loop = true;
  audio.preload = 'auto';
  audio.addEventListener('canplay', () => { useFile = true; stopSynth(); onTrack(trackName()); });
  audio.addEventListener('error', () => { useFile = false; onTrack(trackName()); });

  function trackName() { return useFile ? (picked ? picked : MUSIC_FILE) : null; }

  function setFile(blob, name) {
    picked = name || 'your track';
    const wasPlaying = !audio.paused;
    useFile = false;
    audio.src = URL.createObjectURL(blob);
    if (wasPlaying) audio.play().catch(() => {});
  }

  // remember a picked track across visits (one record in IndexedDB)
  function db(mode, fn) {
    try {
      const req = indexedDB.open('elevator-music', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('t');
      req.onsuccess = () => { try { fn(req.result.transaction('t', mode).objectStore('t')); } catch (e) {} };
    } catch (e) {}
  }
  function pick(file) {
    setFile(file, file.name);
    db('readwrite', s => s.put({ blob: file, name: file.name }, 'track'));
  }
  function forget() {
    picked = false; useFile = false;
    db('readwrite', s => s.delete('track'));
    audio.src = MUSIC_FILE;
  }

  audio.src = MUSIC_FILE;
  db('readonly', s => { const r = s.get('track'); r.onsuccess = () => { if (r.result) setFile(r.result.blob, r.result.name); }; });

  // fallback: an original slow lounge progression (Fmaj7 Em7 Dm7 Cmaj7) on soft keys + bass
  const CHORDS = [[53, 57, 60, 64], [52, 55, 59, 62], [50, 53, 57, 60], [48, 52, 55, 59]];
  const MELODY = [72, null, 69, 71, 72, null, 76, null, 74, null, 72, 71, 69, null, 67, null];
  const midi = n => 440 * Math.pow(2, (n - 69) / 12);
  let synthGain = null, nextBeat = 0, beat = 0;
  const BEAT = 0.5;                // seconds per beat (120 bpm, half-time feel)

  function stopSynth() {
    if (synthGain && ctx) synthGain.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
    nextBeat = 0;
  }

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
    } else {
      if (musicVol > 0) scheduleSynth();
      if (synthGain) synthGain.gain.setTargetAtTime(musicVol, ctx.currentTime, 0.05);
      if (musicVol === 0) nextBeat = 0;
    }
  }

  root.Sound = {
    press, ding, update, pick, forget,
    onTrack(fn) { onTrack = fn; fn(trackName()); },
    setMoving(m) { moving = m; },
    setEnabled(e) { enabled = e; if (e) ensure(); },
    get enabled() { return enabled; },
  };
})(window);
