// ============================================================================
// priority_encoder8.v  -  8-to-3 priority encoder (lowest bit wins)
//
// Syllabus: Lecture 15 (Encoder), Lecture 17 (casex statement: x = don't care).
//
// Input w is a floor vector (bit k = floor k). The output y is the NUMBER of
// the lowest floor whose bit is 1. 'valid' says whether any bit was 1 at all.
//
//      w            y    valid
//      00000000     0    0       (nothing to report)
//      xxxxxxx1     0    1       floor 0 wins whatever the other bits are
//      xxxxxx10     1    1
//      xxxxx100     2    1
//      ...
//      10000000     7    1
//
// The dispatcher uses this to pick ONE waiting hall call to hand out.
// ============================================================================
module priority_encoder8 (w, y, valid);
    input  [7:0] w;
    output reg [2:0] y;
    output reg       valid;

    always @(w)
    begin
        valid = 1;
        casex (w)
            8'bxxxxxxx1: y = 0;
            8'bxxxxxx10: y = 1;
            8'bxxxxx100: y = 2;
            8'bxxxx1000: y = 3;
            8'bxxx10000: y = 4;
            8'bxx100000: y = 5;
            8'bx1000000: y = 6;
            8'b10000000: y = 7;
            default: begin y = 0; valid = 0; end   // w = 00000000
        endcase
    end
endmodule
