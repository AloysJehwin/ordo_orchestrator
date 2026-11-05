pragma circom 2.1.0;

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/comparators.circom";

/*
 * A stage met its acceptance criteria, proven from the counts its machine (or operator) signed, without revealing them.
 *
 * Private: the counts and times the reading attests (good and scrap units, start and end in unix seconds) and the
 *          reading's random salt.
 * Public:  the subject (this site, lot and stage), the reading's commitment Poseidon(subject, good, scrap, startedAt,
 *          endedAt, salt), which the machine's gateway or the operator signed, and K criteria, each a kind, a
 *          comparison (0 = at least, 1 = at most, 2 = exactly) and a target in fixed point x10^4:
 *            kind 0  unused slot
 *            kind 1  yield %        good / (good + scrap) x 100
 *            kind 2  scrap %        scrap / (good + scrap) x 100
 *            kind 3  defects ppm    scrap / (good + scrap) x 10^6
 *            kind 4  cycle time s   (endedAt - startedAt) / good
 *            kind 5  cycle time min (endedAt - startedAt) / 60 / good
 * Each criterion is compared without division: value op target/10^4 becomes L op R with both sides whole numbers.
 */
template StageCheck(K) {
    signal input subject;
    signal input commitment;
    signal input kind[K];
    signal input op[K];
    signal input target[K];

    signal input good;
    signal input scrap;
    signal input startedAt;
    signal input endedAt;
    signal input salt;

    component h = Poseidon(6);
    h.inputs[0] <== subject;
    h.inputs[1] <== good;
    h.inputs[2] <== scrap;
    h.inputs[3] <== startedAt;
    h.inputs[4] <== endedAt;
    h.inputs[5] <== salt;
    commitment === h.out;

    // every quantity fits its width, so the products below stay far under 2^128 and the comparators are sound
    component gBits = Num2Bits(32);
    gBits.in <== good;
    component sBits = Num2Bits(32);
    sBits.in <== scrap;
    component t0Bits = Num2Bits(40);
    t0Bits.in <== startedAt;
    component t1Bits = Num2Bits(40);
    t1Bits.in <== endedAt;
    signal dur <== endedAt - startedAt;
    component dBits = Num2Bits(40);
    dBits.in <== dur;

    signal total <== good + scrap;
    component totalZero = IsZero();
    totalZero.in <== total;
    component goodZero = IsZero();
    goodZero.in <== good;

    component tBits[K];
    component isKind[K][6];
    component isOp[K][3];
    component ge[K];
    component le[K];
    component eq[K];
    signal tt[K];
    signal tg[K];
    signal l1[K];
    signal l2[K];
    signal l3[K];
    signal l4[K];
    signal r1[K];
    signal r2[K];
    signal r3[K];
    signal r4[K];
    signal r5[K];
    signal lhs[K];
    signal rhs[K];
    signal pa[K];
    signal pb[K];
    signal pc[K];

    for (var i = 0; i < K; i++) {
        tBits[i] = Num2Bits(64);
        tBits[i].in <== target[i];

        var kinds = 0;
        for (var j = 0; j < 6; j++) {
            isKind[i][j] = IsEqual();
            isKind[i][j].in[0] <== kind[i];
            isKind[i][j].in[1] <== j;
            kinds += isKind[i][j].out;
        }
        kinds === 1;
        var ops = 0;
        for (var j = 0; j < 3; j++) {
            isOp[i][j] = IsEqual();
            isOp[i][j].in[0] <== op[i];
            isOp[i][j].in[1] <== j;
            ops += isOp[i][j].out;
        }
        ops === 1;

        // rates need units counted, cycle times need good units
        (isKind[i][1].out + isKind[i][2].out + isKind[i][3].out) * totalZero.out === 0;
        (isKind[i][4].out + isKind[i][5].out) * goodZero.out === 0;

        tt[i] <== target[i] * total;
        tg[i] <== target[i] * good;
        // left side: the measured quantity scaled; right side: the target times the denominator
        l1[i] <== isKind[i][1].out * good * 1000000;
        l2[i] <== isKind[i][2].out * scrap * 1000000;
        l3[i] <== isKind[i][3].out * scrap * 10000000000;
        l4[i] <== (isKind[i][4].out + isKind[i][5].out) * dur * 10000;
        lhs[i] <== l1[i] + l2[i] + l3[i] + l4[i];
        r1[i] <== isKind[i][1].out * tt[i];
        r2[i] <== isKind[i][2].out * tt[i];
        r3[i] <== isKind[i][3].out * tt[i];
        r4[i] <== isKind[i][4].out * tg[i];
        r5[i] <== isKind[i][5].out * tg[i] * 60;
        rhs[i] <== r1[i] + r2[i] + r3[i] + r4[i] + r5[i];

        ge[i] = GreaterEqThan(128);
        ge[i].in[0] <== lhs[i];
        ge[i].in[1] <== rhs[i];
        le[i] = LessEqThan(128);
        le[i].in[0] <== lhs[i];
        le[i].in[1] <== rhs[i];
        eq[i] = IsEqual();
        eq[i].in[0] <== lhs[i];
        eq[i].in[1] <== rhs[i];

        pa[i] <== isOp[i][0].out * ge[i].out;
        pb[i] <== isOp[i][1].out * le[i].out;
        pc[i] <== isOp[i][2].out * eq[i].out;
        pa[i] + pb[i] + pc[i] === 1;
    }
}

component main {public [subject, commitment, kind, op, target]} = StageCheck(4);
