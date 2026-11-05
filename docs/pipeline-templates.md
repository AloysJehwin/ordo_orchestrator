# Pipeline template library

Ordo ships 16 templates. Parallel stages share a column and are joined with **+**; numbers follow the console (`02a`, `02b` for parallel lanes). The summary table lists each rework loop (where a later stage sends units back to an earlier one). Gates are stages owned by the Vision QA agent (default execution mode *Approve*).

The Gate role column lists the job titles of the original prototype. In Ordo every stage escalates to the org's manager (`escalationRole: manager` in `server/src/library/templates.json`).

## Summary

| Template | Category | Stages | Gates | Rework loop |
| --- | --- | --- | --- | --- |
| Discrete assembly | Discrete | 11 | 1 | stage 06 → 04 |
| Batch chemical process | Process | 9 | 2 | — |
| Machining job shop | Fabrication | 10 | 1 | stage 07 → 05 |
| Injection molding | Discrete | 7 | 1 | — |
| Electronics SMT line | Electronics | 10 | 3 | stage 06 → 04 |
| Food & beverage batch | Process | 10 | 2 | — |
| Pharma GMP batch | Regulated | 10 | 2 | — |
| Additive manufacturing | Fabrication | 10 | 3 | — |
| Sheet metal fabrication | Fabrication | 10 | 1 | stage 07 → 05 |
| Surface finishing | Process | 7 | 1 | stage 06 → 04 |
| Warehouse & kitting | Logistics | 6 | 1 | — |
| Predictive maintenance | Maintenance | 7 | 0 | — |
| Engineer-to-order | Lifecycle | 12 | 3 | — |
| New product introduction | Lifecycle | 6 | 2 | stage 04 → 03 |
| Rework & recall | Quality | 8 | 5 | stage 05 → 04 |
| Protein synthesis | Regulated | 7 | 1 | — |

## Discrete assembly

*Discrete.* Order-driven build of multi-part products: sourcing and tooling run in parallel, a vision gate before packing, and a rework loop back to sub-assembly.

**Flow:** Order intake → Material sourcing + Tooling prep → Machining + Fixture build → Sub-assembly → Final assembly + Documentation pack → Quality inspection → Packaging → Dispatch  
**Rework loop:** stage 06 sends units back to stage 04.

| # | Stage | Owning agent | Default resource | Gate role | Default mode |
| --- | --- | --- | --- | --- | --- |
| 01 | Order intake | Planning agent | ERP / MES link | Production planner | Auto |
| 02a | Material sourcing | Supply agent | AGV fleet · Bay 2 | Materials lead | Auto |
| 02b | Tooling prep | Scheduler agent | Cells CNC-04 / 05 | Cell lead | Auto |
| 03a | Machining | Scheduler agent | Cells CNC-04 / 05 | Cell lead | Auto |
| 03b | Fixture build | Scheduler agent | Cells CNC-04 / 05 | Cell lead | Auto |
| 04 | Sub-assembly | Line agent | Robot cell R-3 | Line supervisor | Auto |
| 05a | Final assembly | Line agent | Robot cell R-3 | Line supervisor | Auto |
| 05b | Documentation pack | Planning agent | ERP / MES link | Production planner | Auto |
| 06 | Quality inspection | Vision QA agent | Vision station VS-02 | Quality engineer | Approve |
| 07 | Packaging | Logistics agent | Pack line P-1 | Shipping lead | Auto |
| 08 | Dispatch | Logistics agent | Pack line P-1 | Shipping lead | Auto |

## Batch chemical process

*Process.* Recipe-controlled batches from receiving to release, with QC sampling holding the batch until lab results clear.

**Flow:** Demand planning → Raw material receiving → Weighing & dispensing → Mixing → Reaction → QC sampling → Filling → Labeling → Batch release

