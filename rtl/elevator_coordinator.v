// ============================================================================
// elevator_coordinator.v  -  TOP LEVEL: 2 elevator cars + 1 dispatcher
//
// Syllabus: Lecture 2 (modules, structural design: building a big circuit by
// connecting smaller modules), Lecture 18 (module instantiation, as in the
// mux16to1 made from mux4to1 blocks).
//
// This file contains NO logic of its own. It only connects three blocks:
//
//          hall buttons                      cabin buttons
//               |                           |             |
//      +--------v---------+  calls for A  +-v-------+  +--v------+
//      |  hall_call_      |-------------->| Car A   |  | Car B   |
//      |  dispatcher      |  calls for B  | (car 0) |  | (car 1) |
//      |                  |------------------------------->      |
//      |                  |<---- floor, calls served ---+---------+
//      +------------------+               +---------+  +---------+
//
// Modules are connected by POSITION, as in the lecture slides: the n-th
// signal in brackets goes to the n-th port of the module.
// ============================================================================
module elevator_coordinator (clk, rst,
                             hall_up_btn, hall_dn_btn, car_btn0, car_btn1,
                             floor0, state0, dir0, timer0, calls0, door0,
                             floor1, state1, dir1, timer1, calls1, door1,
                             up_pend, up_asgd, up_owner,
                             dn_pend, dn_asgd, dn_owner);

    input        clk, rst;
    input  [7:0] hall_up_btn, hall_dn_btn;   // landing buttons
    input  [7:0] car_btn0, car_btn1;         // buttons inside Car A / Car B

    // status of Car A (0) and Car B (1)
    output [2:0] floor0, floor1;
    output [1:0] state0, state1;
    output [1:0] dir0,   dir1;
    output [3:0] timer0, timer1;
    output [7:0] calls0, calls1;
    output       door0,  door1;

    // hall call registers (drive the hall lamps)
    output [7:0] up_pend, up_asgd, up_owner;
    output [7:0] dn_pend, dn_asgd, dn_owner;

    // wires between the blocks
    wire [7:0] up_asg0, dn_asg0, up_asg1, dn_asg1;          // dispatcher -> cars
    wire [7:0] serve_up0, serve_dn0, serve_up1, serve_dn1;  // cars -> dispatcher
    wire [1:0] next_dir0, next_dir1;                        // (shown on the website)

    hall_call_dispatcher u_dispatch (
        clk, rst,
        hall_up_btn, hall_dn_btn,
        floor0, floor1,
        serve_up0, serve_dn0, serve_up1, serve_dn1,
        up_pend, up_asgd, up_owner,
        dn_pend, dn_asgd, dn_owner,
        up_asg0, dn_asg0, up_asg1, dn_asg1);

    //            clk  rst  buttons   calls given to this car
    elevator_car u_car0 (
        clk, rst, car_btn0, up_asg0, dn_asg0,
        floor0, state0, dir0, timer0, calls0,          // registers
        next_dir0, door0, serve_up0, serve_dn0);       // combinational outputs

    elevator_car u_car1 (
        clk, rst, car_btn1, up_asg1, dn_asg1,
        floor1, state1, dir1, timer1, calls1,
        next_dir1, door1, serve_up1, serve_dn1);
endmodule
