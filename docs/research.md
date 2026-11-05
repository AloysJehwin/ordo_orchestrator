# Research behind the lab pitch

Related work for presenting Ordo as the verification layer of an autonomous lab: a protein-synthesis lab that runs itself, with scientists who sign off what it produces. Use it for the submission, the README and the pitch deck. Collected 22 October 2026.

Contents: the pitch in one paragraph, then the papers in three groups (autonomous labs exist, their results need verifying, and the case for tamper-evident research records), then how Ordo maps onto a lab, and what to check before quoting.

## The pitch in one paragraph

AI-run labs such as SAMPLE and Coscientist already design and run experiments without people. A-Lab showed that their results still need accountable experts to check them, and more than 70% of scientists say they have failed to reproduce someone else's experiment. Ordo makes every result signed by a verified human scientist, anchored on-chain, and paid for only when it is proven.

## 1. Autonomous labs exist

| Paper | What it shows | Use it for |
| --- | --- | --- |
| Rapp, Bremer & Romero, "Self-driving laboratories to autonomously navigate the protein fitness landscape", *Nature Chemical Engineering* 1, 97–107 (January 2024), doi:10.1038/s44286-023-00002-4. [PMC](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC10926838/), [bioRxiv](https://www.biorxiv.org/content/10.1101/2023.05.20.541582.full.pdf) | SAMPLE: an AI agent designs proteins, and robots synthesise the genes, express the proteins and measure enzyme activity, with no human in the loop. Its agents found glycoside hydrolases at least 12 °C more heat-stable while testing under 2% of the sequence space | The closest real example of the autonomous protein lab |
| Boiko, MacKnight, Kline & Gomes, "Autonomous chemical research with large language models", *Nature* (December 2023), doi:10.1038/s41586-023-06792-0. [CMU news](https://www.cmu.edu/news/stories/archives/2023/december/cmu-designed-artificially-intelligent-coscientist-automates-scientific-discovery) | Coscientist: a GPT-4 agent with search, code execution and lab robots plans and runs real experiments, including optimising palladium-catalysed cross-couplings | The reference for an AI agent driving instruments, as Ordo's agents do |
| Tom et al. (Aspuru-Guzik group), "Self-Driving Laboratories for Chemistry and Materials Science", *Chemical Reviews* (2024), doi:10.1021/acs.chemrev.4c00055. [ChemRxiv](https://chemrxiv.org/engage/chemrxiv/article-details/66708e2e5101a2ffa8cbd354) | The main review of self-driving labs: hardware, software, integration, and uses from drug discovery to genomics | Showing the field is real and growing |
| Automated cell-free protein synthesis: Jun, Hong, Park, Shin & Lee, review in *Journal of Microbiology and Biotechnology* (2025), [PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC12463565/); Protein Production Sweden, [automated workflow](https://pps.gu.se/en/news/fully-automated-small-scale-cell-free-protein-synthesis-enables-parallel-expression-and-purification-of-proteins-in-less-than-four-hours); wheat-germ cell-free system for parallel expression, [PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC137474) | Plasmid to purified protein in under four hours, 96 reactions at a time, on Opentrons and Agilent Bravo robots; wheat-germ systems translate at least 50 genes in parallel, 0.1–2.3 mg per gene in two days | Realistic stages, timings and yields for a protein-synthesis pipeline template |

## 2. Autonomous results need verifying

| Source | What it shows | Use it for |
| --- | --- | --- |
| A-Lab: Szymanski et al., *Nature* (2023), and the challenge to it. [Chemistry World](https://www.chemistryworld.com/news/are-we-rushing-ahead-with-ai-in-the-lab/4019424.article), [VentureBeat](https://venturebeat.com/ai/ai-meets-materials-science-the-promise-and-pitfalls-of-automated-discovery), [correction record](https://kingy.ai/mathematics-science-breakthrough-tracker/records/science-correction-2026-a-lab-autonomous-materials/) | An autonomous lab reported dozens of new inorganic materials. Robert Palgrave and Leslie Schoop re-checked the X-ray data and disputed the claims. The paper was later corrected: 36 of 57 targets made, and new to the lab rather than new to science | The strongest single argument: fast autonomous results still need accountable experts to verify them, which is Ordo's validator layer |
| Baker, "1,500 scientists lift the lid on reproducibility", *Nature* 533, 452–454 (2016). [Overview](https://editage.com/insights/is-the-reproducibility-crisis-real-an-overview-of-natures-survey), [summary](https://wiki.oroboros.at/index.php/Baker_2016_Nature) | Of 1,576 researchers surveyed, over 70% had failed to reproduce another scientist's experiment and over half their own; 52% said there is a significant crisis. Selective reporting and pressure to publish were the most cited causes | The standard citation for the reproducibility problem |

## 3. Tamper-evident research records

| Paper | What it shows | Use it for |
| --- | --- | --- |
| Benchoufi & Ravaud, "Blockchain technology for improving clinical research quality", *Trials* 18, 335 (2017). [PDF](https://trialsjournal.biomedcentral.com/track/pdf/10.1186/s13063-017-2035-z) | Argues blockchain can improve reproducibility, data sharing, privacy and enrolment in trials | The case for "why blockchain" in research |
| Wong et al. (UCSF), *Nature Communications* (2019). [UCSF news](https://www.ucsf.edu/news/2019/02/413356/could-blockchain-ensure-integrity-clinical-trial-data) | A proof-of-concept portal that hashes and chains each trial data entry, so any tampering shows; tested on part of a Phase II trial | Prior art for Ordo's hash-chained, anchored ledger |
| TrialChain: "A Blockchain-Based Platform to Validate Data Integrity in Large, Biomedical Research Studies", [arXiv:1807.03662](https://arxiv.org/pdf/1807.03662) | Blockchain validation of data integrity in large biomedical studies | Further prior art |
| Weidener & Spreckelsen, "Decentralized Science (DeSci): Definition, Shared Values, and Guiding Principles", *Frontiers in Blockchain* (July 2024), doi:10.3389/fbloc.2024.1375763. [PDF](https://www.frontiersin.org/journals/blockchain/articles/10.3389/fbloc.2024.1375763/pdf) | A peer-reviewed definition of DeSci and its principles, from a literature review and an expert survey | Positioning Ordo within DeSci |

## How Ordo maps onto a protein lab

| Ordo today | In the lab |
| --- | --- |
| Pipeline and run; the **Protein synthesis** library template ([pipeline-templates.md](pipeline-templates.md#protein-synthesis)) | Experiment protocol: batch record, express, harvest, purify, characterise, QC release, fill |
| Assets and data sources; the gateway's instrument profiles (`SIM_PROFILE`) for demos | Instruments: bioreactor, FPLC or HPLC, plate reader, mass spectrometer |
| Stage parameters: measured signals over the stage window, judged against bands and ranges, drawn on the flow and the passport | Acceptance criteria: temperature held 35–39 °C, OD600, dissolved oxygen, yield (mg/L), purity (at least 95%), column pressure, activity, aggregates, endotoxin, bioburden |
| Validators: performed by, reviewed by, approved by | Bench scientist performs, peer reviewer reviews, PI or QA approves |
| World ID, one person per seat | One verified human scientist per reviewer seat |
| Zero-knowledge proofs of criteria | Proof that a batch met spec without revealing proprietary data |
| Lot passport with QR | Batch certificate of analysis anyone can verify |
| Pay on proof | A funder or customer pays the contract lab when the batch is verified |
| Validator stake and slashing | Reviewer bond, slashed for a fraudulent sign-off |
| Agent iNFT with memory | A protocol-optimisation agent other labs can license |
| x402 MCP tools | Other labs' AI agents pay per analysis call |
| Maintenance agent | Instrument-health agent: pump pressure drift, column fouling |

## Before quoting

- **A-Lab numbers.** The counts above come from news coverage and a correction tracker, and they differ between sources (40-plus, 41, 43 new materials originally; 36 of 57 after correction). Check the Nature correction notice before putting a number on a slide.
- **Blockchain-for-research papers** are mostly proofs of concept and commentary. Say "researchers have proposed", not "this is proven".
- **Compliance.** Ordo's EIP-712 signatures are in the spirit of electronic-signature rules for regulated labs (FDA 21 CFR Part 11, GLP). Do not claim Ordo is compliant.
- **Simulated data.** Say the instrument data in the demo is simulated. Judges with a biology background will notice implausible units or yields.
- **Not yet read:** "LAP: An Agent-to-Instrument Protocol for Autonomous Science", [arXiv:2606.03755](https://arxiv.org/pdf/2606.03755). It looks relevant to the agent-to-instrument layer; read it before citing.