| # | Stage | Owning agent | Default resource | Gate role | Default mode |
| --- | --- | --- | --- | --- | --- |
| 01 | Demand planning | Planning agent | ERP / MES link | Production planner | Auto |
| 02 | Raw material receiving | Supply agent | AGV fleet · Bay 2 | Materials lead | Auto |
| 03 | Weighing & dispensing | Supply agent | AGV fleet · Bay 2 | Materials lead | Auto |
| 04 | Mixing | Process agent | Vessel V-2 / Oven O-1 | Process engineer | Auto |
| 05 | Reaction | Process agent | Vessel V-2 / Oven O-1 | Process engineer | Auto |
| 06 | QC sampling | Vision QA agent | Vision station VS-02 | Quality engineer | Approve |
| 07 | Filling | Process agent | Vessel V-2 / Oven O-1 | Process engineer | Auto |
| 08 | Labeling | Logistics agent | Pack line P-1 | Shipping lead | Auto |
| 09 | Batch release | Vision QA agent | Vision station VS-02 | Quality engineer | Approve |

## Machining job shop

*Fabrication.* High-mix, low-volume jobs. CAM programming and stock procurement overlap; CMM inspection closes each job.

**Flow:** Quote & order → CAM programming + Stock procurement → Program simulation + Stock cutting → Fixture setup → CNC milling → Deburr & finish → CMM inspection → Ship  
**Rework loop:** stage 07 sends units back to stage 05.

| # | Stage | Owning agent | Default resource | Gate role | Default mode |
| --- | --- | --- | --- | --- | --- |
| 01 | Quote & order | Planning agent | ERP / MES link | Production planner | Auto |
| 02a | CAM programming | Scheduler agent | Cells CNC-04 / 05 | Cell lead | Auto |
| 02b | Stock procurement | Supply agent | AGV fleet · Bay 2 | Materials lead | Auto |
| 03a | Program simulation | Scheduler agent | Cells CNC-04 / 05 | Cell lead | Auto |
| 03b | Stock cutting | Scheduler agent | Cells CNC-04 / 05 | Cell lead | Auto |
| 04 | Fixture setup | Scheduler agent | Cells CNC-04 / 05 | Cell lead | Auto |
| 05 | CNC milling | Scheduler agent | Cells CNC-04 / 05 | Cell lead | Auto |
| 06 | Deburr & finish | Scheduler agent | Cells CNC-04 / 05 | Cell lead | Auto |
| 07 | CMM inspection | Vision QA agent | Vision station VS-02 | Quality engineer | Approve |
| 08 | Ship | Logistics agent | Pack line P-1 | Shipping lead | Auto |

## Injection molding

*Discrete.* Resin drying and mold setup in parallel, cycle-level monitoring on the press, visual inspection before pack-out.

**Flow:** Order intake → Resin drying + Mold setup → Molding → Trim & degate → Visual inspection → Pack

| # | Stage | Owning agent | Default resource | Gate role | Default mode |
| --- | --- | --- | --- | --- | --- |
| 01 | Order intake | Planning agent | ERP / MES link | Production planner | Auto |
| 02a | Resin drying | Process agent | Vessel V-2 / Oven O-1 | Process engineer | Auto |
| 02b | Mold setup | Scheduler agent | Cells CNC-04 / 05 | Cell lead | Auto |
| 03 | Molding | Scheduler agent | Cells CNC-04 / 05 | Cell lead | Auto |
| 04 | Trim & degate | Scheduler agent | Cells CNC-04 / 05 | Cell lead | Auto |
| 05 | Visual inspection | Vision QA agent | Vision station VS-02 | Quality engineer | Approve |
| 06 | Pack | Logistics agent | Pack line P-1 | Shipping lead | Auto |

## Electronics SMT line

*Electronics.* Board assembly from kitting through reflow, AOI and functional test to box build.

**Flow:** Work order → Component kitting + Stencil prep → Solder paste print → Pick & place → Reflow → AOI inspection + X-ray sampling → Functional test → Box build  
**Rework loop:** stage 06 sends units back to stage 04.

