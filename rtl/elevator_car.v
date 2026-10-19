`timescale 1ns/1ps
// ============================================================================
// elevator_car.v
// One elevator car: FSM (IDLE / MOVE_UP / MOVE_DN / DOOR) + datapath
// (floor register, tick timer, cabin-call register).
//
// The car stops at a floor when it has a cabin call there, or a hall call
// assigned to it that matches its direction of travel (or any hall call there
// when nothing is left further on in its direction - the SCAN/"elevator"
// algorithm).
// ============================================================================
module elevator_car #(
    parameter N            = 8,    // number of floors
    parameter FW           = 3,    // floor index width (log2 N)
    parameter TRAVEL_TICKS = 8,    // clock cycles needed to travel one floor
    parameter DOOR_TICKS   = 10    // clock cycles the door stays open
)(
    input  wire          clk,
    input  wire          rst,
    input  wire [N-1:0]  car_btn,      // cabin buttons (1-cycle pulses)
    input  wire [N-1:0]  hall_up_asg,  // hall UP calls assigned to this car
    input  wire [N-1:0]  hall_dn_asg,  // hall DOWN calls assigned to this car

    output reg  [FW-1:0] floor,        // last floor reached
    output reg  [1:0]    state,        // FSM state
    output reg  [1:0]    dir,          // committed direction of travel
    output reg  [4:0]    timer,        // travel / door tick counter
    output reg  [N-1:0]  car_calls,    // latched cabin calls
    output wire [N-1:0]  serve_up,     // hall UP call served this cycle
    output wire [N-1:0]  serve_dn,     // hall DOWN call served this cycle
    output wire [1:0]    next_dir,     // direction the car will take next
    output wire          door_open
);
    // FSM states
    localparam S_IDLE = 2'd0, S_UP = 2'd1, S_DN = 2'd2, S_DOOR = 2'd3;
    // directions
    localparam D_NONE = 2'd0, D_UP = 2'd1, D_DN = 2'd2;

    // ------------------------------------------------------------------
    // Combinational request decoding
    // ------------------------------------------------------------------
    wire [N-1:0] here       = {{(N-1){1'b0}}, 1'b1} << floor;  // one-hot floor
    wire [N-1:0] targets    = car_calls | hall_up_asg | hall_dn_asg;
    wire [N-1:0] mask_below = here - 1'b1;                     // floors < current
    wire [N-1:0] mask_above = ~(mask_below | here);            // floors > current

    wire any_above = |(targets & mask_above);
    wire any_below = |(targets & mask_below);
    wire any_here  = |(targets & here);

    // A hall call at this floor is demand in its own direction: the waiting
    // passenger will ride that way (otherwise a car arriving with nothing
    // further on would turn around and starve it).
    wire want_up = any_above | (|(hall_up_asg & here));
    wire want_dn = any_below | (|(hall_dn_asg & here));

    // keep going the same way while there is work that way (SCAN)
    assign next_dir = (dir == D_UP && want_up) ? D_UP :
                      (dir == D_DN && want_dn) ? D_DN :
                      want_up                  ? D_UP :
                      want_dn                  ? D_DN : D_NONE;

    wire in_door = (state == S_DOOR);
    assign door_open = in_door;

    // While the door is open, clear the calls this stop satisfies.
    // A hall call is only answered if the car is leaving in that direction.
    assign serve_up = (in_door && next_dir != D_DN) ? (hall_up_asg & here) : {N{1'b0}};
    assign serve_dn = (in_door && next_dir != D_UP) ? (hall_dn_asg & here) : {N{1'b0}};
    wire   serve_car = in_door && |((car_calls | car_btn) & here);
    wire   serving   = serve_car | (|serve_up) | (|serve_dn);

    // Stop decision when passing a floor
    wire stop_up = (|(here & (car_calls | hall_up_asg))) | ((|(here & hall_dn_asg)) & ~any_above);
    wire stop_dn = (|(here & (car_calls | hall_dn_asg))) | ((|(here & hall_up_asg)) & ~any_below);

    // ------------------------------------------------------------------
    // Sequential logic
    // ------------------------------------------------------------------
    always @(posedge clk) begin
        if (rst) begin
            floor     <= {FW{1'b0}};
            state     <= S_IDLE;
            dir       <= D_NONE;
            timer     <= 5'd0;
            car_calls <= {N{1'b0}};
        end else begin
            // latch new cabin calls, clear the one at the current floor while door is open
            car_calls <= (car_calls | car_btn) & ~(in_door ? here : {N{1'b0}});

            case (state)
            S_IDLE: begin
                timer <= 5'd0;
                if (any_here)       state <= S_DOOR;
                else if (any_above) begin state <= S_UP; dir <= D_UP; end
                else if (any_below) begin state <= S_DN; dir <= D_DN; end
                else                dir <= D_NONE;
            end

            S_UP: begin
                if (timer == 5'd0 && stop_up)          state <= S_DOOR;
                else if (timer == 5'd0 && !any_above)  begin state <= S_IDLE; dir <= D_NONE; end
                else if (timer == TRAVEL_TICKS - 1)    begin floor <= floor + 1'b1; timer <= 5'd0; end
                else                                   timer <= timer + 1'b1;
            end

            S_DN: begin
                if (timer == 5'd0 && stop_dn)          state <= S_DOOR;
                else if (timer == 5'd0 && !any_below)  begin state <= S_IDLE; dir <= D_NONE; end
                else if (timer == TRAVEL_TICKS - 1)    begin floor <= floor - 1'b1; timer <= 5'd0; end
                else                                   timer <= timer + 1'b1;
            end

            S_DOOR: begin
                if (serving)                         timer <= 5'd0;  // someone new got on: hold door
                else if (timer == DOOR_TICKS - 1) begin
                    timer <= 5'd0;
                    case (next_dir)
                        D_UP:    begin state <= S_UP;   dir <= D_UP;   end
                        D_DN:    begin state <= S_DN;   dir <= D_DN;   end
                        default: begin state <= S_IDLE; dir <= D_NONE; end
                    endcase
                end
                else                                 timer <= timer + 1'b1;
            end
            endcase
        end
    end
endmodule
