// ============================================================================
// decoder3to8.v  -  3-to-8 line decoder with enable
//
// Syllabus: Lecture 15 (Decoder), Lecture 18 (Verilog code for decoders).
// Same style as the d2to4 decoder in the "Synchronous counters" slides.
//
// It turns a floor NUMBER (0..7) into a ONE-HOT pattern (one bit per floor):
//
//      en  w      y
//      0   xxx    00000000      (disabled: all outputs 0)
//      1   000    00000001      floor 0
//      1   001    00000010      floor 1
//      1   010    00000100      floor 2
//      ...
//      1   111    10000000      floor 7
//
// Bit k of every 8-bit "floor vector" in this project stands for floor k,
// so this decoder is how a floor number is turned into a floor vector.
// ============================================================================
module decoder3to8 (en, w, y);
    input        en;        // enable
    input  [2:0] w;         // floor number
    output reg [7:0] y;     // one-hot output

    always @(en or w)
    begin
        y = 8'b00000000;            // start with every output 0
        if (en == 1)
            case (w)
                0: y = 8'b00000001;
                1: y = 8'b00000010;
                2: y = 8'b00000100;
                3: y = 8'b00001000;
                4: y = 8'b00010000;
                5: y = 8'b00100000;
                6: y = 8'b01000000;
                7: y = 8'b10000000;
            endcase
    end
endmodule