| # | Stage | Owning agent | Default resource | Gate role | Default mode |
| --- | --- | --- | --- | --- | --- |
| 01 | Work order | Planning agent | ERP / MES link | Production planner | Auto |
| 02a | Component kitting | Supply agent | AGV fleet · Bay 2 | Materials lead | Auto |
| 02b | Stencil prep | Line agent | Robot cell R-3 | Line supervisor | Auto |
| 03 | Solder paste print | Line agent | Robot cell R-3 | Line supervisor | Auto |
| 04 | Pick & place | Line agent | Robot cell R-3 | Line supervisor | Auto |
| 05 | Reflow | Process agent | Vessel V-2 / Oven O-1 | Process engineer | Auto |
| 06a | AOI inspection | Vision QA agent | Vision station VS-02 | Quality engineer | Approve |
| 06b | X-ray sampling | Vision QA agent | Vision station VS-02 | Quality engineer | Approve |
| 07 | Functional test | Vision QA agent | Vision station VS-02 | Quality engineer | Approve |
| 08 | Box build | Line agent | Robot cell R-3 | Line supervisor | Auto |

## Food & beverage batch

*Process.* Ingredient traceability through blending, heat treatment and filling, with lab release before shipment.

**Flow:** Production plan → Ingredient receiving + Packaging receiving → Blending + Packaging QC → Heat treatment → Cooling → Filling → Lab release → Palletize & ship

| # | Stage | Owning agent | Default resource | Gate role | Default mode |
| --- | --- | --- | --- | --- | --- |
| 01 | Production plan | Planning agent | ERP / MES link | Production planner | Auto |
| 02a | Ingredient receiving | Supply agent | AGV fleet · Bay 2 | Materials lead | Auto |
| 02b | Packaging receiving | Supply agent | AGV fleet · Bay 2 | Materials lead | Auto |
| 03a | Blending | Process agent | Vessel V-2 / Oven O-1 | Process engineer | Auto |
| 03b | Packaging QC | Vision QA agent | Vision station VS-02 | Quality engineer | Approve |
| 04 | Heat treatment | Process agent | Vessel V-2 / Oven O-1 | Process engineer | Auto |
| 05 | Cooling | Process agent | Vessel V-2 / Oven O-1 | Process engineer | Auto |
| 06 | Filling | Process agent | Vessel V-2 / Oven O-1 | Process engineer | Auto |
| 07 | Lab release | Vision QA agent | Vision station VS-02 | Quality engineer | Approve |
| 08 | Palletize & ship | Logistics agent | Pack line P-1 | Shipping lead | Auto |

## Pharma GMP batch

*Regulated.* Electronic batch record from issue to QA release. Every stage signs its record; in-process QC gates compression.

**Flow:** Batch record issue → Dispensing + Equipment cleaning → Granulation → Drying → Compression → In-process QC + Coating prep → Coating → QA release

| # | Stage | Owning agent | Default resource | Gate role | Default mode |
| --- | --- | --- | --- | --- | --- |
| 01 | Batch record issue | Planning agent | ERP / MES link | Production planner | Auto |
| 02a | Dispensing | Supply agent | AGV fleet · Bay 2 | Materials lead | Auto |
| 02b | Equipment cleaning | Process agent | Vessel V-2 / Oven O-1 | Process engineer | Auto |
| 03 | Granulation | Process agent | Vessel V-2 / Oven O-1 | Process engineer | Auto |
| 04 | Drying | Process agent | Vessel V-2 / Oven O-1 | Process engineer | Auto |
| 05 | Compression | Process agent | Vessel V-2 / Oven O-1 | Process engineer | Auto |
| 06a | In-process QC | Vision QA agent | Vision station VS-02 | Quality engineer | Approve |
| 06b | Coating prep | Process agent | Vessel V-2 / Oven O-1 | Process engineer | Auto |
| 07 | Coating | Process agent | Vessel V-2 / Oven O-1 | Process engineer | Auto |
| 08 | QA release | Vision QA agent | Vision station VS-02 | Quality engineer | Approve |

## Additive manufacturing

*Fabrication.* Powder-bed builds: powder QC and nesting in parallel, post-processing chain, CT scan before release.

