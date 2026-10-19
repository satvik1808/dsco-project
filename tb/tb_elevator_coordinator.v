// ============================================================================
// tb_elevator_coordinator.v  -  TESTBENCH (simulation only, not hardware)
//
// Syllabus: Lecture 2 lab (testbench, $dumpfile / $dumpvars, GTKWave),
// Lectures 27-28 lab (clock made with "forever").
//
// Same layout as the lab testbenches:
//   1. `include the design
//   2. reg for every input, wire for every output
//   3. instantiate the design
//   4. make a clock
//   5. apply inputs with # delays, then print "Test complete"
//
// The button presses are in build/stimulus.v. That file is written by
// scripts/gen_stimulus.js (random passengers) and is pulled in with
// `include, so it is just many lines like:
//      hall_up_btn = 8'h02; hall_dn_btn = 8'h00; car_btn0 = 8'h00; car_btn1 = 8'h00; #10;
//
// Run (from the project folder):
//      iverilog -I rtl -I build -o build/sim.vvp tb/tb_elevator_coordinator.v
//      vvp build/sim.vvp
//      gtkwave build/elevator.vcd
// ============================================================================
`timescale 1ns/1ns
`include "decoder3to8.v"
`include "floor_masks.v"
`include "priority_encoder8.v"
`include "distance.v"
`include "elevator_car.v"
`include "hall_call_dispatcher.v"
`include "elevator_coordinator.v"

module tb_elevator_coordinator();

    // ---------- inputs of the design ----------
    reg clk, rst;
    reg [7:0] hall_up_btn, hall_dn_btn, car_btn0, car_btn1;

    // ---------- outputs of the design ----------
    wire [2:0] floor0, floor1;
    wire [1:0] state0, state1, dir0, dir1;
    wire [3:0] timer0, timer1;
    wire [7:0] calls0, calls1;
    wire       door0, door1;
    wire [7:0] up_pend, up_asgd, up_owner, dn_pend, dn_asgd, dn_owner;

    // ---------- the design under test ----------
    elevator_coordinator dut (clk, rst,
                              hall_up_btn, hall_dn_btn, car_btn0, car_btn1,
                              floor0, state0, dir0, timer0, calls0, door0,
                              floor1, state1, dir1, timer1, calls1, door1,
                              up_pend, up_asgd, up_owner,
                              dn_pend, dn_asgd, dn_owner);

    // ---------- clock: period 10 ns (rising edges at 5, 15, 25, ...) ----------
    initial
    begin
        clk = 0;
        forever #5 clk = ~clk;
    end

    // ---------- inputs ----------
    initial
    begin
        $dumpfile("build/elevator.vcd");
        $dumpvars(0, tb_elevator_coordinator);

        // reset for the first two clock edges, no buttons pressed
        rst = 1;
        hall_up_btn = 0; hall_dn_btn = 0; car_btn0 = 0; car_btn1 = 0;
        #16;
        rst = 0;

        // one line per clock cycle: set the buttons, wait 10 ns
        `include "stimulus.v"

        $display("Test complete");
        $finish;
    end
endmodule
