// ============================================================================
// floor_masks.v  -  which floors are ABOVE and BELOW the car
//
// Syllabus: Lecture 17 (case statement), Lecture 18 (combinational circuits
// in Verilog). This is just a truth table written with a case statement.
//
// Example: the car is at floor 3.
//      above = 11110000   (floors 4,5,6,7)
//      below = 00000111   (floors 0,1,2)
//
// The car ANDs these masks with its list of calls to answer two questions:
// "is there a call above me?" and "is there a call below me?"
// ============================================================================
module floor_masks (floor, above, below);
    input  [2:0] floor;     // the floor the car is at
    output reg [7:0] above; // 1 for every floor higher than 'floor'
    output reg [7:0] below; // 1 for every floor lower  than 'floor'

    always @(floor)
        case (floor)
            0: begin above = 8'b11111110; below = 8'b00000000; end
            1: begin above = 8'b11111100; below = 8'b00000001; end
            2: begin above = 8'b11111000; below = 8'b00000011; end
            3: begin above = 8'b11110000; below = 8'b00000111; end
            4: begin above = 8'b11100000; below = 8'b00001111; end
            5: begin above = 8'b11000000; below = 8'b00011111; end
            6: begin above = 8'b10000000; below = 8'b00111111; end
            7: begin above = 8'b00000000; below = 8'b01111111; end
        endcase
endmodule