**Flow:** Build prep → Powder QC + Nesting → Print → Depowder → Heat treat + Build report → Support removal → CT scan inspection → Ship

| # | Stage | Owning agent | Default resource | Gate role | Default mode |
| --- | --- | --- | --- | --- | --- |
| 01 | Build prep | Scheduler agent | Cells CNC-04 / 05 | Cell lead | Auto |
| 02a | Powder QC | Vision QA agent | Vision station VS-02 | Quality engineer | Approve |
| 02b | Nesting | Scheduler agent | Cells CNC-04 / 05 | Cell lead | Auto |
| 03 | Print | Scheduler agent | Cells CNC-04 / 05 | Cell lead | Auto |
| 04 | Depowder | Scheduler agent | Cells CNC-04 / 05 | Cell lead | Auto |
| 05a | Heat treat | Process agent | Vessel V-2 / Oven O-1 | Process engineer | Auto |
| 05b | Build report | Vision QA agent | Vision station VS-02 | Quality engineer | Approve |
| 06 | Support removal | Scheduler agent | Cells CNC-04 / 05 | Cell lead | Auto |
| 07 | CT scan inspection | Vision QA agent | Vision station VS-02 | Quality engineer | Approve |
| 08 | Ship | Logistics agent | Pack line P-1 | Shipping lead | Auto |

## Sheet metal fabrication

*Fabrication.* Nest, cut, bend, weld and coat, with a final dimensional inspection before dispatch.

**Flow:** Order intake → Nesting → Laser cutting + Tube cutting → Press brake bending + Tube bending → Welding → Powder coat → Final inspection → Dispatch  
**Rework loop:** stage 07 sends units back to stage 05.

| # | Stage | Owning agent | Default resource | Gate role | Default mode |
| --- | --- | --- | --- | --- | --- |
| 01 | Order intake | Planning agent | ERP / MES link | Production planner | Auto |
| 02 | Nesting | Scheduler agent | Cells CNC-04 / 05 | Cell lead | Auto |
| 03a | Laser cutting | Scheduler agent | Cells CNC-04 / 05 | Cell lead | Auto |
| 03b | Tube cutting | Scheduler agent | Cells CNC-04 / 05 | Cell lead | Auto |
| 04a | Press brake bending | Scheduler agent | Cells CNC-04 / 05 | Cell lead | Auto |
| 04b | Tube bending | Scheduler agent | Cells CNC-04 / 05 | Cell lead | Auto |
| 05 | Welding | Scheduler agent | Cells CNC-04 / 05 | Cell lead | Auto |
| 06 | Powder coat | Process agent | Vessel V-2 / Oven O-1 | Process engineer | Auto |
| 07 | Final inspection | Vision QA agent | Vision station VS-02 | Quality engineer | Approve |
| 08 | Dispatch | Logistics agent | Pack line P-1 | Shipping lead | Auto |

## Surface finishing

*Process.* Pre-treatment, primer and paint booth passes, oven cure and film-thickness QC.

**Flow:** Receive parts → Pre-treatment → Primer → Paint booth → Cure oven → Film-thickness QC → Unload & pack  
**Rework loop:** stage 06 sends units back to stage 04.

| # | Stage | Owning agent | Default resource | Gate role | Default mode |
| --- | --- | --- | --- | --- | --- |
| 01 | Receive parts | Supply agent | AGV fleet · Bay 2 | Materials lead | Auto |
| 02 | Pre-treatment | Process agent | Vessel V-2 / Oven O-1 | Process engineer | Auto |
| 03 | Primer | Process agent | Vessel V-2 / Oven O-1 | Process engineer | Auto |
| 04 | Paint booth | Process agent | Vessel V-2 / Oven O-1 | Process engineer | Auto |
| 05 | Cure oven | Process agent | Vessel V-2 / Oven O-1 | Process engineer | Auto |
| 06 | Film-thickness QC | Vision QA agent | Vision station VS-02 | Quality engineer | Approve |
| 07 | Unload & pack | Logistics agent | Pack line P-1 | Shipping lead | Auto |

## Warehouse & kitting

