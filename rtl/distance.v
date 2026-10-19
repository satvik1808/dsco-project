// ============================================================================
// distance.v  -  how many floors apart are a and b?   d = |a - b|
//
// Syllabus: Lecture 8 (subtractor), Lecture 12 (comparison circuits),
// Lecture 16 (conditional operator ?: ).
//
// A comparator decides which number is bigger, then we subtract the smaller
// one from the bigger one, so the answer is never negative.
//
//      a = 6, b = 2   ->  a > b, so d = 6 - 2 = 4
//      a = 1, b = 5   ->  a < b, so d = 5 - 1 = 4
// ============================================================================
module distance (a, b, d);
    input  [2:0] a, b;
    output [2:0] d;

    assign d = (a > b) ? (a - b) : (b - a);
endmodule
