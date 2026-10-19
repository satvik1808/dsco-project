// ============================================================================
// tb_elevator_coordinator.v
// Drives the coordinator from build/stim.hex (one 32-bit word per clock:
// {hall_up, hall_dn, car_btn0, car_btn1}), writes a per-cycle state trace to
// build/trace_verilog.txt, a VCD waveform to build/elevator.vcd, and checks:
//   * a car never travels with its door open / never leaves the shaft
//   * every hall call is answered within MAX_WAIT cycles (liveness)
// ============================================================================
`timescale 1ns/1ps
module tb_elevator_coordinator;
    parameter N        = 8;
    parameter CYCLES   = 4000;
    parameter MAX_WAIT = 600;

    reg clk = 1'b0;
    reg rst = 1'b1;
    reg [N-1:0] hall_up_btn = 0, hall_dn_btn = 0, car_btn0 = 0, car_btn1 = 0;

    wire [2:0]   floor0, floor1;
    wire [1:0]   state0, state1, dir0, dir1;
    wire [4:0]   timer0, timer1;
    wire [N-1:0] calls0, calls1;
    wire         door0, door1;
    wire [N-1:0] up_pend, up_asgd, up_owner, dn_pend, dn_asgd, dn_owner;

    elevator_coordinator #(.N(N)) dut (
        .clk(clk), .rst(rst),
        .hall_up_btn(hall_up_btn), .hall_dn_btn(hall_dn_btn),
        .car_btn0(car_btn0), .car_btn1(car_btn1),
        .floor0(floor0), .state0(state0), .dir0(dir0), .timer0(timer0), .calls0(calls0), .door0(door0),
        .floor1(floor1), .state1(state1), .dir1(dir1), .timer1(timer1), .calls1(calls1), .door1(door1),
        .up_pend(up_pend), .up_asgd(up_asgd), .up_owner(up_owner),
        .dn_pend(dn_pend), .dn_asgd(dn_asgd), .dn_owner(dn_owner)
    );

    always #5 clk = ~clk;

    reg [31:0] stim [0:CYCLES-1];
    integer cyc, fd, k, errors, served, max_wait;
    integer up_age [0:N-1];
    integer dn_age [0:N-1];

    initial begin
        $readmemh("build/stim.hex", stim);
        fd = $fopen("build/trace_verilog.txt", "w");
        $dumpfile("build/elevator.vcd");
        $dumpvars(0, tb_elevator_coordinator);
        errors = 0; served = 0; max_wait = 0;
        for (k = 0; k < N; k = k + 1) begin up_age[k] = 0; dn_age[k] = 0; end

        // hold reset for two clocks
        @(posedge clk); @(posedge clk); #1 rst = 1'b0;

        for (cyc = 0; cyc < CYCLES; cyc = cyc + 1) begin
            {hall_up_btn, hall_dn_btn, car_btn0, car_btn1} = stim[cyc];
            @(posedge clk); #1;

            // cyc  car0: floor state dir timer calls  car1: ...  hall regs
            $fdisplay(fd, "%0d %h %h %h %h %h %h %h %h %h %h %h %h %h %h %h %h",
                      cyc,
                      floor0, state0, dir0, timer0, calls0,
                      floor1, state1, dir1, timer1, calls1,
                      up_pend, up_asgd, up_owner, dn_pend, dn_asgd, dn_owner);

            // ---- safety checks ----
            if (door0 && state0 != 2'd3) begin errors = errors + 1; $display("ERR c%0d: car0 door open outside DOOR state", cyc); end
            if (door1 && state1 != 2'd3) begin errors = errors + 1; $display("ERR c%0d: car1 door open outside DOOR state", cyc); end
            if (floor0 > N-1 || floor1 > N-1) begin errors = errors + 1; $display("ERR c%0d: floor out of range", cyc); end

            // ---- liveness: track how long each hall call has been waiting ----
            for (k = 0; k < N; k = k + 1) begin
                if (up_pend[k]) up_age[k] = up_age[k] + 1;
                else if (up_age[k] != 0) begin
                    served = served + 1;
                    if (up_age[k] > max_wait) max_wait = up_age[k];
                    up_age[k] = 0;
                end
                if (dn_pend[k]) dn_age[k] = dn_age[k] + 1;
                else if (dn_age[k] != 0) begin
                    served = served + 1;
                    if (dn_age[k] > max_wait) max_wait = dn_age[k];
                    dn_age[k] = 0;
                end
                if (up_age[k] > MAX_WAIT || dn_age[k] > MAX_WAIT) begin
                    errors = errors + 1;
                    $display("ERR c%0d: hall call at floor %0d starved", cyc, k);
                    up_age[k] = 0; dn_age[k] = 0;
                end
            end
        end

        $fclose(fd);
        $display("------------------------------------------------------------");
        $display(" Simulated %0d cycles, %0d hall calls served, longest wait %0d cycles",
                 CYCLES, served, max_wait);
        if (errors == 0) $display(" PASS: no safety or liveness violations");
        else             $display(" FAIL: %0d violations", errors);
        $display("------------------------------------------------------------");
        $finish;
    end
endmodule
