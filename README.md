# Elevator Coordinator: DSCO project

A Verilog RTL design of a **2-car, 8-floor elevator system** with a central
hall-call dispatcher, plus an animated website. The website runs a
cycle-accurate model of the same RTL and can replay the Icarus Verilog
simulation trace.

![Website in Verilog replay mode](docs/images/website.png)

## Report

The full project report covers the design, every digital-electronics concept used, verification, results and sustainability.

- [docs/REPORT.md](docs/REPORT.md): readable on GitHub
- [docs/REPORT.pdf](docs/REPORT.pdf): for printing or submission

## Run it

```sh
./run.sh            # stimulus → iverilog sim → checks → JS-vs-Verilog cross-check
open web/index.html # the website (works straight from the file system)
```

`./run.sh 8000 42` sets the simulation to 8000 cycles with random seed 42.
Waveforms are written to `build/elevator.vcd`; open them with GTKWave.

## Learn the Verilog

**Start with [verilog.md](verilog.md).** It explains every file line by line, and it
uses only what the DSCO syllabus teaches (each part says which lecture it comes from).

## Files

| Path | What it is | Syllabus |
|---|---|---|
| `rtl/decoder3to8.v` | 3-to-8 decoder: floor number → one-hot floor vector | L15, L18 |
| `rtl/floor_masks.v` | Truth table (case): which floors are above / below the car | L17 |
| `rtl/priority_encoder8.v` | Priority encoder (casex): lowest waiting call | L15, L17 |
| `rtl/distance.v` | Comparator + subtractor: `|a − b|` | L8, L12 |
| `rtl/elevator_car.v` | One car: state machine + floor, timer and cabin-call registers | L27–31 |
| `rtl/hall_call_dispatcher.v` | The coordinator: gives each hall call to the nearer car | L12–15, L26–28 |
| `rtl/elevator_coordinator.v` | Top level: connects the dispatcher and the 2 cars | L2, L18 |
| `tb/tb_elevator_coordinator.v` | Testbench in the lab style (`include`, clock with `forever`, `$dumpvars`) | Lab 2, L27 |
| `scripts/gen_stimulus.js` | Random button presses → `build/stimulus.v` (for the testbench) and `build/stim.hex` | |
| `scripts/verify.js` | Checks every hall call is answered and the JS model matches all 16 registers every cycle | |
| `scripts/vcd2js.js` | Converts `build/elevator.vcd` for the website and checks every internal signal against the JS model | |
| `web/elevator_rtl.js` | JS copy of the Verilog (1:1), runs the website | |
| `web/waves.js`, `web/sound.js` | Waveform viewer; button beeps, door chime, music | |
| `web/index.html`, `app.js`, `style.css` | The visualisation | |

## Design (in short)

**Each car** (`elevator_car.v`) is a 4-state machine: `IDLE`, `MOVE_UP`, `MOVE_DN`, `DOOR`.

1. If there is a target at this floor, stop and open the door (10 clock cycles).
2. Keep going the same way while there are targets that way.
3. Otherwise turn around if there are targets the other way.
4. No targets: wait in `IDLE`.

Moving one floor takes 8 clock cycles. A car's targets are its cabin buttons plus the hall calls the dispatcher gave it.

**The dispatcher** (`hall_call_dispatcher.v`) keeps `pend`, `asgd` and `owner` registers for the UP and DOWN buttons.
Each cycle a priority encoder picks one waiting call, and it goes to the **nearer car** (tie → Car A).
When that car opens its door at the floor, the call is cleared.

This is deliberately simple rather than optimal.

## Verification

- `scripts/verify.js`: no hall call waits more than 600 cycles, and the JS model matches all 16 registers on every cycle. Replay mode in the website repeats this check live (the "Verilog = JS ✓" badge).
- `scripts/vcd2js.js`: the same check for every named signal in the VCD (over 150), including internal ones like `call_above`, `next_dir`, `pick_floor` and `dist0`.

## Website

- **Live RTL:** click hall ▲▼ or cabin buttons, or let random traffic run.
- **Verilog replay:** plays back the Icarus Verilog simulation (`build/elevator.vcd`). Open `web/index.html#replay@1200` to jump to cycle 1200.
- **Views:** FSM diagrams with the last transition highlighted, dispatcher register bits, the distance of each car for every assignment, a position-vs-time chart, and an event log.
- **Waveforms:** a GTKWave-style viewer under the animation.
  - In replay mode it shows the real `build/elevator.vcd`; in live mode it records the same signals, with the same names, from the JS model.
  - Presets: Top I/O, Car A, Car B, Dispatcher. Type in the search box to add any other signal.
  - Drag or scroll to pan, ctrl + scroll to zoom, click to place a marker. In replay mode, a click jumps the simulation to that time.
- **Sound** (toggle in the header):
  - a beep on every button press and a chime when doors open
  - music that fades in while any car is moving
  - for the music, the track at `web/songbird.mp3` plays (swap in your own file to change it), or click **♪ music** in the header to pick a song file in the browser; the page remembers it (shift-click to clear). Without either, an original synthesized lounge loop plays
- **Keys:** Space runs or pauses; `s` or → steps one clock.
