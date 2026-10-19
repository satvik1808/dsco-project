`timescale 1ns/1ps
// ============================================================================
// elevator_coordinator.v  (top level)
// Two elevator cars serving N floors, coordinated by a hall-call dispatcher.
//
//            hall buttons                 cabin buttons
//                 |                         |        |
//        +--------v---------+          +----v---+ +--v-----+
//        | hall_call_       |--asg0--->| car 0  | | car 1  |
//        | dispatcher       |--asg1------------------>     |
//        |                  |<--status/serve--+---------+  |
//        +------------------+          +--------+ +--------+
// ============================================================================
module elevator_coordinator #(
    parameter N            = 8,
    parameter FW           = 3,
    parameter TRAVEL_TICKS = 8,
    parameter DOOR_TICKS   = 10
)(
    input  wire          clk,
    input  wire          rst,
    input  wire [N-1:0]  hall_up_btn,
    input  wire [N-1:0]  hall_dn_btn,
    input  wire [N-1:0]  car_btn0,
    input  wire [N-1:0]  car_btn1,

    // car 0 status
    output wire [FW-1:0] floor0,
    output wire [1:0]    state0,
    output wire [1:0]    dir0,
    output wire [4:0]    timer0,
    output wire [N-1:0]  calls0,
    output wire          door0,
    // car 1 status
    output wire [FW-1:0] floor1,
    output wire [1:0]    state1,
    output wire [1:0]    dir1,
    output wire [4:0]    timer1,
    output wire [N-1:0]  calls1,
    output wire          door1,
    // hall call lamps / bookkeeping
    output wire [N-1:0]  up_pend, up_asgd, up_owner,
    output wire [N-1:0]  dn_pend, dn_asgd, dn_owner
);
    wire [N-1:0] up_asg0, dn_asg0, up_asg1, dn_asg1;
    wire [N-1:0] serve_up0, serve_dn0, serve_up1, serve_dn1;
    wire [1:0]   ndir0, ndir1;

    hall_call_dispatcher #(.N(N), .FW(FW)) u_dispatch (
        .clk(clk), .rst(rst),
        .hall_up_btn(hall_up_btn), .hall_dn_btn(hall_dn_btn),
        .floor0(floor0), .floor1(floor1),
        .state0(state0), .state1(state1),
        .dir0(dir0),     .dir1(dir1),
        .ndir0(ndir0),   .ndir1(ndir1),
        .calls0(calls0), .calls1(calls1),
        .serve_up0(serve_up0), .serve_dn0(serve_dn0),
        .serve_up1(serve_up1), .serve_dn1(serve_dn1),
        .up_pend(up_pend), .up_asgd(up_asgd), .up_owner(up_owner),
        .dn_pend(dn_pend), .dn_asgd(dn_asgd), .dn_owner(dn_owner),
        .up_asg0(up_asg0), .dn_asg0(dn_asg0),
        .up_asg1(up_asg1), .dn_asg1(dn_asg1)
    );

    elevator_car #(.N(N), .FW(FW), .TRAVEL_TICKS(TRAVEL_TICKS), .DOOR_TICKS(DOOR_TICKS)) u_car0 (
        .clk(clk), .rst(rst),
        .car_btn(car_btn0), .hall_up_asg(up_asg0), .hall_dn_asg(dn_asg0),
        .floor(floor0), .state(state0), .dir(dir0), .timer(timer0),
        .car_calls(calls0), .serve_up(serve_up0), .serve_dn(serve_dn0),
        .next_dir(ndir0), .door_open(door0)
    );

    elevator_car #(.N(N), .FW(FW), .TRAVEL_TICKS(TRAVEL_TICKS), .DOOR_TICKS(DOOR_TICKS)) u_car1 (
        .clk(clk), .rst(rst),
        .car_btn(car_btn1), .hall_up_asg(up_asg1), .hall_dn_asg(dn_asg1),
        .floor(floor1), .state(state1), .dir(dir1), .timer(timer1),
        .car_calls(calls1), .serve_up(serve_up1), .serve_dn(serve_dn1),
        .next_dir(ndir1), .door_open(door1)
    );
endmodule
