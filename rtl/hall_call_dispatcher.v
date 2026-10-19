// ============================================================================
// hall_call_dispatcher.v  -  the COORDINATOR: decides which car answers
//                             each hall (landing) call
//
// Syllabus: Lecture 15 (priority encoder, decoder), Lecture 12 (comparator),
// Lectures 13-14 (multiplexer, as the ?: operator), Lectures 26-28 (registers).
//
// ---------------------------------------------------------------------------
// WHAT IT DOES
// ---------------------------------------------------------------------------
// Every floor has an UP button and a DOWN button. For each direction the
// dispatcher keeps three 8-bit registers (bit k = floor k):
//
//      pend   1 = someone pressed this button and is still waiting
//      asgd   1 = this call has already been given to a car
//      owner  which car got it: 0 = Car A (car 0), 1 = Car B (car 1)
//
// Every clock cycle it does this:
//   1. New button presses set their 'pend' bit.
//   2. A priority encoder finds the lowest call that is waiting but not yet
//      given to a car (UP calls first, then DOWN calls).
//   3. It works out how far each car is from that floor.
//   4. The call goes to the NEARER car (if both are equally far: Car A).
//   5. When a car opens its door at the floor, the call is cleared.
//
// Only one call is handed out per clock cycle. That is plenty: a car needs
// 8 clock cycles just to move one floor.
//
// ---------------------------------------------------------------------------
// BLOCK DIAGRAM
// ---------------------------------------------------------------------------
//
//   up_pend & ~up_asgd --> [priority encoder] --up_floor--+
//                                                         |-- mux --> pick_floor
//   dn_pend & ~dn_asgd --> [priority encoder] --dn_floor--+     |
//                                                               v
//   floor0 ------------------------------> [distance] --dist0--> [ comparator ]
//   floor1 ------------------------------> [distance] --dist1--> [dist1<dist0?] --> pick_car1
//
//   pick_floor --> [3-to-8 decoder] --> pick_vec --> new_up / new_dn
//                                                   (sets asgd and owner bits)
// ============================================================================
module hall_call_dispatcher (clk, rst, hall_up_btn, hall_dn_btn,
                             floor0, floor1,
                             serve_up0, serve_dn0, serve_up1, serve_dn1,
                             up_pend, up_asgd, up_owner,
                             dn_pend, dn_asgd, dn_owner,
                             up_asg0, dn_asg0, up_asg1, dn_asg1);

    // ---------------- ports ----------------
    input        clk, rst;
    input  [7:0] hall_up_btn;    // hall UP   buttons (1 for one clock when pressed)
    input  [7:0] hall_dn_btn;    // hall DOWN buttons
    input  [2:0] floor0;         // where Car A is
    input  [2:0] floor1;         // where Car B is
    input  [7:0] serve_up0, serve_dn0;   // calls Car A answered this cycle
    input  [7:0] serve_up1, serve_dn1;   // calls Car B answered this cycle

    output reg [7:0] up_pend, up_asgd, up_owner;   // UP call registers
    output reg [7:0] dn_pend, dn_asgd, dn_owner;   // DOWN call registers

    output [7:0] up_asg0, dn_asg0;   // calls given to Car A
    output [7:0] up_asg1, dn_asg1;   // calls given to Car B

    // ---------------- internal wires ----------------
    wire [7:0] free_up, free_dn;     // waiting but not yet given to a car
    wire [2:0] up_floor, dn_floor;   // lowest free call of each kind
    wire       up_valid, dn_valid;   // is there a free call of that kind?

    wire       pick_valid;           // is there any call to hand out?
    wire       pick_up;              // 1 = it is an UP call, 0 = a DOWN call
    wire [2:0] pick_floor;           // floor of the call being handed out
    wire [7:0] pick_vec;             // the same floor as a one-hot vector

    wire [2:0] dist0, dist1;         // how far each car is from pick_floor
    wire       pick_car1;            // 1 = give it to Car B, 0 = Car A

    wire [7:0] new_up, new_dn;       // the call handed out this cycle
    wire [7:0] served_up, served_dn; // calls answered by either car

    // ===================================================================
    // Which calls belong to which car
    // ===================================================================
    // A call belongs to Car A if it is pending, assigned, and owner = 0.
    assign up_asg0 = up_pend & up_asgd & ~up_owner;
    assign dn_asg0 = dn_pend & dn_asgd & ~dn_owner;
    assign up_asg1 = up_pend & up_asgd &  up_owner;
    assign dn_asg1 = dn_pend & dn_asgd &  dn_owner;

    // ===================================================================
    // Step 2: pick one free call
    // ===================================================================
    assign free_up = up_pend & ~up_asgd;
    assign free_dn = dn_pend & ~dn_asgd;

    priority_encoder8 enc_up (free_up, up_floor, up_valid);
    priority_encoder8 enc_dn (free_dn, dn_floor, dn_valid);

    assign pick_valid = up_valid | dn_valid;
    assign pick_up    = up_valid;                           // UP calls go first
    assign pick_floor = up_valid ? up_floor : dn_floor;     // 2-to-1 multiplexer

    // ===================================================================
    // Steps 3 and 4: give it to the nearer car
    // ===================================================================
    distance d0 (floor0, pick_floor, dist0);
    distance d1 (floor1, pick_floor, dist1);

    assign pick_car1 = (dist1 < dist0);     // tie -> Car A

    // turn the chosen floor into a vector (all zeros if nothing was picked)
    decoder3to8 dec_pick (pick_valid, pick_floor, pick_vec);

    assign new_up = pick_up ? pick_vec : 8'b00000000;
    assign new_dn = pick_up ? 8'b00000000 : pick_vec;

    // ===================================================================
    // Step 5: calls answered by a car
    // ===================================================================
    assign served_up = serve_up0 | serve_up1;
    assign served_dn = serve_dn0 | serve_dn1;

    // ===================================================================
    // The six call registers
    // ===================================================================
    //   pend : set by a button, cleared when served
    //   asgd : set when handed out, cleared when served
    //   owner: written with the chosen car when a call is handed out,
    //          otherwise kept as it is
    always @(posedge clk)
    begin
        if (rst)
        begin
            up_pend <= 0;  up_asgd <= 0;  up_owner <= 0;
            dn_pend <= 0;  dn_asgd <= 0;  dn_owner <= 0;
        end
        else
        begin
            up_pend <= (up_pend | hall_up_btn) & ~served_up;
            dn_pend <= (dn_pend | hall_dn_btn) & ~served_dn;

            up_asgd <= (up_asgd & ~served_up) | new_up;
            dn_asgd <= (dn_asgd & ~served_dn) | new_dn;

            if (pick_car1)
            begin
                up_owner <= up_owner | new_up;      // new call belongs to Car B
                dn_owner <= dn_owner | new_dn;
            end
            else
            begin
                up_owner <= up_owner & ~new_up;     // new call belongs to Car A
                dn_owner <= dn_owner & ~new_dn;
            end
        end
    end
endmodule