*Logistics.* Demand-signal driven picking and kitting with verification before line-side delivery.

**Flow:** Demand signal → Pick → Kitting + Labeling → Kit verification → Line delivery

| # | Stage | Owning agent | Default resource | Gate role | Default mode |
| --- | --- | --- | --- | --- | --- |
| 01 | Demand signal | Planning agent | ERP / MES link | Production planner | Auto |
| 02 | Pick | Supply agent | AGV fleet · Bay 2 | Materials lead | Auto |
| 03a | Kitting | Supply agent | AGV fleet · Bay 2 | Materials lead | Auto |
| 03b | Labeling | Logistics agent | Pack line P-1 | Shipping lead | Auto |
| 04 | Kit verification | Vision QA agent | Vision station VS-02 | Quality engineer | Approve |
| 05 | Line delivery | Supply agent | AGV fleet · Bay 2 | Materials lead | Auto |

## Predictive maintenance

*Maintenance.* From anomaly to return-to-service: diagnosis, parts and downtime scheduled in parallel, verified by a test run.

**Flow:** Anomaly detection → Diagnosis → Spare parts reservation + Downtime scheduling → Repair → Verification run → Return to service

| # | Stage | Owning agent | Default resource | Gate role | Default mode |
| --- | --- | --- | --- | --- | --- |
| 01 | Anomaly detection | Maintenance agent | CMMS · Tech crew 2 | Maintenance lead | Auto |
| 02 | Diagnosis | Maintenance agent | CMMS · Tech crew 2 | Maintenance lead | Auto |
| 03a | Spare parts reservation | Maintenance agent | CMMS · Tech crew 2 | Maintenance lead | Auto |
| 03b | Downtime scheduling | Maintenance agent | CMMS · Tech crew 2 | Maintenance lead | Auto |
| 04 | Repair | Maintenance agent | CMMS · Tech crew 2 | Maintenance lead | Auto |
| 05 | Verification run | Maintenance agent | CMMS · Tech crew 2 | Maintenance lead | Auto |
| 06 | Return to service | Maintenance agent | CMMS · Tech crew 2 | Maintenance lead | Auto |

## Engineer-to-order

*Lifecycle.* Customer-specific designs: design review gates procurement and fabrication, factory acceptance test before delivery.

**Flow:** Customer request → Engineering design → Design review → Procurement + Fabrication + Software config → Long-lead receiving + Machining + Controls test → Assembly → Factory acceptance test → Delivery

| # | Stage | Owning agent | Default resource | Gate role | Default mode |
| --- | --- | --- | --- | --- | --- |
| 01 | Customer request | Planning agent | ERP / MES link | Production planner | Auto |
| 02 | Engineering design | Planning agent | ERP / MES link | Production planner | Auto |
| 03 | Design review | Vision QA agent | Vision station VS-02 | Quality engineer | Approve |
| 04a | Procurement | Supply agent | AGV fleet · Bay 2 | Materials lead | Auto |
| 04b | Fabrication | Scheduler agent | Cells CNC-04 / 05 | Cell lead | Auto |
| 04c | Software config | Line agent | Robot cell R-3 | Line supervisor | Auto |
| 05a | Long-lead receiving | Supply agent | AGV fleet · Bay 2 | Materials lead | Auto |
| 05b | Machining | Scheduler agent | Cells CNC-04 / 05 | Cell lead | Auto |
| 05c | Controls test | Vision QA agent | Vision station VS-02 | Quality engineer | Approve |
| 06 | Assembly | Line agent | Robot cell R-3 | Line supervisor | Auto |
| 07 | Factory acceptance test | Vision QA agent | Vision station VS-02 | Quality engineer | Approve |
| 08 | Delivery | Logistics agent | Pack line P-1 | Shipping lead | Auto |

## New product introduction

*Lifecycle.* Design release to rate: pilot build, first article inspection and capability study before ramp.

**Flow:** Design release → Process planning → Pilot build → First article inspection → Capability study → Ramp to rate  
**Rework loop:** stage 04 sends units back to stage 03.

