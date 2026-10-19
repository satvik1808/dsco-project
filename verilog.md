# How the Verilog works

This guide explains every Verilog file in this project, from the smallest block to the whole system.

**Everything here uses only what the DSCO course (CES 2104) teaches.** Every Verilog construct appears in the lecture slides, and each section names the lecture it comes from. If you know Lectures 2, 13–18 and 24–33, you can read every line.

The design is simple on purpose. It doesn't run the elevators in the smartest possible way, but every part is easy to follow.

**Contents**

1. [The big picture](#1-the-big-picture)
2. [One idea used everywhere: floor vectors](#2-one-idea-used-everywhere-floor-vectors)
3. [Which syllabus topic is used where](#3-which-syllabus-topic-is-used-where)
4. [The building blocks](#4-the-building-blocks)
   - [decoder3to8.v](#41-decoder3to8v-floor-number--floor-vector)
   - [floor_masks.v](#42-floor_masksv-floors-above-and-below)
   - [priority_encoder8.v](#43-priority_encoder8v-pick-the-lowest-call)
   - [distance.v](#44-distancev-how-far-apart)
5. [elevator_car.v: one car](#5-elevator_carv-one-car)
6. [hall_call_dispatcher.v: the coordinator](#6-hall_call_dispatcherv-the-coordinator)
7. [elevator_coordinator.v: the top level](#7-elevator_coordinatorv-the-top-level)
8. [A real example, clock by clock](#8-a-real-example-clock-by-clock)
9. [The testbench and how to run it](#9-the-testbench-and-how-to-run-it)
10. [How the website is checked against the Verilog](#10-how-the-website-is-checked-against-the-verilog)
11. [Things worth remembering for the exam](#11-things-worth-remembering-for-the-exam)
12. [Signal list](#12-signal-list)

---

## 1. The big picture

There are **2 elevator cars** (Car A and Car B) and **8 floors** (0 to 7).

- Inside each car there are 8 **cabin buttons**: "take me to floor k".
- On each floor there are **hall buttons**: ▲ (I want to go up) and ▼ (I want to go down). Floor 7 has no ▲ and floor 0 has no ▼.

The design is split into small modules. Each one is a circuit from the lectures:

```
tb_elevator_coordinator                  testbench (simulation only)
└── elevator_coordinator   dut           top level: only wires
    ├── hall_call_dispatcher u_dispatch  decides which car answers each hall button
    │   ├── priority_encoder8  enc_up    lowest waiting UP call
    │   ├── priority_encoder8  enc_dn    lowest waiting DOWN call
    │   ├── distance           d0        how far Car A is from that call
    │   ├── distance           d1        how far Car B is from that call
    │   └── decoder3to8        dec_pick  floor number -> floor vector
    ├── elevator_car u_car0              Car A
    │   ├── decoder3to8        dec_here  the floor the car is on
    │   └── floor_masks        masks     floors above / below the car
    └── elevator_car u_car1              Car B (same circuit)
```

How they work together:

1. Someone presses a hall button. The **dispatcher** remembers it.
2. The dispatcher gives the call to the **nearer car**.
3. Each **car** makes a list of floors to visit: its own cabin buttons plus the hall calls it was given.
4. The car moves up or down, stopping at every floor on its list.
5. When the car opens its door at a floor, that floor is removed from its list, and the dispatcher switches the hall lamp off.

Everything happens on the rising edge of one clock. **1 clock cycle = 1 tick.** Moving one floor takes 8 ticks, and the door stays open for 10 ticks.

---

## 2. One idea used everywhere: floor vectors

Almost every signal is an **8-bit vector with one bit per floor**:

```
bit:     7 6 5 4 3 2 1 0
floor:   7 6 5 4 3 2 1 0

car_calls = 8'b00100100   means: cabin buttons for floors 5 and 2 are pressed
```

With floor vectors, the questions the elevator needs to answer become plain **bitwise operators** (Lecture 2 operator table):

| Question | Verilog | Operator used |
|---|---|---|
| All floors I must visit | `car_calls \| hall_up_asg \| hall_dn_asg` | bitwise OR |
| Is one of them on my floor? | `\|(targets & here)` | bitwise AND, then reduction OR |
| Is one of them above me? | `\|(targets & above)` | bitwise AND, then reduction OR |
| Remove my floor from the list | `car_calls & ~here` | bitwise AND with NOT |
| Add new button presses | `car_calls \| car_btn` | bitwise OR |

The **reduction OR** `|v` gives 1 if *any* bit of `v` is 1 (Lecture 16–18 slides: "Reduction Operators"). For example, `|(8'b00100000)` = 1 and `|(8'b00000000)` = 0.

A floor *number* (0–7, 3 bits) is turned into a floor *vector* with a decoder. That's the first building block.

---

## 3. Which syllabus topic is used where

| Syllabus topic | Lecture | Where it is used |
|---|---|---|
| Module, ports, `input` / `output`, comments | L2 | every file |
| Structural design: connecting modules by position | L2, L18 | `elevator_coordinator.v`, `elevator_car.v`, `hall_call_dispatcher.v` |
| Continuous assignment `assign`, bitwise and reduction operators | L2 | every file |
| Subtractor | L8 | `distance.v` |
| Comparator (`>`, `<`) | L12 | `distance.v`, `hall_call_dispatcher.v` (`dist1 < dist0`) |
| 2-to-1 multiplexer as `?:` | L13, L16 | `hall_call_dispatcher.v`, `elevator_car.v` |
| Decoder with enable | L15, L18 | `decoder3to8.v` |
| Priority encoder | L15 | `priority_encoder8.v` |
| `always` block with a sensitivity list, blocking `=` | L16 | `decoder3to8.v`, `floor_masks.v`, `priority_encoder8.v`, `next_dir` in `elevator_car.v` |
| `if` / `else`, `case`, `casex` | L17 | all `always` blocks |
| Registers: `always @(posedge clk)`, non-blocking `<=` | L27, L28 | `elevator_car.v`, `hall_call_dispatcher.v` |
| Synchronous reset | L27 | `if (rst)` in every clocked block |
| `parameter` | L28 (n-bit register) | state codes and timings in `elevator_car.v` |
| Counter (count up, clear to 0) | L31 | `timer` in `elevator_car.v` |
| Up/down counter | L26, L31 | `floor` in `elevator_car.v` (+1 going up, −1 going down) |
| Design of a synchronous sequential circuit (state machine) | L29, L30 | the 4-state FSM in `elevator_car.v` |
| Testbench: `` `timescale ``, `` `include ``, `initial`, `#` delay, `forever`, `$dumpfile`, `$dumpvars`, `$display` | L2 lab, L27 lab | `tb_elevator_coordinator.v` |

The only thing not on the slides is `$finish` in the testbench. It just stops the simulation. Without it, the `forever` clock would run forever.

---

## 4. The building blocks

These four modules are small **combinational** circuits: no clock, and the output depends only on the inputs right now.

All of them use `always @(...)` with **every input** in the sensitivity list, and **blocking `=`** assignments. That's the Lecture 16 rule for combinational logic.

### 4.1 `decoder3to8.v`: floor number → floor vector

[rtl/decoder3to8.v](rtl/decoder3to8.v). This is the 3-to-8 version of the `d2to4` decoder from the counters slides.

```verilog
module decoder3to8 (en, w, y);
    input        en;
    input  [2:0] w;
    output reg [7:0] y;

    always @(en or w)
    begin
        y = 8'b00000000;
        if (en == 1)
            case (w)
                0: y = 8'b00000001;
                1: y = 8'b00000010;
                ...
                7: y = 8'b10000000;
            endcase
    end
endmodule
```

| `en` | `w` | `y` |
|---|---|---|
| 0 | any | `00000000` |
| 1 | 3 (`011`) | `00001000` |
| 1 | 6 (`110`) | `01000000` |

`y = 8'b00000000;` comes first, so `y` always gets a value. If an `always` block leaves an output unassigned on some path, synthesis makes a latch, which we don't want.

**Used for:** `here` in each car (en = 1 always), and `pick_vec` in the dispatcher (en = "is there a call to hand out?").

### 4.2 `floor_masks.v`: floors above and below

[rtl/floor_masks.v](rtl/floor_masks.v). This is just a truth table written as a `case` statement (Lecture 17).

```verilog
always @(floor)
    case (floor)
        0: begin above = 8'b11111110; below = 8'b00000000; end
        ...
        3: begin above = 8'b11110000; below = 8'b00000111; end
        ...
        7: begin above = 8'b00000000; below = 8'b01111111; end
    endcase
```

When the car is at floor 3, `above` has a 1 for floors 4–7 and `below` has a 1 for floors 0–2. The floor itself is in neither mask.

### 4.3 `priority_encoder8.v`: pick the lowest call

[rtl/priority_encoder8.v](rtl/priority_encoder8.v). This is a priority encoder (Lecture 15) written with `casex` (Lecture 17), where `x` means "don't care".

```verilog
always @(w)
begin
    valid = 1;
    casex (w)
        8'bxxxxxxx1: y = 0;     // bit 0 is 1: answer 0, ignore the rest
        8'bxxxxxx10: y = 1;     // bit 0 is 0 and bit 1 is 1: answer 1
        8'bxxxxx100: y = 2;
        ...
        8'b10000000: y = 7;
        default: begin y = 0; valid = 0; end   // no bit is 1
    endcase
end
```

Example: `w = 8'b01010000`. Bits 6 and 4 are set. The first line that matches is `8'bxxx10000`, so `y = 4`, `valid = 1`.

`casex` takes the **first** match from the top, and that gives the priority: lower floors win.

### 4.4 `distance.v`: how far apart

[rtl/distance.v](rtl/distance.v). This is a comparator (L12) feeding a subtractor (L8) through a 2-to-1 mux (`?:`, L16).

```verilog
assign d = (a > b) ? (a - b) : (b - a);
```

Whichever number is bigger, the smaller one is subtracted from it, so the answer is never negative. `a = 1, b = 5` gives `d = 4`.

---

## 5. `elevator_car.v`: one car

[rtl/elevator_car.v](rtl/elevator_car.v). This is the main part of the project: a **synchronous sequential circuit** (Lectures 29–30) with a small datapath.

### 5.1 Ports

| Port | Width | Direction | Meaning |
|---|---|---|---|
| `clk`, `rst` | 1 | in | clock; synchronous reset (active high) |
| `car_btn` | 8 | in | cabin buttons, 1 for one clock when pressed |
| `hall_up_asg`, `hall_dn_asg` | 8 | in | hall calls the dispatcher gave to *this* car |
| `floor` | 3 | out (reg) | floor the car is at, or last passed |
| `state` | 2 | out (reg) | `IDLE` / `MOVE_UP` / `MOVE_DN` / `DOOR` |
| `dir` | 2 | out (reg) | `NONE` / `UP` / `DN`: direction of travel |
| `timer` | 4 | out (reg) | counts clock ticks while moving or while the door is open |
| `car_calls` | 8 | out (reg) | cabin buttons pressed but not served yet |
| `next_dir` | 2 | out | where the car will go next (combinational) |
| `door_open` | 1 | out | 1 in state `DOOR` |
| `serve_up`, `serve_dn` | 8 | out | hall calls answered right now (tells the dispatcher) |

### 5.2 The four rules

1. If there is a target on my floor: **stop and open the door.**
2. **Keep going** in the same direction while there are targets that way.
3. Otherwise **turn around** if there are targets the other way.
4. No targets at all: **wait** (`IDLE`).

A *target* is any floor in `targets = car_calls | hall_up_asg | hall_dn_asg`.

### 5.3 State diagram and state table

The states are given codes with `parameter`, as in Lecture 28 and the textbook FSM examples:

```verilog
parameter IDLE    = 2'b00;
parameter MOVE_UP = 2'b01;
parameter MOVE_DN = 2'b10;
parameter DOOR    = 2'b11;
```

```
                  call_here
        +--------------------------------+
        |                                v
     +------+  call_above   +---------+  call_here   +------+
     | IDLE |-------------->| MOVE_UP |------------->|      |
     |  00  |               |   01    |              | DOOR |
     |      |  call_below   +---------+              |  11  |
     |      |-------------->| MOVE_DN |------------->|      |
     +------+               |   10    |  call_here   +------+
        ^                   +---------+                 |
        |       timer done, next_dir = NONE             |
        +-----------------------------------------------+
        (timer done, next_dir = UP -> MOVE_UP;  next_dir = DN -> MOVE_DN)
```

The state table, in the style of Lecture 29. The conditions are checked from top to bottom, and the first true row wins:

| Present state | Condition | Next state | Other registers |
|---|---|---|---|
| IDLE | `call_here` | DOOR | |
| IDLE | `call_above` | MOVE_UP | dir ← UP |
| IDLE | `call_below` | MOVE_DN | dir ← DN |
| IDLE | none of these | IDLE | dir ← NONE |
| MOVE_UP | `timer == 0` and `call_here` | DOOR | |
| MOVE_UP | `timer == 0` and no `call_above` | IDLE | dir ← NONE (safety only) |
| MOVE_UP | `timer == 7` | MOVE_UP | floor ← floor + 1, timer ← 0 |
| MOVE_UP | otherwise | MOVE_UP | timer ← timer + 1 |
| MOVE_DN | (mirror of MOVE_UP, with `call_below` and floor − 1) | | |
| DOOR | `timer == 9` and `next_dir == UP` | MOVE_UP | timer ← 0, dir ← UP |
| DOOR | `timer == 9` and `next_dir == DN` | MOVE_DN | timer ← 0, dir ← DN |
| DOOR | `timer == 9` and `next_dir == NONE` | IDLE | timer ← 0, dir ← NONE |
| DOOR | otherwise | DOOR | timer ← timer + 1 |

**Why `timer == 0` means "at a floor":** while moving, the timer counts 0, 1, …, 7. On 7 the floor changes and the timer goes back to 0. So `timer == 0` is exactly the tick when the car has just arrived at a floor, and that's the only time it can decide to stop.

### 5.4 Part 1: combinational logic

```verilog
decoder3to8 dec_here (1'b1, floor, here);     // here  = one-hot floor
floor_masks masks (floor, above, below);       // masks of floors above / below

assign targets    = car_calls | hall_up_asg | hall_dn_asg;
assign call_here  = |(targets & here);
assign call_above = |(targets & above);
assign call_below = |(targets & below);
```

Example: car at floor 2, `car_calls = 00100000` (floor 5), no hall calls.

```
here       = 00000100
above      = 11111000
targets    = 00100000
call_here  = |(00100000 & 00000100) = |(00000000) = 0
call_above = |(00100000 & 11111000) = |(00100000) = 1
call_below = 0
```

**`next_dir`** applies rules 2 and 3 with a plain `if / else if` chain (Lecture 17):

```verilog
always @(dir or call_above or call_below)
begin
    if (dir == UP && call_above)      next_dir = UP;    // keep going up
    else if (dir == DN && call_below) next_dir = DN;    // keep going down
    else if (call_above)              next_dir = UP;    // turn / start up
    else if (call_below)              next_dir = DN;    // turn / start down
    else                              next_dir = NONE;
end
```

The **serve** outputs tell the dispatcher which hall calls this car is answering. Every hall call of this car at this floor counts as answered while the door is open:

```verilog
assign door_open = (state == DOOR);
assign serve_up  = door_open ? (hall_up_asg & here) : 8'b00000000;
assign serve_dn  = door_open ? (hall_dn_asg & here) : 8'b00000000;
```

### 5.5 Part 2: the cabin-call register

Eight flip-flops, one per floor, with a synchronous reset (Lecture 27):

```verilog
always @(posedge clk)
begin
    if (rst)
        car_calls <= 8'b00000000;
    else if (state == DOOR)
        car_calls <= (car_calls | car_btn) & ~here;   // add new presses, clear this floor
    else
        car_calls <= car_calls | car_btn;             // add new presses
end
```

### 5.6 Part 3: the state machine

A single `always @(posedge clk)` block with a `case (state)`. It updates the four registers `state`, `floor`, `dir` and `timer`, following the state table in 5.3 exactly. Open [rtl/elevator_car.v](rtl/elevator_car.v) and read it next to the table: each row of the table is one `if` / `else if` branch.

- `timer` is a **counter** (Lecture 31): `timer <= timer + 1`, and `timer <= 0` to clear it.
- `floor` is an **up/down counter** (Lectures 26, 31): `floor <= floor + 1` in `MOVE_UP`, `floor <= floor - 1` in `MOVE_DN`.
- Every assignment is **non-blocking `<=`**, so all registers change together at the clock edge (Lecture 27: "use non-blocking for edge-sensitive behaviour").

---

## 6. `hall_call_dispatcher.v`: the coordinator

[rtl/hall_call_dispatcher.v](rtl/hall_call_dispatcher.v)

### 6.1 The six registers

For the UP buttons (and the same again for the DOWN buttons), each an 8-bit floor vector:

| Register | A 1 in bit k means |
|---|---|
| `up_pend` | someone pressed ▲ on floor k and is still waiting (this is the lamp) |
| `up_asgd` | that call has already been given to a car |
| `up_owner` | it was given to Car B (0 = Car A) |

From these, the calls of each car are just AND gates:

```verilog
assign up_asg0 = up_pend & up_asgd & ~up_owner;   // Car A's UP calls
assign up_asg1 = up_pend & up_asgd &  up_owner;   // Car B's UP calls
```

### 6.2 Every clock cycle

```
free_up = up_pend & ~up_asgd        waiting but not given to a car yet
free_dn = dn_pend & ~dn_asgd

enc_up : priority encoder on free_up -> up_floor, up_valid
enc_dn : priority encoder on free_dn -> dn_floor, dn_valid

pick_valid = up_valid | dn_valid         is there anything to hand out?
pick_up    = up_valid                    UP calls go first
pick_floor = up_valid ? up_floor : dn_floor     (2-to-1 mux)

d0 : dist0 = |floor0 - pick_floor|       how far is Car A
d1 : dist1 = |floor1 - pick_floor|       how far is Car B
pick_car1  = (dist1 < dist0)             nearer car; a tie goes to Car A

dec_pick : pick_vec = decoder(pick_valid, pick_floor)
new_up = pick_up ? pick_vec : 0          the call handed out this cycle
new_dn = pick_up ? 0 : pick_vec
```

Only one call is handed out per clock cycle, which is plenty: a car needs 8 cycles just to move one floor.

### 6.3 Register updates

```verilog
up_pend <= (up_pend | hall_up_btn) & ~served_up;   // button sets it, serving clears it
up_asgd <= (up_asgd & ~served_up) | new_up;        // handing out sets it, serving clears it

if (pick_car1)
    up_owner <= up_owner | new_up;     // write 1 (Car B) into the new call's bit
else
    up_owner <= up_owner & ~new_up;    // write 0 (Car A) into the new call's bit
```

`served_up = serve_up0 | serve_up1` comes from the cars.

### 6.4 Why it is not "optimal" (and that's fine)

The dispatcher only looks at **distance**. It doesn't care whether a car is busy or heading the other way. So sometimes both cars end up travelling together, or a far-away call waits a little longer than it needs to.

A smarter cost (distance + number of stops + a penalty for heading away) would need more adders and comparators. The simple version still answers every call: in the 4000-cycle test the longest wait was 168 cycles.

---

## 7. `elevator_coordinator.v`: the top level

[rtl/elevator_coordinator.v](rtl/elevator_coordinator.v). This is **structural** Verilog (Lecture 2): no logic at all, just three module instances connected by wires.

Modules are connected **by position**, as in the slides (`mux4to1 Mux1 (W[0:3], S16[1:0], M[0]);`). The n-th signal in the brackets goes to the n-th port in the module's header:

```verilog
elevator_car u_car0 (
    clk, rst, car_btn0, up_asg0, dn_asg0,
    floor0, state0, dir0, timer0, calls0,
    next_dir0, door0, serve_up0, serve_dn0);
```

compared with the header of the module:

```verilog
module elevator_car (clk, rst, car_btn, hall_up_asg, hall_dn_asg,
                     floor, state, dir, timer, car_calls,
                     next_dir, door_open, serve_up, serve_dn);
```

**The loop between the blocks:** the dispatcher reads the cars' `floor` and `serve_*`, and the cars read the dispatcher's `*_asg*`. That's fine, because every path from one block to the other passes through a register (`floor`, `state`, `up_pend`, …). There is no loop made only of combinational logic.

---

## 8. A real example, clock by clock

These numbers come from the actual simulation (seed 2026). "Cycle c" means the buttons applied during cycle c, and the register values just after that clock edge.

**Car B takes a passenger from floor 0 to floor 1:**

| Cycle | Input | What happens |
|---|---|---|
| 4 | `car_btn1 = 00000010` (floor 1) | `calls1` becomes `00000010` |
| 5 | | Car B is in IDLE, `call_above = 1`, so state ← MOVE_UP, dir ← UP |
| 6–12 | | `timer1` counts 1, 2, … 7 |
| 13 | | timer was 7, so `floor1` ← 1, `timer1` ← 0 |
| 14 | | MOVE_UP, timer = 0, `call_here = 1`, so state ← DOOR |
| 15 | | the door is open, so `calls1 & ~here` clears bit 1: `calls1 = 0` |

**A hall call answered by the car that is already there:**

| Cycle | Input | What happens |
|---|---|---|
| 16 | `hall_up_btn = 00000010` (▲ at floor 1) | `up_pend = 00000010` |
| 17 | | the encoder picks floor 1. dist0 = \|0−1\| = 1, dist1 = \|1−1\| = 0, so `pick_car1 = 1`. `up_asgd` and `up_owner` bit 1 ← 1 (Car B) |
| 18 | | Car B's door is open at floor 1, so `serve_up1 = 00000010` and `up_pend`, `up_asgd` clear |

**Nearest car wins:**

| Cycle | Input | What happens |
|---|---|---|
| 49 | `hall_dn_btn = 00000100` (▼ at floor 2), `car_btn0 = 00100000` | `dn_pend = 00000100`, `calls0 = 00100000` |
| 50 | | Car A is at 0 (distance 2), Car B at 1 (distance 1). Car B is nearer, so `dn_owner` bit 2 ← 1. Car A leaves for floor 5 |

You can watch all of this in the website: open `web/index.html#replay@0` and press **Step clk**.

---

## 9. The testbench and how to run it

[tb/tb_elevator_coordinator.v](tb/tb_elevator_coordinator.v) follows the same layout as the lab testbenches:

```verilog
`timescale 1ns/1ns
`include "decoder3to8.v"            // 1. include the design files
...
module tb_elevator_coordinator();
    reg clk, rst;                     // 2. reg for inputs
    reg [7:0] hall_up_btn, ...;
    wire [2:0] floor0, floor1;        //    wire for outputs
    ...
    elevator_coordinator dut (clk, rst, ...);   // 3. instantiate

    initial begin                     // 4. clock, period 10 ns
        clk = 0;
        forever #5 clk = ~clk;
    end

    initial begin                     // 5. inputs
        $dumpfile("build/elevator.vcd");
        $dumpvars(0, tb_elevator_coordinator);
        rst = 1; hall_up_btn = 0; ...;
        #16;
        rst = 0;
        `include "stimulus.v"         //    4000 lines of button presses
        $display("Test complete");
        $finish;
    end
endmodule
```

`build/stimulus.v` is generated by `scripts/gen_stimulus.js` (random passengers). Each line is one clock cycle:

```verilog
hall_up_btn = 8'h02; hall_dn_btn = 8'h00; car_btn0 = 8'h00; car_btn1 = 8'h00; #10;  // cycle 16
```

**To run it by hand** (the same commands as the lab, from the project folder):

```sh
node scripts/gen_stimulus.js                  # makes build/stimulus.v
iverilog -I rtl -I build -o build/sim.vvp tb/tb_elevator_coordinator.v
vvp build/sim.vvp                             # prints "Test complete"
gtkwave build/elevator.vcd                    # look at the waveforms
```

`-I rtl -I build` tells iverilog which folders to search for the `` `include `` files.

**Or run everything at once:** `./run.sh`. It also runs the checks below.

In GTKWave, the useful signals are under `tb_elevator_coordinator → dut → u_car0` (state, floor, timer, call_here, call_above, …) and `dut → u_dispatch` (free_up, pick_floor, dist0, dist1, pick_car1, …). The website's **Waveforms** panel shows the same file.

---

## 10. How the website is checked against the Verilog

The website runs a JavaScript copy of this Verilog ([web/elevator_rtl.js](web/elevator_rtl.js)). Each part of the JS file matches one Verilog module.

To prove the two really behave the same, `./run.sh` runs two scripts after the simulation:

- **[scripts/verify.js](scripts/verify.js)** reads the 16 output registers from `build/elevator.vcd` on every clock cycle. It checks that:
  - every hall call was answered within 600 cycles;
  - the JS model, given the same button presses, has exactly the same 16 values on all 4000 cycles.
- **[scripts/vcd2js.js](scripts/vcd2js.js)** does the same for every internal signal in the waveform (over 150), and converts the waveform for the website.

```
Simulated 4000 cycles, 201 hall calls served, longest wait 168 cycles
PASS: every hall call answered; JS model matches Verilog on all 4000 cycles x 16 registers
PASS: 154 named signals match the VCD on every cycle
```

The "**Verilog = JS ✓**" badge in the website's replay mode is the same check, done live.

---

## 11. Things worth remembering for the exam

- **Combinational `always`:** list *every* input in `@( ... )` and use `=`. Give every output a value on every path (like `y = 0;` at the top of the decoder), or you get a latch.
- **Clocked `always`:** `@(posedge clk)` and `<=`. With `<=`, every right-hand side uses the *old* register values, so the order of the lines doesn't matter. Compare the slide example of two cascaded flip-flops, `Q1 <= D; Q2 <= Q1;`.
- **Synchronous reset:** `if (rst)` inside `@(posedge clk)` acts only on a clock edge. (An asynchronous reset would be `@(posedge clk or posedge rst)`.)
- **`case` vs `casex`:** `casex` treats `x` as "don't care", which is how the priority encoder is written in 8 lines.
- **Reduction operators:** `|v` = OR of all bits of `v`, `&v` = AND of all bits.
- **`?:`** is a 2-to-1 multiplexer: `f = s ? w1 : w0`.
- **Structural vs behavioural:** `elevator_coordinator.v` is structural (it only connects modules). `elevator_car.v` mixes both: it instantiates a decoder (structural) and describes the FSM with `case` (behavioural).
- **FSM design steps** (Lecture 29): states → state codes (`parameter`) → state table (section 5.3) → `case (state)` in a clocked `always` block.

---

## 12. Signal list

**Top level / testbench** (`tb.*`, `dut.*`)

| Signal | Width | Meaning |
|---|---|---|
| `clk` | 1 | clock, 10 ns period |
| `rst` | 1 | reset (first 16 ns) |
| `hall_up_btn`, `hall_dn_btn` | 8 | hall buttons pressed this cycle |
| `car_btn0`, `car_btn1` | 8 | cabin buttons of Car A / Car B pressed this cycle |
| `floor0/1`, `state0/1`, `dir0/1`, `timer0/1`, `calls0/1`, `door0/1` | | the car outputs below |
| `up_pend`, `up_asgd`, `up_owner`, `dn_pend`, `dn_asgd`, `dn_owner` | 8 | the dispatcher registers below |

**Car** (`u_car0`, `u_car1`)

| Signal | Width | Kind | Meaning |
|---|---|---|---|
| `state` | 2 | register | 0 IDLE, 1 MOVE_UP, 2 MOVE_DN, 3 DOOR |
| `floor` | 3 | register | current / last floor |
| `dir` | 2 | register | 0 NONE, 1 UP, 2 DN |
| `timer` | 4 | register | tick counter (0–7 moving, 0–9 door) |
| `car_calls` | 8 | register | cabin calls waiting |
| `here` | 8 | wire | one-hot current floor |
| `above`, `below` | 8 | wire | floors above / below |
| `targets` | 8 | wire | every floor to visit |
| `call_here`, `call_above`, `call_below` | 1 | wire | is there a target here / above / below |
| `next_dir` | 2 | wire | direction after the door closes |
| `door_open` | 1 | wire | state == DOOR |
| `serve_up`, `serve_dn` | 8 | wire | hall calls answered now |

**Dispatcher** (`u_dispatch`)

| Signal | Width | Kind | Meaning |
|---|---|---|---|
| `up_pend`, `dn_pend` | 8 | register | calls waiting (hall lamps) |
| `up_asgd`, `dn_asgd` | 8 | register | calls given to a car |
| `up_owner`, `dn_owner` | 8 | register | 0 = Car A, 1 = Car B |
| `free_up`, `free_dn` | 8 | wire | waiting and not yet given out |
| `up_floor`, `up_valid`, `dn_floor`, `dn_valid` | 3, 1 | wire | priority encoder outputs |
| `pick_valid`, `pick_up`, `pick_floor` | 1, 1, 3 | wire | the call being handed out |
| `dist0`, `dist1` | 3 | wire | distance of Car A / Car B |
| `pick_car1` | 1 | wire | 1 = give it to Car B |
| `pick_vec`, `new_up`, `new_dn` | 8 | wire | that call as a floor vector |
| `served_up`, `served_dn` | 8 | wire | calls answered by either car |
| `up_asg0`, `dn_asg0`, `up_asg1`, `dn_asg1` | 8 | wire | each car's calls |
