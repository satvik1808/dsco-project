# How the Verilog works

This document explains the Verilog side of the elevator coordinator in full: every module, every register, every wire, the circuit each line becomes, how the modules talk to each other on each clock cycle, and how the testbench and scripts simulate and check it.

For the project-level write-up (objectives, results, sustainability), see [docs/REPORT.md](docs/REPORT.md). This file is the code companion: read it next to the three files in [rtl/](rtl/).

**Contents**

1. [The big picture](#1-the-big-picture)
2. [Conventions used everywhere](#2-conventions-used-everywhere)
3. [`elevator_car.v`: one elevator car](#3-elevator_carv-one-elevator-car)
4. [`hall_call_dispatcher.v`: the coordinator](#4-hall_call_dispatcherv-the-coordinator)
5. [`elevator_coordinator.v`: the top level](#5-elevator_coordinatorv-the-top-level)
6. [What happens in one clock cycle](#6-what-happens-in-one-clock-cycle)
7. [A real example from the simulation](#7-a-real-example-from-the-simulation)
8. [The testbench](#8-the-testbench)
9. [The build and check flow (`run.sh`)](#9-the-build-and-check-flow-runsh)
10. [Coding rules the RTL follows](#10-coding-rules-the-rtl-follows)
11. [Limits and edge behaviour](#11-limits-and-edge-behaviour)
12. [Signal index](#12-signal-index)

---

## 1. The big picture

The design is a 2-car, 8-floor elevator system. It has three modules:

```
tb_elevator_coordinator            testbench (simulation only, not hardware)
└── elevator_coordinator  dut      top level: just wiring
    ├── hall_call_dispatcher  u_dispatch   owns the hall (landing) calls, assigns each to a car
    ├── elevator_car          u_car0       Car A
    └── elevator_car          u_car1       Car B  (same module, second copy)
```

How the pieces are connected:

```
   hall_up_btn[7:0] ──┐                          car_btn0[7:0]      car_btn1[7:0]
   hall_dn_btn[7:0] ──┤                                │                  │
                      ▼                                ▼                  ▼
          ┌────────────────────────┐  up_asg0/dn_asg0 ┌────────┐          ┌────────┐
          │  hall_call_dispatcher  │ ───────────────► │ car 0  │          │ car 1  │
          │                        │  up_asg1/dn_asg1 │        │          │        │
          │  up_pend  up_asgd      │ ─────────────────┼────────┼────────► │        │
          │  up_owner dn_pend ...  │                  │        │          │        │
          │                        │ ◄─────────────── │ floor, state, dir, next_dir,
          │                        │   status +       │ car_calls, serve_up, serve_dn
          └────────────────────────┘   serve strobes  └────────┘          └────────┘
```

- **Hall buttons** (the ▲/▼ buttons on each landing) go only to the dispatcher.
- **Cabin buttons** (the floor buttons inside a car) go straight to that car.
- The two cars never talk to each other. All coordination goes through the dispatcher.
- The dispatcher tells each car which hall calls are its responsibility (`hall_up_asg`, `hall_dn_asg`).
- Each car reports back where it is, what it is doing, and which hall calls it just answered (`serve_up`, `serve_dn`).

### One clock = one tick

Everything is **synchronous**: one clock `clk`, one synchronous active-high reset `rst`, and every register updates on the rising edge. Physical time is counted in clock cycles:

| Event | Duration |
| --- | --- |
| Travel one floor | `TRAVEL_TICKS` = 8 cycles |
| Door open (after the last passenger is served) | `DOOR_TICKS` = 10 cycles |
| Latch a button press | 1 cycle |
| Assign a hall call to a car | 1 cycle |

### All the state there is

The whole system has **88 flip-flops**. Everything else is combinational logic that computes the next value of those 88 bits.

| Where | Register | Bits |
| --- | --- | --- |
| Each car (× 2) | `floor` | 3 |
| | `state` | 2 |
| | `dir` | 2 |
| | `timer` | 5 |
| | `car_calls` | 8 |
| | *subtotal per car* | *20* |
| Dispatcher | `up_pend`, `up_asgd`, `up_owner` | 3 × 8 |
| | `dn_pend`, `dn_asgd`, `dn_owner` | 3 × 8 |
| | *subtotal* | *48* |
| **Total** | | **20 × 2 + 48 = 88** |

---

## 2. Conventions used everywhere

### 2.1 One bit per floor

Every set of requests is an `N`-bit vector where **bit i means floor i**. With N = 8:

```
bit:     7 6 5 4 3 2 1 0
floor:   7 6 5 4 3 2 1 0        e.g. 8'b0010_0100 = requests at floors 5 and 2
```

This turns "is there anything above me?" into a single AND followed by an OR-reduction, with no loops or counters. It is the key trick in the whole design.

### 2.2 Encodings

FSM state (`state`, 2 bits) in [elevator_car.v:35](rtl/elevator_car.v#L35):

| Name | Code | Meaning |
| --- | --- | --- |
| `S_IDLE` | `2'd0` | Parked with the door shut |
| `S_UP` | `2'd1` | Moving up (MOVE_UP) |
| `S_DN` | `2'd2` | Moving down (MOVE_DN) |
| `S_DOOR` | `2'd3` | Stopped with the door open |

Direction (`dir`, `next_dir`, 2 bits) in [elevator_car.v:37](rtl/elevator_car.v#L37):

| Name | Code |
| --- | --- |
| `D_NONE` | `2'd0` |
| `D_UP` | `2'd1` |
| `D_DN` | `2'd2` |

The dispatcher repeats the constants it needs (`S_DOOR`, `D_*`) as its own `localparam`s ([hall_call_dispatcher.v:37-38](rtl/hall_call_dispatcher.v#L37-L38)). The two copies must stay in sync.

### 2.3 Parameters

| Parameter | Default | Used for |
| --- | --- | --- |
| `N` | 8 | Number of floors = width of every request vector |
| `FW` | 3 | Width of a floor number; must equal log₂N |
| `TRAVEL_TICKS` | 8 | Cycles per floor of travel |
| `DOOR_TICKS` | 10 | Cycles the door stays open |

The top level passes all four down to the cars and `N`, `FW` to the dispatcher, so changing them in one place changes the whole design. See [section 11](#11-limits-and-edge-behaviour) for how far they can be pushed.

### 2.4 Inputs are one-cycle pulses

A button input is high for exactly one clock cycle when pressed. The design must remember the request until it is served, so every request has a **set/clear register**:

```verilog
reg_next = (reg | pulse) & ~clear;
```

- `pulse` sets the bit (button pressed),
- the bit holds itself (`reg |`),
- `clear` resets it (request served),
- clear wins if both happen on the same cycle.

Per bit, this is an SR latch made from a D flip-flop, an OR gate and an AND gate. The design uses this pattern four times: `car_calls`, `up_pend`, `dn_pend`, and (with a different set term) `up_asgd`/`dn_asgd`.

---

## 3. `elevator_car.v`: one elevator car

File: [rtl/elevator_car.v](rtl/elevator_car.v). The same module is instantiated twice.

The car is a classic **FSM + datapath**:

- **Control (FSM):** the `state` register and its next-state logic decide *what* to do: wait, move, stop, open the door.
- **Datapath:** the `floor` counter, the `timer` counter and the `car_calls` request register, plus comparators and masks that report status back to the FSM (`any_above`, `stop_up`, `timer == 7`, …).

### 3.1 Ports

| Port | Dir | Width | Meaning |
| --- | --- | --- | --- |
| `clk`, `rst` | in | 1 | Clock, synchronous reset |
| `car_btn` | in | N | Cabin buttons, one-cycle pulses |
| `hall_up_asg` | in | N | Hall ▲ calls the dispatcher has given to *this* car |
| `hall_dn_asg` | in | N | Hall ▼ calls given to this car |
| `floor` | out reg | FW | Last floor the car reached |
| `state` | out reg | 2 | FSM state |
| `dir` | out reg | 2 | Direction the car has committed to |
| `timer` | out reg | 5 | Tick counter for travel and door |
| `car_calls` | out reg | N | Latched cabin calls |
| `serve_up` | out wire | N | One-hot strobe: "I answered the ▲ call at this floor this cycle" |
| `serve_dn` | out wire | N | Same for ▼ |
| `next_dir` | out wire | 2 | Direction the car will take when it next leaves |
| `door_open` | out wire | 1 | Door is open |

Registers are declared directly as `output reg`, so the outputs are the flip-flops themselves (no extra logic between the register and the pin).

### 3.2 Request decoding (combinational)

[elevator_car.v:42-56](rtl/elevator_car.v#L42-L56). These wires turn the current floor and the request vectors into a handful of yes/no status bits.

```verilog
wire [N-1:0] here       = {{(N-1){1'b0}}, 1'b1} << floor;  // one-hot floor
wire [N-1:0] targets    = car_calls | hall_up_asg | hall_dn_asg;
wire [N-1:0] mask_below = here - 1'b1;                     // floors < current
wire [N-1:0] mask_above = ~(mask_below | here);            // floors > current
```

**`here`**: a 1 shifted left by `floor`. `{{(N-1){1'b0}}, 1'b1}` is just an N-bit constant 1 (the replication makes it the right width for any N). Shifting a constant by a variable amount is a **3-to-8 decoder**: binary floor number in, one-hot vector out.

**`targets`**: every floor this car has a reason to visit: its own cabin calls plus the hall calls assigned to it. This is 8 three-input OR gates.

**`mask_below`**: subtracting 1 from a one-hot number turns the 1 into 0 and every bit below it into 1. This is a cheap way to get a "thermometer" mask with no loop:

```
floor      = 3
here       = 0000_1000
here - 1   = 0000_0111   = mask_below  (floors 0, 1, 2)
mask_below | here
           = 0000_1111
~(...)     = 1111_0000   = mask_above  (floors 4, 5, 6, 7)
```

In hardware, `here - 1` is an 8-bit decrementer (a borrow chain). `mask_above` is 8 NOR gates.

Then the status bits:

```verilog
wire any_above = |(targets & mask_above);   // work above me?
wire any_below = |(targets & mask_below);   // work below me?
wire any_here  = |(targets & here);         // work at this floor?
```

Each is 8 AND gates followed by an 8-input **OR-reduction** (`|vector`), which is a small tree of OR gates.

```verilog
wire want_up = any_above | (|(hall_up_asg & here));
wire want_dn = any_below | (|(hall_dn_asg & here));
```

`want_up` / `want_dn` mean "there is demand in this direction". They add one thing to `any_above` / `any_below`: **a hall call at the current floor counts as demand in its own direction**. A passenger standing at floor 3 who pressed ▲ will ride up, so the car should leave upward even if nothing else is above it. Without this term a car could arrive, see nothing further up, turn around, and leave that passenger behind forever. This exact bug was caught by the testbench's liveness check; the history is in [REPORT.md §8](docs/REPORT.md#8-bug-found-by-verification-call-starvation).

### 3.3 Direction choice: `next_dir` (the SCAN rule)

[elevator_car.v:59-62](rtl/elevator_car.v#L59-L62):

```verilog
assign next_dir = (dir == D_UP && want_up) ? D_UP :
                  (dir == D_DN && want_dn) ? D_DN :
                  want_up                  ? D_UP :
                  want_dn                  ? D_DN : D_NONE;
```

This is a **priority multiplexer**: the first true condition wins.

| Priority | Condition | `next_dir` | Meaning |
| --- | --- | --- | --- |
| 1 | already going up and there is demand up | UP | Keep sweeping up |
| 2 | already going down and there is demand down | DN | Keep sweeping down |
| 3 | demand up | UP | Reverse, or start, upward |
| 4 | demand down | DN | Reverse, or start, downward |
| 5 | nothing | NONE | Go idle |

Rows 1 and 2 are the **SCAN** (or "elevator") algorithm: a car does not change direction while there is still work ahead of it. This stops a car from bouncing between two floors while a passenger at the far end waits. Rows 3 and 4 only matter once the current direction has run out of work. When `dir` is NONE and there is demand both ways, UP wins, purely because it is checked first.

`next_dir` is used in three places: deciding which way to go when the door closes, deciding which hall calls the open door may answer, and by the dispatcher's cost function (a car with its door open is about to go `next_dir`).

### 3.4 Door and serving logic

[elevator_car.v:64-73](rtl/elevator_car.v#L64-L73):

```verilog
wire in_door = (state == S_DOOR);
assign door_open = in_door;
```

`door_open` depends only on the state register, so it is a **Moore output**: it can only change on a clock edge and can never glitch. That is also why the door can never be open while the car is moving: those are different values of the same 2-bit register.

```verilog
assign serve_up = (in_door && next_dir != D_DN) ? (hall_up_asg & here) : {N{1'b0}};
assign serve_dn = (in_door && next_dir != D_UP) ? (hall_dn_asg & here) : {N{1'b0}};
```

While the door is open, a hall call at this floor is answered only if the car is not about to leave the *other* way. A ▼ passenger is not served by a car that is going up next. That call stays lit and the car comes back for it later. ([Section 7](#7-a-real-example-from-the-simulation) shows this happening in the real simulation.)

`serve_up` is either zero or a one-hot vector (it is ANDed with `here`). It goes to the dispatcher, which clears that call. In gates: an AND-gate enable on 8 AND gates.

```verilog
wire serve_car = in_door && |((car_calls | car_btn) & here);
wire serving   = serve_car | (|serve_up) | (|serve_dn);
```

`serve_car` is true when a cabin call for this floor is being cleared. It also includes `car_btn` directly, so pressing the button for the floor you are already on while the door is open counts as serving (like holding a door-open button). `serving` is "someone was served at this stop this cycle", and it restarts the door timer.

`serve_up`, `serve_dn`, `serve_car` and `serving` depend on inputs as well as the state, so they are **Mealy-style** signals. They are only ever used to compute register next-values, never to drive anything asynchronously.

### 3.5 Stop decision

[elevator_car.v:76-77](rtl/elevator_car.v#L76-L77):

```verilog
wire stop_up = (|(here & (car_calls | hall_up_asg))) | ((|(here & hall_dn_asg)) & ~any_above);
wire stop_dn = (|(here & (car_calls | hall_dn_asg))) | ((|(here & hall_up_asg)) & ~any_below);
```

When a car moving up reaches a floor, it stops if:

| Request at this floor | Stop going up? | Why |
| --- | --- | --- |
| Cabin call | Always | Someone inside wants to get off |
| ▲ hall call | Always | Someone wants to go the same way |
| ▼ hall call | Only if nothing above (`~any_above`) | Otherwise finish the up sweep first, then pick them up on the way down |
| Nothing | No | |

`stop_dn` is the mirror image. Both are **sum-of-products** expressions: a few AND gates, OR-reductions and one inverter.

### 3.6 The clocked block

[elevator_car.v:82-127](rtl/elevator_car.v#L82-L127). Everything in here happens on the rising edge of `clk`, with non-blocking assignments (`<=`), so every register updates at the same instant from values computed before the edge.

#### Reset

```verilog
if (rst) begin
    floor <= 0; state <= S_IDLE; dir <= D_NONE; timer <= 0; car_calls <= 0;
end
```

Synchronous reset: it only acts on a clock edge. Each car starts at floor 0, idle, with no calls.

#### Cabin-call register

```verilog
car_calls <= (car_calls | car_btn) & ~(in_door ? here : {N{1'b0}});
```

The set/clear pattern from [§2.4](#24-inputs-are-one-cycle-pulses). New presses are ORed in. While the door is open, the bit for the current floor is cleared, which means the passenger for this floor has got off. This line runs every cycle regardless of state, so buttons are latched while the car is moving too. A press for the current floor while the door is open is cleared on the same edge it would be set, so it is never stored, but it does hold the door through `serve_car`.

#### FSM: next-state logic

The `case (state)` is the FSM. Each state's branch is a priority chain of `if`/`else if`.

**`S_IDLE`**:

```verilog
timer <= 0;
if (any_here)       state <= S_DOOR;
else if (any_above) begin state <= S_UP; dir <= D_UP; end
else if (any_below) begin state <= S_DN; dir <= D_DN; end
else                dir <= D_NONE;
```

Work at this floor opens the door straight away. Otherwise the car heads toward work, preferring up. With no work it stays idle.

**`S_UP`** (`S_DN` is the mirror):

```verilog
if (timer == 0 && stop_up)          state <= S_DOOR;
else if (timer == 0 && !any_above)  begin state <= S_IDLE; dir <= D_NONE; end
else if (timer == TRAVEL_TICKS - 1) begin floor <= floor + 1; timer <= 0; end
else                                timer <= timer + 1;
```

`timer == 0` means "the car is level with `floor`". That is the only moment it can stop. Between floors (timer 1 to 7) it just keeps counting, because a real car cannot stop between floors. When the timer reaches `TRAVEL_TICKS - 1` the floor counter steps and the timer wraps to 0, so the car spends exactly `TRAVEL_TICKS` cycles per floor.

```
cycle:    ... │ t0 │ t1 │ t2 │ t3 │ t4 │ t5 │ t6 │ t7 │ t0 │ ...
timer:        │ 0  │ 1  │ 2  │ 3  │ 4  │ 5  │ 6  │ 7  │ 0  │
floor:        │ 3  │ 3  │ 3  │ 3  │ 3  │ 3  │ 3  │ 3  │ 4  │
              ▲ decide: stop at 3?                    ▲ decide: stop at 4?
```

The second branch (`!any_above` → IDLE) is a safety net. In normal operation it is not reached: a car's targets cannot disappear while it moves, because cabin calls and hall calls are only cleared by the car's own open door.

**`S_DOOR`**:

```verilog
if (serving) timer <= 0;                       // someone new got on: hold door
else if (timer == DOOR_TICKS - 1) begin
    timer <= 0;
    case (next_dir)
        D_UP:    begin state <= S_UP;   dir <= D_UP;   end
        D_DN:    begin state <= S_DN;   dir <= D_DN;   end
        default: begin state <= S_IDLE; dir <= D_NONE; end
    endcase
end
else timer <= timer + 1;
```

The door stays open until `DOOR_TICKS` cycles pass with nobody being served. Any serve restarts the count. When it times out, the car leaves in `next_dir`, which is where SCAN takes effect. It moves directly into `S_UP`/`S_DN` with timer 0, so on the very next cycle it is "level with the floor, deciding". At that moment there is nothing left to serve here, so it starts counting.

#### Full transition table

| From | Condition (first true wins) | To | Side effects |
| --- | --- | --- | --- |
| IDLE | `any_here` | DOOR | `timer` = 0 |
| IDLE | `any_above` | UP | `dir` = UP |
| IDLE | `any_below` | DN | `dir` = DN |
| IDLE | otherwise | IDLE | `dir` = NONE |
| UP | `timer==0 && stop_up` | DOOR | |
| UP | `timer==0 && !any_above` | IDLE | `dir` = NONE |
| UP | `timer==TRAVEL_TICKS-1` | UP | `floor`++, `timer` = 0 |
| UP | otherwise | UP | `timer`++ |
| DN | `timer==0 && stop_dn` | DOOR | |
| DN | `timer==0 && !any_below` | IDLE | `dir` = NONE |
| DN | `timer==TRAVEL_TICKS-1` | DN | `floor`--, `timer` = 0 |
| DN | otherwise | DN | `timer`++ |
| DOOR | `serving` | DOOR | `timer` = 0 |
| DOOR | `timer==DOOR_TICKS-1`, `next_dir`=UP | UP | `dir` = UP, `timer` = 0 |
| DOOR | `timer==DOOR_TICKS-1`, `next_dir`=DN | DN | `dir` = DN, `timer` = 0 |
| DOOR | `timer==DOOR_TICKS-1`, `next_dir`=NONE | IDLE | `dir` = NONE, `timer` = 0 |
| DOOR | otherwise | DOOR | `timer`++ |

The same transitions as arrows (a drawn diagram is in [docs/images/car-fsm.png](docs/images/car-fsm.png)):

```
IDLE ──any_here──────────────► DOOR        UP   ──timer==0 && stop_up──────► DOOR
IDLE ──any_above─────────────► UP          DN   ──timer==0 && stop_dn──────► DOOR
IDLE ──any_below─────────────► DN          DOOR ──timeout, next_dir = UP───► UP
UP   ──timer==0 && !any_above► IDLE        DOOR ──timeout, next_dir = DN───► DN
DN   ──timer==0 && !any_below► IDLE        DOOR ──timeout, next_dir = NONE─► IDLE
DOOR ──serving───────────────► DOOR  (timer restarts)
```

#### Why the floor can never leave the shaft

At the top floor `mask_above` is all zeros, so `any_above` is 0. A car in `S_UP` at timer 0 on floor 7 therefore either stops or goes idle; it never starts counting toward floor 8. The bottom floor is the same with `mask_below`. This is true by construction, and the testbench checks it anyway.

### 3.7 What the car becomes in hardware

| Verilog | Circuit |
| --- | --- |
| `1 << floor` | 3-to-8 decoder |
| `here - 1` | 8-bit decrementer (borrow chain) |
| `~(mask_below \| here)` | 8 NOR gates |
| `\|(targets & mask)` | 8 AND gates + 8-input OR tree |
| `next_dir` `?:` chain | 4-level priority multiplexer, 2 bits wide |
| `timer == TRAVEL_TICKS-1`, `state == S_DOOR` | Equality comparators against constants (AND of matching bits) |
| `floor + 1`, `floor - 1` | 3-bit up/down counter |
| `timer + 1` with clear | 5-bit counter with synchronous clear |
| `car_calls` update | 8 set/clear cells (OR, AND, D flip-flop) |
| `case (state)` | FSM next-state logic feeding a 2-bit state register |
| Registers | 20 D flip-flops with synchronous reset |

---

## 4. `hall_call_dispatcher.v`: the coordinator

File: [rtl/hall_call_dispatcher.v](rtl/hall_call_dispatcher.v). Its jobs:

1. Remember every hall button press until it is served.
2. Give each new call to exactly one car, the one with the lowest cost.
3. Tell each car which calls are its own.
4. Clear a call when its car answers it.

### 4.1 Ports

| Port | Dir | Width | Meaning |
| --- | --- | --- | --- |
| `hall_up_btn`, `hall_dn_btn` | in | N | Landing buttons (pulses) |
| `floor0/1`, `state0/1`, `dir0/1`, `ndir0/1`, `calls0/1` | in | various | Live status of both cars, for the cost function |
| `serve_up0/1`, `serve_dn0/1` | in | N | Serve strobes from the cars |
| `up_pend`, `up_asgd`, `up_owner`, `dn_pend`, `dn_asgd`, `dn_owner` | out reg | N | The call registers |
| `up_asg0`, `dn_asg0`, `up_asg1`, `dn_asg1` | out wire | N | Per-car assignment vectors |

### 4.2 The three registers per direction

For each direction there are three N-bit registers. Together, bit i of each describes the call at floor i:

| `pend[i]` | `asgd[i]` | `owner[i]` | Meaning |
| --- | --- | --- | --- |
| 0 | 0 | x | No call |
| 1 | 0 | x | Call waiting, not yet given to a car |
| 1 | 1 | 0 | Call belongs to car 0 (A) |
| 1 | 1 | 1 | Call belongs to car 1 (B) |

`owner[i]` is only meaningful while `asgd[i]` is 1. After a call is served the owner bit is left as it was ("stale"). That is harmless, because everything that reads `owner` also requires `asgd`, and the bit is rewritten the next time that call is assigned.

A call's life:

```
  button pulse          picked by the encoder,         serve strobe from the
  ───────────►  PENDING ─────────────────────────► ASSIGNED ─────────────────────► (none)
               pend=1,asgd=0   cost decides owner  pend=1,asgd=1     owner car
```

The per-car views are plain AND gates ([hall_call_dispatcher.v:40-43](rtl/hall_call_dispatcher.v#L40-L43)):

```verilog
assign up_asg0 = up_pend & up_asgd & ~up_owner;   // ▲ calls car 0 must answer
assign up_asg1 = up_pend & up_asgd &  up_owner;   // ▲ calls car 1 must answer
// same for dn
```

A call is never in both `up_asg0` and `up_asg1`, because `owner` is a single bit. So exactly one car is responsible for each assigned call.

### 4.3 Picking one call per cycle (priority encoder)

[hall_call_dispatcher.v:48-61](rtl/hall_call_dispatcher.v#L48-L61):

```verilog
always @* begin
    pick_valid = 0; pick_up = 0; pick_floor = 0;
    for (i = N-1; i >= 0; i = i - 1)
        if (dn_pend[i] && !dn_asgd[i]) begin pick_valid = 1; pick_up = 0; pick_floor = i; end
    for (i = N-1; i >= 0; i = i - 1)
        if (up_pend[i] && !up_asgd[i]) begin pick_valid = 1; pick_up = 1; pick_floor = i; end
end
```

The dispatcher assigns **at most one call per clock**, so it needs to choose one of up to 14 unassigned calls. In a combinational `always @*` block, a later assignment overrides an earlier one. So:

- each loop counts **down** from floor N-1 to 0, which means the **lowest** floor that matches is written last and wins;
- the UP loop runs after the DOWN loop, so **any unassigned ▲ call beats every ▼ call**.

Final priority: lowest ▲ call, then lowest ▼ call.

| Output | Meaning |
| --- | --- |
| `pick_valid` | There is at least one unassigned call |
| `pick_up` | The chosen call is ▲ (1) or ▼ (0) |
| `pick_floor` | Its floor number |

The block assigns defaults to all three outputs at the top, so every output is driven on every path and synthesis does not infer a latch. The loops unroll into a fixed-priority encoder: 16 request lines in, a valid bit, a direction bit and a 3-bit index out. It is the same circuit used in interrupt controllers.

Because one call is assigned per cycle and a car needs 8 cycles to cross one floor, the one-per-cycle limit never slows anything down in practice. Even if all 14 calls were pressed at once, they would all be assigned within 14 cycles.

### 4.4 Load: how busy each car is

```verilog
function [3:0] popcount(input [N-1:0] v); ... for (k...) popcount = popcount + v[k]; ...
wire [3:0] load0 = popcount(calls0 | up_asg0 | dn_asg0);
wire [3:0] load1 = popcount(calls1 | up_asg1 | dn_asg1);
```

`load` is the number of different floors a car already has to stop at. The vectors are ORed before counting, so a floor with both a cabin call and a hall call counts once, because it is one stop. `popcount` (population count) counts the 1 bits. The loop unrolls into an **adder tree**: 8 one-bit inputs summed to a 4-bit result from 0 to 8.

### 4.5 The cost function

[hall_call_dispatcher.v:76-95](rtl/hall_call_dispatcher.v#L76-L95):

```
cost = distance + load + (en_route ? 0 : 2N)
```

Lower is better. Step by step:

**1. Distance.**

```verilog
dist = (cf > f) ? (cf - f) : (f - cf);
```

An unsigned absolute difference |car floor − call floor|: a magnitude comparator chooses between two subtractors with a 2:1 multiplexer. There is no signed arithmetic anywhere in the design.

**2. Effective direction.**

```verilog
edir = (cst == S_DOOR) ? cndir : cdir;
```

A car with its door open is about to leave in `next_dir`, which may differ from the direction it arrived in. So for a stopped car the cost uses `next_dir`, and for a moving or idle car it uses `dir`.

**3. Is the call on the car's way?**

```verilog
if (edir == D_NONE)    en_route = 1;
else if (edir == D_UP) en_route =  up && ((f > cf) || (f == cf && cst == S_DOOR));
else                   en_route = !up && ((f < cf) || (f == cf && cst == S_DOOR));
```

| Car | Call | `en_route` |
| --- | --- | --- |
| Idle (no direction) | anything | yes |
| Heading up | ▲ above the car | yes |
| Heading up | ▲ at the car's floor, door open | yes (it can just take them) |
| Heading up | ▲ at the car's floor, moving | no (`floor` is the last floor reached, so the car has already left it) |
| Heading up | ▲ below, or any ▼ | no |
| Heading down | mirror image | |

**4. Penalty.** A car that is not en route gets `+2N` = +16. That is larger than any possible distance plus load difference (at most 7 + 8 = 15), so **a car that is on its way always beats one that is not**. Distance and load only break ties between two cars in the same category.

**Widths.** `dist` ≤ 7 (3 bits), `load` ≤ 8 (4 bits), penalty 16, so `cost` ≤ 31. It is declared 6 bits, which leaves headroom. The expression is evaluated at 32 bits (because of the integer `2 * N`) and truncated on return, which is safe since the result fits.

**5. Decision.**

```verilog
wire [5:0] cost0 = cost(floor0, state0, dir0, ndir0, pick_floor, pick_up, load0);
wire [5:0] cost1 = cost(floor1, state1, dir1, ndir1, pick_floor, pick_up, load1);
wire       pick_car1 = (cost1 < cost0);
```

The function is called twice, so synthesis builds **two copies** of the cost circuit side by side, one per car, followed by a 6-bit magnitude comparator. A tie goes to car 0 because the comparison is strict (`<`). That keeps the result deterministic.

### 4.6 Turning the decision into register updates

```verilog
wire [N-1:0] pick_vec  = pick_valid ? (1 << pick_floor) : 0;   // one-hot, or 0
wire [N-1:0] new_up    = pick_up  ? pick_vec : 0;              // the ▲ call being assigned
wire [N-1:0] new_dn    = !pick_up ? pick_vec : 0;              // the ▼ call being assigned
wire [N-1:0] served_up = serve_up0 | serve_up1;                // either car answered
wire [N-1:0] served_dn = serve_dn0 | serve_dn1;
```

`pick_vec` is another 3-to-8 decoder, gated by `pick_valid`. Exactly one bit of `new_up | new_dn` is set on a cycle when a call is picked, and none otherwise.

[hall_call_dispatcher.v:110-123](rtl/hall_call_dispatcher.v#L110-L123):

```verilog
up_pend  <= (up_pend | hall_up_btn) & ~served_up;                      // set by button, clear on serve
up_asgd  <= (up_asgd & ~served_up) | new_up;                           // set when picked, clear on serve
up_owner <= (up_owner & ~new_up) | (pick_car1 ? new_up : 0);           // write the winner's bit
// identical three lines for dn_*
```

- **`pend`** is the set/clear pattern. If a button is pressed on the same cycle its call is being served, clear wins. That person is at the open door already.
- **`asgd`**: the call being picked gets set. Served calls get cleared.
- **`owner`**: only the bit being picked changes. It becomes 1 if car 1 won and 0 if car 0 won. Every other bit keeps its value.

Two properties follow from these equations:

- **A call cannot be picked and served in the same cycle.** Picking needs `asgd = 0`; a car can only serve calls in its `*_asg` vector, which needs `asgd = 1`.
- **`asgd` is always a subset of `pend`.** A bit is only set in `asgd` when it is pending, and serving clears both on the same edge.

### 4.7 What the dispatcher becomes in hardware

| Verilog | Circuit |
| --- | --- |
| `*_asg0/1` | 32 three-input AND gates |
| The `always @*` with two loops | 16-input fixed-priority encoder |
| `popcount` × 2 | Two 8-bit population-count adder trees |
| `cost` × 2 | Per car: comparator + 2 subtractors + mux (abs diff), direction logic, 3-input 6-bit adder |
| `cost1 < cost0` | 6-bit magnitude comparator |
| `1 << pick_floor` | 3-to-8 decoder |
| The clocked block | 48 D flip-flops, each with a small set/clear or load-enable gate in front |

---

## 5. `elevator_coordinator.v`: the top level

File: [rtl/elevator_coordinator.v](rtl/elevator_coordinator.v). This module has no logic of its own. It declares the internal nets and instantiates the dispatcher and two cars.

| Net | From | To |
| --- | --- | --- |
| `up_asg0`, `dn_asg0` | dispatcher | car 0 `hall_up_asg`, `hall_dn_asg` |
| `up_asg1`, `dn_asg1` | dispatcher | car 1 |
| `serve_up0/1`, `serve_dn0/1` | cars | dispatcher |
| `ndir0`, `ndir1` | cars `next_dir` | dispatcher |
| `floor0/1`, `state0/1`, `dir0/1`, `calls0/1` | cars | dispatcher **and** top-level outputs |
| `timer0/1`, `door0/1` | cars | top-level outputs only |

The status outputs (`floor0`, `state0`, …) are `output wire` ports driven by the car instances and read by the dispatcher instance at the same time: one net, two loads.

### 5.1 No combinational loops

There is a feedback loop on paper: the dispatcher drives the cars' `hall_*_asg`, and the cars drive the dispatcher's `serve_*` and `ndir`. It is safe because **every loop passes through a flip-flop**:

```
dispatcher regs (pend/asgd/owner) ──► *_asg (AND gates) ──► car: want_*, next_dir, serve_* ──┐
       ▲                                                                                     │
       └──────────────── next-value logic of pend/asgd/owner ◄── cost(ndir), served_* ◄──────┘
                         (captured on the clock edge)
```

`*_asg` is computed only from dispatcher registers. The car's `next_dir` and `serve_*` are computed from car registers, `*_asg` and `car_btn`. The dispatcher's cost and next-values use those. Nothing feeds back into `*_asg` without first going through a register. In timing terms one of the longest paths runs from the dispatcher registers, through the car's `next_dir` logic, into the cost function and comparator, and into the `owner` flip-flops.

---

## 6. What happens in one clock cycle

The order of events in each cycle:

1. **Rising edge.** All 88 flip-flops capture their next values at the same instant.
2. **Settle.** Combinational logic recomputes from the new register values: `here`, masks, `targets`, `any_*`, `want_*`, `next_dir`, stop and serve logic, priority encoder, loads, costs, `pick_car1`.
3. **Inputs change.** The testbench applies the new button pulses 1 ns after the edge, and the logic settles again.
4. **Next rising edge.** The settled next-values are captured, and the cycle repeats.

### 6.1 Latency of a hall call

| Edge | What becomes true |
| --- | --- |
| *t* (button pulse is high during the cycle before this edge) | `pend` bit set |
| *t*+1 | Call picked and costed; `asgd` and `owner` bits set |
| *t*+2 | The owning car sees it in `hall_*_asg` and reacts (for example IDLE → UP) |

So a car starts moving two clock edges after a hall button is pressed. A cabin call is faster: the car's own `car_calls` register latches it on edge *t*, and the FSM reacts on edge *t*+1.

### 6.2 Latency of a serve

| Edge | What becomes true |
| --- | --- |
| *s* | Car enters `S_DOOR` |
| during the cycle after *s* | `serve_*` strobe is high (combinational, from `in_door` and `here`) |
| *s*+1 | Dispatcher clears `pend` and `asgd`; car's `timer` reset to 0 because `serving` was high |

The serve strobe is high for exactly one cycle, because the call it clears disappears from `*_asg` on the next edge.

---

## 7. A real example from the simulation

These rows are copied from `build/trace_verilog.txt` (seed 2026). Each row is the register state after that clock edge. The format is described in [§8.3](#83-outputs).

```
stim       cyc | car A: fl st dir tmr calls | car B: fl st dir tmr calls | up: pend asgd own | dn: pend asgd own
00042000    49 |         0  0  0   00   20  |         1  0  0   00   00  |       00   00  02  |       04   00  00
00000000    50 |         0  1  1   00   20  |         1  0  0   00   00  |       00   00  02  |       04   04  04
00000000    51 |         0  1  1   01   20  |         1  1  1   00   00  |       00   00  02  |       04   04  04
00800000    59 |         1  1  1   01   20  |         2  1  1   00   00  |       00   00  02  |       84   04  04
00000000    60 |         1  1  1   02   20  |         2  3  1   00   00  |       00   00  02  |       84   84  84
00000000    69 |         2  1  1   03   20  |         2  3  1   09   00  |       00   00  02  |       84   84  84
00000000    70 |         2  1  1   04   20  |         2  1  1   00   00  |       00   00  02  |       84   84  84
   ...
00000000   111 |         4  2  2   01   00  |         7  3  1   00   08  |       28   28  02  |       84   84  84
00000000   112 |         4  2  2   02   00  |         7  3  1   00   08  |       28   28  02  |       04   04  84
   ...
00000000   175 |         5  0  0   00   00  |         2  3  2   00   00  |       00   00  02  |       06   06  86
00000000   176 |         5  0  0   00   00  |         2  3  2   00   00  |       00   00  02  |       02   02  86
```

(States: 0 IDLE, 1 UP, 2 DN, 3 DOOR. Directions: 0 NONE, 1 UP, 2 DN. Vectors in hex, bit i = floor i.)

**Cycle 49: two buttons at once.** The stimulus word `00042000` unpacks to `hall_dn = 0x04` (▼ at floor 2) and `car_btn0 = 0x20` (car A's cabin button for floor 5). After the edge, `dn_pend = 04` and car A's `calls = 20`.

**Edge 50: the dispatcher assigns ▼F2.** The encoder picks the only unassigned call, ▼ at F2. Costs from the row-49 registers:

| | Car A | Car B |
| --- | --- | --- |
| Floor, state | F0, IDLE | F1, IDLE |
| distance | 2 | 1 |
| load | 1 (cabin call F5) | 0 |
| en route? | yes (idle) | yes (idle) |
| **cost** | **3** | **1** |

Car B wins: `dn_asgd = 04`, `dn_owner = 04`. On the same edge car A leaves for F5 (state 1, dir UP), because its cabin call is above it.

**Edge 51.** Car B sees F2 in `hall_dn_asg` and goes IDLE → UP. That is two edges after the button, as in [§6.1](#61-latency-of-a-hall-call).

**Edge 59 → 60: car B arrives at F2, and a ▼ call comes in at F7.** At row 59 car B is at F2 with timer 0. Its targets are only ▼F2, so `any_above = 0` and `stop_up = here & hall_dn_asg & ~any_above = 1`: it stops. During the same cycle the encoder picks the new ▼F7 call:

| | Car A | Car B |
| --- | --- | --- |
| Floor, state, dir | F1, UP, UP | F2, UP, UP |
| distance | 6 | 5 |
| load | 1 | 1 (▼F2) |
| en route? | no (heading up, call is ▼) | no (heading up, call is ▼) |
| **cost** | 6 + 1 + 16 = **23** | 5 + 1 + 16 = **22** |

Both cars pay the penalty, so distance decides: car B gets ▼F7 (`dn_owner = 84`). Car B enters DOOR at F2.

**Edges 60 to 70: the door opens but the ▼ passenger is not served.** Car B now has ▼F7 *above* it, so `want_up = 1`, and with `dir = UP` its `next_dir` is UP. `serve_dn` requires `next_dir != UP`, so the ▼F2 call is **not** answered: `dn_pend` stays `84`. Nobody is served, so the door timer counts 0 → 9 without restarting (row 69), and at edge 70 the car leaves upward. This is the SCAN rule doing its job. A real elevator does the same thing: it stops, shows an "up" arrow, and a passenger who wants to go down waits.

**Edge 111 → 112: car B serves ▼F7.** It reaches F7 and opens its door. Nothing is above F7, so `next_dir` = DN and `serve_dn` fires. `dn_pend` drops from `84` to `04` on the next edge.

**Edge 175 → 176: car B finally serves ▼F2.** Heading down, it stops at F2 and serves the call (`dn_pend` `06` → `02`; bit 1 is a different ▼F1 call that car B also owns). The ▼F2 passenger waited about 126 cycles, well under the testbench's 600-cycle limit.

---

## 8. The testbench

File: [tb/tb_elevator_coordinator.v](tb/tb_elevator_coordinator.v). This is simulation-only code. It uses `initial` blocks, `#` delays, file I/O and `integer` arrays, none of which become hardware.

### 8.1 Clock and reset

```verilog
reg clk = 0;
always #5 clk = ~clk;              // 10 ns period → rising edges at 5, 15, 25, ... ns
...
@(posedge clk); @(posedge clk); #1 rst = 1'b0;   // reset held for 2 edges, released at 16 ns
```

`timescale 1ns/1ps` sets the units. The 100 MHz clock is just a convenient simulation time; the design itself is not timing-constrained.

### 8.2 Stimulus: driving the inputs

```verilog
reg [31:0] stim [0:CYCLES-1];
$readmemh("build/stim.hex", stim);
...
for (cyc = 0; cyc < CYCLES; cyc = cyc + 1) begin
    {hall_up_btn, hall_dn_btn, car_btn0, car_btn1} = stim[cyc];
    @(posedge clk); #1;
    ...
end
```

- `build/stim.hex` has one 32-bit hex word per line, one line per cycle, packed as `{hall_up[7:0], hall_dn[7:0], car_btn0[7:0], car_btn1[7:0]}`. `$readmemh` loads it into a memory array.
- The concatenation on the left of `=` splits one word across the four input buses.
- Inputs are applied **1 ns after a rising edge** and stay stable for the next 9 ns until the next edge. This keeps them clear of the edge, which mimics flip-flop setup and hold time and avoids races between the testbench and the design.
- Since each word is applied for one cycle and then replaced, every button press is automatically a one-cycle pulse.

The file is generated by [scripts/gen_stimulus.js](scripts/gen_stimulus.js). It uses a seeded random generator (mulberry32), so a run can be reproduced exactly from its seed. Each cycle has a 3.5 % chance of a ▲ press, 3.5 % of a ▼ press and 1.5 % of a cabin press per car. It never generates ▲ on the top floor or ▼ on the ground floor.

### 8.3 Outputs

After each edge (at edge + 1 ns, once the registers have settled), the testbench writes one line to `build/trace_verilog.txt`:

```
cyc  floor0 state0 dir0 timer0 calls0  floor1 state1 dir1 timer1 calls1  up_pend up_asgd up_owner dn_pend dn_asgd dn_owner
```

The cycle number is decimal and the other 16 columns, one per output register, are hex.

```verilog
$dumpfile("build/elevator.vcd");
$dumpvars(0, tb_elevator_coordinator);
```

This records every signal in the whole hierarchy, including internal wires such as `u_car0.next_dir` and `u_dispatch.cost1`, to a VCD (Value Change Dump) waveform file. GTKWave can open it, and so can the website's waveform viewer.

### 8.4 Checks

**Safety** ("something bad never happens"), every cycle, both cars:

```verilog
if (door0 && state0 != 2'd3) ... "car0 door open outside DOOR state"
if (floor0 > N-1 || floor1 > N-1) ... "floor out of range"
```

Both of these hold by construction ([§3.4](#34-door-and-serving-logic), [§3.6](#why-the-floor-can-never-leave-the-shaft)), and with N = 8 a 3-bit floor cannot exceed 7 anyway. The checks are there as guards against future edits, for example a different `door_open` equation or a non-power-of-two N.

**Liveness** ("something good eventually happens"): every hall call must be answered within `MAX_WAIT` = 600 cycles.

```verilog
if (up_pend[k]) up_age[k] = up_age[k] + 1;          // still waiting: age it
else if (up_age[k] != 0) begin                       // just cleared: record the wait
    served = served + 1;
    if (up_age[k] > max_wait) max_wait = up_age[k];
    up_age[k] = 0;
end
if (up_age[k] > MAX_WAIT || dn_age[k] > MAX_WAIT) ... "hall call at floor k starved"
```

There is one age counter per floor per direction. This is the check that found the starvation bug in the first version of the design.

At the end, the testbench prints a summary and `$finish`es:

```
 Simulated 4000 cycles, 191 hall calls served, longest wait 203 cycles
 PASS: no safety or liveness violations
```

### 8.5 Blocking vs non-blocking here

The testbench uses blocking `=` everywhere, which is correct for sequential procedural test code. The RTL uses non-blocking `<=` in clocked blocks and `=` in `always @*`. Because the testbench changes inputs at edge + 1 ns rather than at the edge, there is no race between the two.

---

## 9. The build and check flow (`run.sh`)

[run.sh](run.sh) runs five steps. `./run.sh [cycles] [seed]` (defaults 4000 and 2026).

| Step | Command | Produces |
| --- | --- | --- |
| 1. Stimulus | `node scripts/gen_stimulus.js 4000 2026` | `build/stim.hex` |
| 2. Compile | `iverilog -g2005 -Wall -o build/sim.vvp -P tb_elevator_coordinator.CYCLES=4000 rtl/*.v tb/*.v` | `build/sim.vvp` |
| 3. Simulate | `vvp -n build/sim.vvp` | `build/trace_verilog.txt`, `build/elevator.vcd`, PASS/FAIL |
| 4. Register co-sim | `node scripts/verify.js` | PASS/FAIL, `web/verilog_trace.js` |
| 5. Waveform co-sim | `node scripts/vcd2js.js` | PASS/FAIL, `web/verilog_waves.js` |

Compile flags:

- `-g2005` compiles as Verilog-2005, the standard the RTL is written to.
- `-Wall` turns on all warnings. The design currently compiles with none.
- `-P tb_elevator_coordinator.CYCLES=…` overrides the testbench parameter, so the stimulus array and loop match the requested length.
- `vvp -n` runs non-interactively, so `$finish` ends the process instead of dropping into a prompt.

`set -e` stops the script at the first failing step.

### 9.1 Co-simulation: Verilog vs the JavaScript model

The website does not replay pre-recorded animations. It runs [web/elevator_rtl.js](web/elevator_rtl.js), a JavaScript copy of the RTL in which every register and every combinational equation maps one-to-one to the Verilog. Its `step()` computes all next-values from the current register values, then commits them all at once, which copies non-blocking semantics.

To prove the two are the same machine:

- **[scripts/verify.js](scripts/verify.js)** runs the JS model on the same `stim.hex` and compares all 16 registers against `trace_verilog.txt` on every cycle.
- **[scripts/vcd2js.js](scripts/vcd2js.js)** parses the VCD and compares 145 named signals, including internal combinational nets (`next_dir`, `stop_up`, `cost0`, `pick_floor`, …), against the JS model's values at the right instants:
  - combinational nets at edge + 1.5 ns (after the inputs change at + 1 ns);
  - registers at edge + 0.5 ns.

  It skips parameters, signals inside functions, and testbench loop variables. Then it writes the waveform out in a compact delta-encoded form for the website.

Latest run (seed 2026):

```
PASS: no safety or liveness violations
PASS: JS model matches Verilog on all 4000 cycles x 16 registers
PASS: 145 named signals match the VCD on every cycle
```

Seeds 1, 7, 42 and 99 also pass all checks, with longest waits between 170 and 246 cycles.

If you change the Verilog, change `web/elevator_rtl.js` the same way. Otherwise `verify.js` will report the first mismatching cycle and register, which is usually enough to locate the difference.

---

## 10. Coding rules the RTL follows

These are the reasons the RTL simulates and would synthesize the same way.

| Rule | Where | Why |
| --- | --- | --- |
| One clock, all registers on `posedge clk` | Every clocked block | Fully synchronous design; one timing domain |
| Synchronous reset (`if (rst)` inside the clocked block) | Car and dispatcher | Reset is sampled like any input; no reset glitches |
| Non-blocking `<=` in clocked blocks | Car and dispatcher | All registers update "at once" from pre-edge values; order of statements does not matter |
| Blocking `=` in `always @*` | Priority encoder | Statements run in order within the combinational evaluation; this is what makes "last assignment wins" work |
| Defaults assigned at the top of `always @*` | Priority encoder | Every output is driven on every path, so no latches are inferred |
| `for` loops with constant bounds | Encoder, `popcount` | Unroll into fixed hardware; no runtime looping |
| `function` for `cost` and `popcount` | Dispatcher | Purely combinational; each call becomes its own copy of the circuit |
| Every combinational loop broken by a register | Top level | No combinational feedback ([§5.1](#51-no-combinational-loops)) |
| Widths sized from parameters (`{N{1'b0}}`, `{{(N-1){1'b0}},1'b1}`) | Throughout | Vectors resize correctly when `N` changes |
| Moore output for the door | `door_open = (state == S_DOOR)` | Glitch-free, and door/motion exclusion is guaranteed by the encoding |

What is **not** synthesizable lives only in the testbench: `initial`, `#` delays, `$readmemh`, `$fopen`/`$fdisplay`, `$dumpvars`, `integer` arrays used as counters, and `$finish`.

---

## 11. Limits and edge behaviour

### 11.1 Parameter limits

The RTL is parameterised, but some widths are fixed. These are the constraints if you change the parameters:

| Constraint | Reason |
| --- | --- |
| `FW` = ⌈log₂N⌉ | `floor`, `pick_floor` and `dist` are FW bits wide |
| `N` ≤ 15 | `popcount` returns 4 bits (max 15), and `cost` is 6 bits (max distance + load + 2N = 4N − 1 must be ≤ 63, so N ≤ 16) |
| `TRAVEL_TICKS`, `DOOR_TICKS` ≤ 32 | `timer` is a fixed 5 bits (`5'd0`) |
| Testbench and scripts assume N = 8 | `floor0/1` are declared `[2:0]` in the testbench, and `stim.hex` and the JS scripts pack 8 bits per button bus |
| `N` not a power of two | Then a FW-bit floor could encode floors ≥ N; the RTL never moves there (masks have no bits above N−1), and the testbench's range check would catch it if it did |

### 11.2 Behaviour worth knowing

- **Directional serving.** A car can open its door at a floor with a waiting hall call and still not answer it, if it is leaving the other way ([§7](#7-a-real-example-from-the-simulation)). The call stays pending and is answered on the return sweep.
- **Assignments are final.** Once a call has an owner it is never moved to the other car, even if the other car later becomes a better choice. This keeps the dispatcher simple and stops calls from bouncing between cars.
- **Pressing a lit button does nothing new.** ORing into `pend` or `car_calls` is idempotent.
- **A press during its own serve is absorbed.** Clear wins in every set/clear register, and a cabin press for the current floor while the door is open just holds the door.
- **Up is preferred on ties.** An idle car with work both above and below goes up first; the encoder assigns ▲ calls before ▼ calls; car A wins cost ties. All three keep the behaviour deterministic.
- **No emergency, overload or door-obstruction inputs.** These are outside the project's scope; see [REPORT.md §12](docs/REPORT.md#12-limitations-and-future-work).

---

## 12. Signal index

### Car (`u_car0`, `u_car1`)

| Signal | Kind | Width | Meaning |
| --- | --- | --- | --- |
| `floor` | reg | 3 | Last floor reached |
| `state` | reg | 2 | IDLE / UP / DN / DOOR |
| `dir` | reg | 2 | Committed direction |
| `timer` | reg | 5 | Travel or door tick count |
| `car_calls` | reg | 8 | Latched cabin calls |
| `here` | wire | 8 | One-hot current floor |
| `targets` | wire | 8 | All floors this car must visit |
| `mask_below`, `mask_above` | wire | 8 | Floors below / above the car |
| `any_above`, `any_below`, `any_here` | wire | 1 | Work above / below / here |
| `want_up`, `want_dn` | wire | 1 | Demand in each direction (includes hall calls here) |
| `next_dir` | wire | 2 | Direction on leaving (SCAN) |
| `in_door`, `door_open` | wire | 1 | State is DOOR |
| `serve_up`, `serve_dn` | wire | 8 | Hall call answered this cycle (one-hot or 0) |
| `serve_car` | wire | 1 | Cabin call for this floor answered this cycle |
| `serving` | wire | 1 | Anyone served this cycle; restarts door timer |
| `stop_up`, `stop_dn` | wire | 1 | Stop at this floor when moving up / down |

### Dispatcher (`u_dispatch`)

| Signal | Kind | Width | Meaning |
| --- | --- | --- | --- |
| `up_pend`, `dn_pend` | reg | 8 | Hall call is lit |
| `up_asgd`, `dn_asgd` | reg | 8 | Hall call has been given to a car |
| `up_owner`, `dn_owner` | reg | 8 | Which car: 0 = A, 1 = B (valid only where `asgd`) |
| `up_asg0/1`, `dn_asg0/1` | wire | 8 | Calls owned by each car |
| `pick_valid`, `pick_up`, `pick_floor` | wire (from `always @*`) | 1, 1, 3 | The call being assigned this cycle |
| `load0`, `load1` | wire | 4 | Stops each car already has |
| `cost0`, `cost1` | wire | 6 | Cost of giving the picked call to each car |
| `pick_car1` | wire | 1 | Car B wins (strictly cheaper) |
| `pick_vec`, `new_up`, `new_dn` | wire | 8 | One-hot vector of the call being assigned |
| `served_up`, `served_dn` | wire | 8 | Calls answered by either car this cycle |
