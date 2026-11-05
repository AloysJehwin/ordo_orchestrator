# Demo observations: Single-crystal turbine blade

One file per stage of the `sx-turbine-blade` template. Each file holds what a contributor saw on that stage:

- a value for every outcome metric, inside its target;
- a verdict rule for the machine's captured outcomes;
- a few notes, such as consumable lots.

The interviewer records the measurements and the verdicts from the file. It asks only about what the file leaves out, then summarizes and finishes. The file's hash becomes the contributor's evidence.

## Use

Copy the command from the stage ("Contribute proof of work") and add `--notes` with that stage's file:

```sh
npx ordo-pow@latest <token> --notes docs/demo/sx-turbine-blade/01-wax-pattern-injection.txt
```

Inside a running interview, `/notes <file>` does the same.

Before `ordo-pow@0.2.2` is on npm, run the CLI from this repo instead:

```sh
node sdk/bin/ordo-pow.js <token> --notes docs/demo/sx-turbine-blade/01-wax-pattern-injection.txt
```

| Stage | File |
| --- | --- |
| 01 Wax pattern injection | `01-wax-pattern-injection.txt` |
| 02 Ceramic shell building | `02-ceramic-shell-building.txt` |
| 03 Shell dewax and firing | `03-shell-dewax-and-firing.txt` |
| 04 Vacuum directional solidification | `04-vacuum-directional-solidification.txt` |
| 05 Hot isostatic pressing | `05-hot-isostatic-pressing.txt` |
| 06 Solution and age heat treatment | `06-solution-and-age-heat-treatment.txt` |
| 07 5-axis root machining | `07-5-axis-root-machining.txt` |
| 08 Cooling-hole drilling (EDM) | `08-cooling-hole-drilling-edm.txt` |
| 09 EB-PVD thermal barrier coat | `09-eb-pvd-thermal-barrier-coat.txt` |
| 10 CT and FPI release | `10-ct-and-fpi-release.txt` |

If the machine's reading for an outcome is outside its target, the interviewer records a dispute with the contributor's value.
