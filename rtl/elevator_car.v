// ============================================================================
// elevator_car.v  -  ONE elevator car
//
// Syllabus: Lectures 29-30 (design of synchronous sequential circuits, i.e.
// a state machine), Lectures 27-28 (registers, non-blocking <=, synchronous
// reset), Lecture 31 (counters), Lectures 16-17 (always, if-else, case).
//
// ---------------------------------------------------------------------------
// WHAT IT DOES
// ---------------------------------------------------------------------------
// The car keeps a list of floors it has to visit ("targets"). That list is
// the cabin buttons pressed inside the car plus the hall calls the dispatcher
// gave to this car. The car then follows four simple rules:
//
//   1. If there is a target at the floor I am on, stop and open the door.
//   2. Keep going in the same direction while there are targets that way.
//   3. Otherwise turn around if there are targets the other way.
//   4. If there are no targets at all, wait (IDLE).
//
// ---------------------------------------------------------------------------
// STATE DIAGRAM  (state register: 2 bits)
// ---------------------------------------------------------------------------
//
//                   call here
//         +--------------------------------+
//         |                                v
//      +------+  call above   +---------+  call here   +------+
//      | IDLE |-------------->| MOVE_UP |------------->|      |
//      |  00  |               |   01    |              | DOOR |
//      |      |  call below   +---------+              |  11  |
//      |      |-------------->| MOVE_DN |------------->|      |
//      +------+               |   10    |  call here   +------+
//         ^                   +---------+                 |
//         |       door timer done and nothing left        |
//         +-----------------------------------------------+
//         (when the door timer is done the car goes to MOVE_UP, MOVE_DN
//          or IDLE, whichever 'next_dir' says)
//
// ---------------------------------------------------------------------------
// TIMING
// ---------------------------------------------------------------------------
//   * Travelling one floor takes TRAVEL_TICKS clock cycles.
//   * The door stays open for DOOR_TICKS clock cycles.
//   Both are measured by the 'timer' register, a simple counter that counts
//   0, 1, 2, ... and is cleared back to 0.
// ============================================================================
module elevator_car (clk, rst, car_btn, hall_up_asg, hall_dn_asg,
                     floor, state, dir, timer, car_calls,
                     next_dir, door_open, serve_up, serve_dn);

    // ---------------- constants ----------------
    parameter TRAVEL_TICKS = 8;     // clock cycles to move one floor
    parameter DOOR_TICKS   = 10;    // clock cycles the door stays open

    // state codes (the 4 states of the state machine)
    parameter IDLE    = 2'b00;
    parameter MOVE_UP = 2'b01;
    parameter MOVE_DN = 2'b10;
    parameter DOOR    = 2'b11;

    // direction codes
    parameter NONE = 2'b00;
    parameter UP   = 2'b01;
    parameter DN   = 2'b10;

    // ---------------- ports ----------------
    input        clk;            // clock
    input        rst;            // synchronous reset, active high
    input  [7:0] car_btn;        // cabin buttons (bit k = floor k), 1 for one clock
    input  [7:0] hall_up_asg;    // hall UP   calls the dispatcher gave to this car
    input  [7:0] hall_dn_asg;    // hall DOWN calls the dispatcher gave to this car

    output reg [2:0] floor;      // floor the car is at (or last passed)
    output reg [1:0] state;      // IDLE / MOVE_UP / MOVE_DN / DOOR
    output reg [1:0] dir;        // direction the car is travelling in
    output reg [3:0] timer;      // counts clock cycles while moving / door open
    output reg [7:0] car_calls;  // cabin buttons pressed and not yet served

    output reg [1:0] next_dir;   // where the car will go next (combinational)
    output       door_open;      // 1 while the door is open
    output [7:0] serve_up;       // hall UP   call answered at this floor right now
    output [7:0] serve_dn;       // hall DOWN call answered at this floor right now

    // ---------------- internal wires ----------------
    wire [7:0] here;             // one-hot: the floor the car is on
    wire [7:0] above;            // mask of floors above the car
    wire [7:0] below;            // mask of floors below the car
    wire [7:0] targets;          // every floor this car must visit
    wire       call_here;        // is there a target on this floor?
    wire       call_above;       // is there a target above?
    wire       call_below;       // is there a target below?

    // ===================================================================
    // PART 1: combinational logic (no clock)
    // ===================================================================

    // floor number -> one-hot floor vector (3-to-8 decoder, always enabled)
    decoder3to8 dec_here (1'b1, floor, here);

    // which floors are above / below the car (lookup table)
    floor_masks masks (floor, above, below);

    // all the floors this car has to visit
    assign targets = car_calls | hall_up_asg | hall_dn_asg;

    // Reduction OR ( |vector ) gives 1 if ANY bit of the vector is 1.
    assign call_here  = |(targets & here);
    assign call_above = |(targets & above);
    assign call_below = |(targets & below);

    // Next direction: keep going the same way while there is work that way,
    // otherwise take whichever way has work, otherwise none.
    always @(dir or call_above or call_below)
    begin
        if (dir == UP && call_above)
            next_dir = UP;
        else if (dir == DN && call_below)
            next_dir = DN;
        else if (call_above)
            next_dir = UP;
        else if (call_below)
            next_dir = DN;
        else
            next_dir = NONE;
    end

    // The door is open exactly when the state machine is in DOOR.
    assign door_open = (state == DOOR);

    // While the door is open, every hall call of this car at this floor is
    // answered. The dispatcher uses these to switch the hall lamps off.
    assign serve_up = door_open ? (hall_up_asg & here) : 8'b00000000;
    assign serve_dn = door_open ? (hall_dn_asg & here) : 8'b00000000;

    // ===================================================================
    // PART 2: cabin-call register (8 flip-flops, one per floor)
    // ===================================================================
    // A pressed button sets its bit (OR). When the door opens on a floor, that
    // floor's bit is cleared (AND with NOT here).
    always @(posedge clk)
    begin
        if (rst)
            car_calls <= 8'b00000000;
        else if (state == DOOR)
            car_calls <= (car_calls | car_btn) & ~here;
        else
            car_calls <= car_calls | car_btn;
    end

    // ===================================================================
    // PART 3: the state machine (state, floor, dir and timer registers)
    // ===================================================================
    always @(posedge clk)
    begin
        if (rst)
        begin
            state <= IDLE;
            floor <= 0;
            dir   <= NONE;
            timer <= 0;
        end
        else
            case (state)

            // ---------- waiting for something to do ----------
            IDLE:
            begin
                timer <= 0;
                if (call_here)
                    state <= DOOR;                          // rule 1
                else if (call_above)
                begin
                    state <= MOVE_UP;
                    dir   <= UP;
                end
                else if (call_below)
                begin
                    state <= MOVE_DN;
                    dir   <= DN;
                end
                else
                    dir <= NONE;                            // rule 4
            end

            // ---------- travelling up ----------
            // timer = 0 means the car is exactly at a floor.
            MOVE_UP:
            begin
                if (timer == 0 && call_here)
                    state <= DOOR;                          // rule 1: stop here
                else if (timer == 0 && !call_above)
                begin
                    state <= IDLE;                          // safety: nothing above
                    dir   <= NONE;
                end
                else if (timer == TRAVEL_TICKS - 1)
                begin
                    floor <= floor + 1;                     // reached the next floor
                    timer <= 0;
                end
                else
                    timer <= timer + 1;                     // still between floors
            end

            // ---------- travelling down (mirror of MOVE_UP) ----------
            MOVE_DN:
            begin
                if (timer == 0 && call_here)
                    state <= DOOR;
                else if (timer == 0 && !call_below)
                begin
                    state <= IDLE;
                    dir   <= NONE;
                end
                else if (timer == TRAVEL_TICKS - 1)
                begin
                    floor <= floor - 1;
                    timer <= 0;
                end
                else
                    timer <= timer + 1;
            end

            // ---------- door open ----------
            DOOR:
            begin
                if (timer == DOOR_TICKS - 1)
                begin
                    timer <= 0;                             // door closes
                    if (next_dir == UP)                     // rules 2 and 3
                    begin
                        state <= MOVE_UP;
                        dir   <= UP;
                    end
                    else if (next_dir == DN)
                    begin
                        state <= MOVE_DN;
                        dir   <= DN;
                    end
                    else
                    begin
                        state <= IDLE;
                        dir   <= NONE;
                    end
                end
                else
                    timer <= timer + 1;
            end

            endcase
    end
endmodule
