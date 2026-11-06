# Validation & sign-off workflow

A validation package is the formal record that a stage, process change, pilot, machine qualification or proof of concept meets its acceptance criteria. It holds scope, checks, evidence, an ordered signature chain and an audit trail.

## Package types

| Type | Used to prove | Typical outcome on approval |
| --- | --- | --- |
| Stage validation | A stage on a specific run meets its criteria | Gate released; stage may move up an autonomy level |
| Process change | A changed parameter, recipe or profile is safe | Change becomes the line default |
| Pilot validation | A new recipe or method works across pilot batches | Added to approved list |
| Proof of concept | A new pipeline or part replacement is viable | New pipeline published at L2 |
| Operational qualification | A new or repaired asset performs like existing ones | Asset joins the agent pool |

## Steps

```mermaid
stateDiagram-v2
    [*] --> Draft
    Draft --> Draft: Agent pre-check (fills automated checks, evidence, assessment)
    Draft --> InReview: Owner signs "Performed by" and submits
    InReview --> InReview: Validator signs "Reviewed by"
    InReview --> Released: Manager signs "Approved by"
    InReview --> ChangesRequested: Request changes (comment required)
    InReview --> Rejected: Reject (comment required)
    ChangesRequested --> InReview: Owner fixes, re-runs pre-check, resubmits
    Released --> [*]
    Rejected --> [*]
```

1. **Draft.** A manager creates the package and assigns its owner, who performs it: themselves, or a contributor. The owner defines objective, acceptance criteria, sample plan and trial window. Checks are seeded from the stage's success criteria. Until Performed by is signed (a draft, or a package returned with changes requested), a manager can assign it to someone else.
2. **Agent pre-check.** The owning agent fills in every automated check from run data by comparing each measured value with its target, attaches generated evidence (the run record, and a parameter chart that draws each parameter against its band with the signal's trend over the stage), and writes an assessment with key figures and confidence.
3. **Submit.** The owner records manual checks (Pass / Fail), attaches required evidence and signs as **Performed by**.
4. **Review.** A validator (or a manager) signs as **Reviewed by**, or requests changes / rejects with a mandatory comment. With OrdoTrust configured, the reviewer needs an active stake.
5. **Approval.** A manager signs as **Approved by**; with OrdoTrust configured, a manager with an active stake.
6. **Released.** The outcome is applied (gate released, autonomy promoted, change made default) and recorded in the ledger.

## Signature chain

| Order | Role | Meaning | Person (prototype) |
| --- | --- | --- | --- |
| 1 | Package owner (a contributor or a manager, assigned by a manager) | Performed by | A. Rivera |
| 2 | Validator | Reviewed by | M. Okafor |
| 3 | Manager | Approved by | S. Lindqvist |

## Rules

- **Sign & submit** is enabled only when the pre-check has run, every check is recorded, no check has failed and all required evidence is attached.
- Only the role at the current step may sign; a manager may sign any step. Each signature states its meaning and requires the signer to confirm they reviewed the checks and evidence.
- One person signs at most one link of the chain. The one exception: in an org with exactly one manager, that manager may approve a package they performed, so a one-manager org can still release. A different person still reviews it, and the ledger and the audit trail record that the approver also performed it (`soleManager`).
- Request changes and Reject require a comment. A returned package goes back to its owner; all later signatures are cleared on resubmit.
- Re-running the pre-check after changes refreshes automated results and the assessment. A result a person recorded over an agent's measurement stays theirs; the agent's new value is kept beside it.
- Any check's value can be changed, an agent's measurement included: by the owner until they sign Performed by, and by a validator or manager until release. The agent's measured value stays on record beside the person's, and the change (from, to, who) goes to the audit trail and the decision stream. A change during review alters what the owner signed, so the package goes back to its owner to sign Performed by again over the corrected values; the validator then signs it on.
- Files are hashed on upload. A changed file is a new version; earlier versions stay in the record.
- Every action (create, attach, remove, check, sign, return, release) writes an audit entry.

## Readiness checklist (what blocks "Sign & submit")

| Check | Passes when | Shown as |
| --- | --- | --- |
| Agent pre-check run | The owning agent has filled the automated checks | ✓ Agent pre-check run |
| Checks recorded | Every check has a result (automated or manual) | Checks recorded 5/5 |
| No failed checks | No check is marked Fail | ▲ 1 failed check, if any |
| Required evidence | Every evidence slot marked *Required* has a file | Required evidence 2/2 |

Agent-generated evidence (the run record, the parameter chart) is attached automatically when the pre-check runs. Optional evidence never blocks submission.

## Who sees what

| Role | Sees the package as | Can do |
| --- | --- | --- |
| Package owner | Editable while Draft or Changes requested | Edit objective and acceptance, run pre-check, record or change any check (agent-measured ones too), attach/remove evidence, sign and submit |
| Contributor to the stage | A summary: status, who it waits on, whether each check passed | — (no measured values, files or audit details) |
| Validator | "Awaiting signature" when it is their step | Change any check's value until release (a change in review returns the package to its owner to sign again), sign "Reviewed by", request changes, reject |
| Manager | Locked, "Awaiting signature" when it is their step | Create a package and assign its owner, reassign it before Performed by, sign "Approved by" (or any step), request changes, reject |
| Anyone else | Read-only, with a note saying who it is waiting on | — |

Packages hold proofs and evidence, so members at level 3 and up see every package. Below that (contributors, level 2 by default), a member sees the packages assigned to them, in full, to perform; and the packages on stages they contributed proof of work to, as a summary. An owner must hold the contributor role (or manager) and reach level 2.

The **Needs me** filter shows packages where the current user is the owner of a draft or returned package, or holds the role at the current signature step.

## Worked example: a returned process change

Package **VP-117 · Reflow profile rev D** (Process change, Electronics SMT line, stage 05 · Reflow) in the prototype:

1. **Objective:** lower peak reflow temperature by 4 °C to reduce stress on a new BGA package.
2. **Acceptance:** BGA void rate ≤ 25% (X-ray); AOI first-pass ≥ 99%; no tombstoning; peak 238–245 °C.
3. **Pre-check:** the Process agent records peak 241 °C ✓, time above liquidus 74 s ✓, AOI first-pass 99.4% ✓, but **void rate 27% ✗** (2 of 5 boards above the limit). Confidence 0.74.
4. The owner signs **Performed by** and submits.
5. The validator **requests changes**: "Void rate is above the limit on 2 of 5 boards. Extend soak by 10 s and re-run X-ray." The package returns to its owner; the validator's step shows *Returned*.
6. The owner extends soak by 10 s and **re-runs the pre-check**. The void rate is now 21% ✓; the assessment and confidence (0.87) update.
7. The owner **resubmits**. All later signatures are cleared, and the chain starts again at review.
8. The validator and a manager sign. On release, **profile rev D becomes the line default**, and every step above is in the audit trail.

## Outcomes applied on release

| Package type | What changes in the system |
| --- | --- |
| Stage validation | The linked gate is released and the stage completes; the stage may be promoted one autonomy level |
| Process change | The new parameter, recipe or profile becomes the line default |
| Pilot validation | The recipe or method is added to the approved list |
| Proof of concept | The new pipeline is published as a template at L2 |
| Operational qualification | The asset joins the owning agent's pool (e.g. CNC-07 joins the Scheduler agent pool) |