| # | Stage | Owning agent | Default resource | Gate role | Default mode |
| --- | --- | --- | --- | --- | --- |
| 01 | Design release | Planning agent | ERP / MES link | Production planner | Auto |
| 02 | Process planning | Planning agent | ERP / MES link | Production planner | Auto |
| 03 | Pilot build | Line agent | Robot cell R-3 | Line supervisor | Auto |
| 04 | First article inspection | Vision QA agent | Vision station VS-02 | Quality engineer | Approve |
| 05 | Capability study | Vision QA agent | Vision station VS-02 | Quality engineer | Approve |
| 06 | Ramp to rate | Planning agent | ERP / MES link | Production planner | Auto |

## Rework & recall

*Quality.* Containment and root cause on a reported defect, rework, re-inspection and customer notice.

**Flow:** Defect report → Containment + Customer notice → Root-cause analysis + Stock sweep → Rework → Re-inspection → Close-out  
**Rework loop:** stage 05 sends units back to stage 04.

| # | Stage | Owning agent | Default resource | Gate role | Default mode |
| --- | --- | --- | --- | --- | --- |
| 01 | Defect report | Vision QA agent | Vision station VS-02 | Quality engineer | Approve |
| 02a | Containment | Vision QA agent | Vision station VS-02 | Quality engineer | Approve |
| 02b | Customer notice | Logistics agent | Pack line P-1 | Shipping lead | Auto |
| 03a | Root-cause analysis | Vision QA agent | Vision station VS-02 | Quality engineer | Approve |
| 03b | Stock sweep | Supply agent | AGV fleet · Bay 2 | Materials lead | Auto |
| 04 | Rework | Line agent | Robot cell R-3 | Line supervisor | Auto |
| 05 | Re-inspection | Vision QA agent | Vision station VS-02 | Quality engineer | Approve |
| 06 | Close-out | Vision QA agent | Vision station VS-02 | Quality engineer | Approve |

## Protein synthesis

*Regulated.* Expression of a recombinant protein, purification, characterisation and QC release, the autonomous-lab example from [research.md](research.md). The order quantity is the number of batches (1 for a single expression). Most of its criteria are **measured parameters**: an instrument's signal over the stage window, judged against a band, rather than unit counts. See [Parameters](#parameters-success-criteria) below.

**Flow:** Batch record issue → Expression (bioreactor) → Harvest and lysis → Purification (FPLC) → Characterisation → QC release → Fill and finish  
**Rework loop:** none.

| # | Stage | Owning agent | Default resource | Gate role | Default mode | Parameters |
| --- | --- | --- | --- | --- | --- | --- |
| 01 | Batch record issue | Planning agent | System | Line supervisor | Auto | — |
| 02 | Expression (bioreactor) | Process agent | Process vessel | Process engineer | Auto | Culture temperature (temperature, stays within) 35–39 °C; Cell density OD600 (od600, final value) ≥ 0.6; Dissolved oxygen (dissolved_oxygen, minimum) ≥ 30 % |
| 03 | Harvest and lysis | Line agent | Robot cell | Line supervisor | Auto | Yield ≥ 95 % |
| 04 | Purification (FPLC) | Process agent | Process vessel | Process engineer | Auto | Protein yield (yield_mg_l, final value) ≥ 10 mg/L; Purity (purity_pct, final value) ≥ 95 %; Column pressure (pressure_bar, maximum) ≤ 3 bar |
| 05 | Characterisation | Vision QA agent | Inspection station | Quality engineer | Auto | Specific activity (specific_activity, final value) ≥ 50 U/mg; Aggregates (aggregate_pct, maximum) ≤ 5 % |
| 06 | QC release | Vision QA agent | Manual station | Quality engineer | Approve | Endotoxin (endotoxin_eu_mg, final value) ≤ 0.5 EU/mg; Bioburden (bioburden_cfu, final value) = 0 CFU |
| 07 | Fill and finish | Logistics agent | Pack line | Line supervisor | Auto | Fill yield ≥ 99 % |

## Parameters (success criteria)

