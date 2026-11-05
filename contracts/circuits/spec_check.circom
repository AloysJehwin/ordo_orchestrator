pragma circom 2.1.0;

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/comparators.circom";

/*
 * A lot passed one acceptance criterion, without revealing the measurement.
 *
 * Private: the measured value (fixed point, x10^4) and a random salt.
 * Public:  the commitment Ordo recorded in its hash-chained ledger when the stage closed,
 *          the subject it was made for (lot, stage and criterion), the target (x10^4) and the comparison
 *          (0 = at least, 1 = at most, 2 = exactly).
 * The proof holds only if Poseidon(subject, value, salt) is the recorded commitment and the value meets the target.
 */
template SpecCheck(n) {
    signal input value;
    signal input salt;
    signal input subject;
    signal input target;
    signal input op;
    signal input commitment;

    component h = Poseidon(3);
    h.inputs[0] <== subject;
    h.inputs[1] <== value;
    h.inputs[2] <== salt;
    commitment === h.out;

    // both sides fit in n bits, so the comparators below are sound
    component vBits = Num2Bits(n);
    vBits.in <== value;
    component tBits = Num2Bits(n);
    tBits.in <== target;

    component ge = GreaterEqThan(n);
    ge.in[0] <== value;
    ge.in[1] <== target;
    component le = LessEqThan(n);
    le.in[0] <== value;
    le.in[1] <== target;
    component eq = IsEqual();
    eq.in[0] <== value;
    eq.in[1] <== target;

    component isGe = IsEqual();
    isGe.in[0] <== op;
    isGe.in[1] <== 0;
    component isLe = IsEqual();
    isLe.in[0] <== op;
    isLe.in[1] <== 1;
    component isEq = IsEqual();
    isEq.in[0] <== op;
    isEq.in[1] <== 2;
    isGe.out + isLe.out + isEq.out === 1;

    signal a <== isGe.out * ge.out;
    signal b <== isLe.out * le.out;
    signal c <== isEq.out * eq.out;
    a + b + c === 1;
}

component main {public [subject, target, op, commitment]} = SpecCheck(64);
