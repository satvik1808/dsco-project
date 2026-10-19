`timescale 1ns/1ps
// ============================================================================
// hall_call_dispatcher.v
// The "coordinator": latches hall (landing) calls and assigns each one to the
// car with the lowest estimated cost. One unassigned call is assigned per
// clock cycle (lowest UP call first, then lowest DOWN call).
//
//   cost = distance + load + (car not heading towards the call ? 2N : 0)
//
//   distance : |car floor - call floor|
//   load     : number of floors the car already has to stop at
// Ties go to car 0.
// ============================================================================
module hall_call_dispatcher #(
    parameter N  = 8,
    parameter FW = 3
)(
    input  wire          clk,
    input  wire          rst,
    input  wire [N-1:0]  hall_up_btn,   // landing UP buttons (pulses)
    input  wire [N-1:0]  hall_dn_btn,   // landing DOWN buttons (pulses)

    // status of the two cars
    input  wire [FW-1:0] floor0,  floor1,
    input  wire [1:0]    state0,  state1,
    input  wire [1:0]    dir0,    dir1,
    input  wire [1:0]    ndir0,   ndir1,
    input  wire [N-1:0]  calls0,  calls1,
    input  wire [N-1:0]  serve_up0, serve_dn0, serve_up1, serve_dn1,

    // call registers
    output reg  [N-1:0]  up_pend,  up_asgd,  up_owner,   // owner: 0 = car0, 1 = car1
    output reg  [N-1:0]  dn_pend,  dn_asgd,  dn_owner,

    // per-car assignment vectors
    output wire [N-1:0]  up_asg0, dn_asg0, up_asg1, dn_asg1
);
    localparam S_DOOR = 2'd3;
    localparam D_NONE = 2'd0, D_UP = 2'd1, D_DN = 2'd2;

    assign up_asg0 = up_pend & up_asgd & ~up_owner;
    assign dn_asg0 = dn_pend & dn_asgd & ~dn_owner;
    assign up_asg1 = up_pend & up_asgd &  up_owner;
    assign dn_asg1 = dn_pend & dn_asgd &  dn_owner;

    // ------------------------------------------------------------------
    // Pick the next unassigned call (priority encoder)
    // ------------------------------------------------------------------
    reg          pick_valid;
    reg          pick_up;
    reg [FW-1:0] pick_floor;
    integer i;

    always @* begin
        pick_valid = 1'b0;
        pick_up    = 1'b0;
        pick_floor = {FW{1'b0}};
        for (i = N-1; i >= 0; i = i - 1)
            if (dn_pend[i] && !dn_asgd[i]) begin pick_valid = 1'b1; pick_up = 1'b0; pick_floor = i; end
        for (i = N-1; i >= 0; i = i - 1)
            if (up_pend[i] && !up_asgd[i]) begin pick_valid = 1'b1; pick_up = 1'b1; pick_floor = i; end
    end

    // ------------------------------------------------------------------
    // Cost function
    // ------------------------------------------------------------------
    function [3:0] popcount;
        input [N-1:0] v;
        integer k;
        begin
            popcount = 4'd0;
            for (k = 0; k < N; k = k + 1) popcount = popcount + v[k];
        end
    endfunction

    function [5:0] cost;
        input [FW-1:0] cf;      // car floor
        input [1:0]    cst;     // car state
        input [1:0]    cdir;    // car direction
        input [1:0]    cndir;   // car next direction
        input [FW-1:0] f;       // call floor
        input          up;      // call direction
        input [3:0]    load;
        reg   [FW-1:0] dist;
        reg   [1:0]    edir;
        reg            en_route;
        begin
            dist = (cf > f) ? (cf - f) : (f - cf);
            edir = (cst == S_DOOR) ? cndir : cdir;     // a stopped car is about to go next_dir
            if (edir == D_NONE)    en_route = 1'b1;
            else if (edir == D_UP) en_route =  up && ((f > cf) || (f == cf && cst == S_DOOR));
            else                   en_route = !up && ((f < cf) || (f == cf && cst == S_DOOR));
            cost = dist + load + (en_route ? 6'd0 : 2 * N);
        end
    endfunction

    wire [3:0] load0 = popcount(calls0 | up_asg0 | dn_asg0);
    wire [3:0] load1 = popcount(calls1 | up_asg1 | dn_asg1);
    wire [5:0] cost0 = cost(floor0, state0, dir0, ndir0, pick_floor, pick_up, load0);
    wire [5:0] cost1 = cost(floor1, state1, dir1, ndir1, pick_floor, pick_up, load1);
    wire       pick_car1 = (cost1 < cost0);

    wire [N-1:0] pick_vec = pick_valid ? ({{(N-1){1'b0}}, 1'b1} << pick_floor) : {N{1'b0}};
    wire [N-1:0] new_up   = pick_up  ? pick_vec : {N{1'b0}};
    wire [N-1:0] new_dn   = !pick_up ? pick_vec : {N{1'b0}};
    wire [N-1:0] served_up = serve_up0 | serve_up1;
    wire [N-1:0] served_dn = serve_dn0 | serve_dn1;

    // ------------------------------------------------------------------
    // Call registers
    // ------------------------------------------------------------------
    always @(posedge clk) begin
        if (rst) begin
            up_pend <= 0; up_asgd <= 0; up_owner <= 0;
            dn_pend <= 0; dn_asgd <= 0; dn_owner <= 0;
        end else begin
            up_pend  <= (up_pend | hall_up_btn) & ~served_up;
            dn_pend  <= (dn_pend | hall_dn_btn) & ~served_dn;
            up_asgd  <= (up_asgd & ~served_up) | new_up;
            dn_asgd  <= (dn_asgd & ~served_dn) | new_dn;
            up_owner <= (up_owner & ~new_up) | (pick_car1 ? new_up : {N{1'b0}});
            dn_owner <= (dn_owner & ~new_dn) | (pick_car1 ? new_dn : {N{1'b0}});
        end
    end
endmodule