A stage's success criteria are its **parameters**. Each is judged from measured data only; a parameter nobody measured is never assumed to pass, it stops the stage at a gate for a person to confirm. A criterion names what it measures (`kind`):

| Kind | Measured from | Example |
| --- | --- | --- |
| Yield %, Scrap %, Defects ppm | the stage's good and scrap counts | Yield ≥ 95 % |
| Cycle time | counts and the stage's elapsed time | Cycle time ≤ 62 s |
| OEE % | the stage's asset, over the stage window | OEE ≥ 80 % |
| Measured signal | one signal of the stage's asset over the stage window, reduced by an aggregate: **final value**, **minimum**, **maximum**, **mean**, or **stays within** (the window's minimum and maximum must both be inside a range) | Culture temperature (temperature, stays within) 35–39 °C |
| Confirmed by a person | nothing automatic; a person confirms it at the gate | Cpk ≥ 1.33 |

Older templates carry no `kind`; the label says what it is (yield, scrap, defects ppm, cycle time, OEE), anything else is confirmed by a person.

- **Ranges.** A criterion with a lower and an upper bound (`target` and `targetMax`) renders as `35–39 °C` and passes when the value is inside. It is two statements, one per bound, so each bound gets its own zero-knowledge proof on the lot passport.
- **Where the signal comes from.** A measured signal is read from telemetry the stage's asset reported during the stage: a gateway, an MTConnect agent, a CSV replay, or readings a person records (on the asset, or in the stage's **Record units** dialog, which stores them with the stage when it has no asset). Ordo keeps a signal an active stage reads even when it is not a standard machine signal; see [data-sources.md](data-sources.md).
- **What is kept.** When a stage's work finishes, the series its parameters read are snapshotted with the run (`stage_series`, at most 120 points per signal), so the chart survives telemetry retention. Live telemetry serves the same view while the stage runs.
- **What is shown.** The console draws every parameter against its band (the acceptable region, the measured value as a marker: ● pass, ▲ out of spec, ○ not measured) on the flow node, the stage popover, the stage drawer with the signal's trend, the approval, the validation package (which attaches the chart as evidence) and the public passport, where the band and the proof status are public and the value is not.
- **What is proven.** Each parameter a stage met is proven in zero knowledge (`spec_check`) from a commitment recorded when the stage closed: the instrument's gateway's own signed commitment where it measured the value, Ordo's otherwise. Count parameters are additionally proven from the source-signed counts (`stage_check`). Source-signed parameter proofs are re-verified on-chain when the lot is released. See [proof-of-work.md](proof-of-work.md).
- **Completion by phase.** A stage may set `completeOn: { signal, equals }` (in the builder, "Completes when"), for example `execution = COMPLETE`: the stage's work is done when its asset reports that phase after the stage started, rather than when counts reach the order quantity, and the order then counts as made. Without it, a batch process uses the order quantity as its batch count.

## Default success criteria by agent

The builder seeds each stage's success criteria from its owning agent:

| Agent | Criteria |
| --- | --- |
| Vision QA agent | First-pass yield ≥ 97%; Defects ≤ 500 ppm; Cpk (critical dim.) ≥ 1.33 |
| Planning agent | On-time release ≥ 98%; Plan adherence ≥ 95%; Data completeness 100% |
| Supply agent | Kit accuracy ≥ 99.5%; Material availability 100%; Inbound lead time ≤ 2 h |
| Line agent | Cycle time ≤ 62 s; OEE ≥ 80%; Scrap ≤ 1.0% |
| Scheduler agent | OEE ≥ 80%; Scrap rate ≤ 1.5%; Cycle time ≤ 4.2 min |
| Process agent | Temperature deviation ≤ ±2 °C; Batch yield ≥ 96%; Moisture ≤ 2.5% |
| Logistics agent | Pack accuracy ≥ 99.8%; On-time ship ≥ 97%; Damage rate ≤ 0.2% |
| Maintenance agent | MTTR ≤ 90 min; Planned vs unplanned ≥ 85%; Repeat failures 0 |
