# Ordo · Real-time industrial data sources

Researched and checked against vendor pages on 2 October 2026. Prices and availability change, so confirm with each provider before you commit.
**RT** = real-time stream · **NRT** = near-real-time · **Batch** = periodic or file download.

Only the MTConnect demo agent was confirmed serving live data during this research (OKUMA and Mazak streams, timestamped 1 Oct 2026). The OPC UA and MQTT endpoints are listed by their vendors or community registries; uptime is not guaranteed.

## How these map to Ordo's architecture

| Ordo layer | Use |
|---|---|
| L1 Shop floor (no factory yet) | Public demo servers, simulators, replayed datasets (sections 1–2) |
| L2 Edge gateway | HiveMQ Edge, Litmus Edge, Kepware, Ignition, HighByte (section 3) |
| L3 Data platform | MQTT broker, Kafka, time-series DB, cloud IoT services (section 4) |
| Planning & Supply agents | Metals, energy, freight, supplier-risk and macro feeds (section 5) |

## Ordo's own gateway and fixtures

The console has no simulator. For a demo without a machine, the edge gateway (`server/scripts/gateway.ts`) can stand in for one:

- `SIM_CYCLE_S` simulates a machine making a part every n seconds (the default).
- `SIM_PROFILE=bioreactor|fplc|plate_reader` simulates an instrument running a profile: its signals (temperature, OD600, dissolved oxygen and pH for the bioreactor; pressure, purity and yield for the FPLC; activity, aggregates, endotoxin for the plate reader) follow a drift and a swing, and it counts one batch (`SIM_BATCH_UNITS`, default 1) every `SIM_STAGE_S` seconds (default 180). The gateway signs the finished stage's counts as it would for any machine.
- `server/fixtures/replays/protein-expression.csv` is a simulated one-hour expression run in long format (time, signal, value), accepted by the asset's **Replay a dataset** upload for sites without a gateway.

**Which signals are stored.** Ingest keeps a standard set of machine signals (execution, part count, scrap, load, spindle speed, temperature and so on), any signal the asset has a limit for, and any signal a measured-parameter criterion of an active stage on that asset reads. Everything else is dropped, so an instrument's data before its stage starts is not kept unless the asset has a limit for it. Start the gateway before the run; the demo does.

---

## 1. Free public live and test sources (usable for a demo today)

| Name | Data | Endpoint / access | Mode | Cost |
|---|---|---|---|---|
| MTConnect Institute demo agent | Live CNC streams (OKUMA, Mazak), MTConnect 2.8 | `https://demo.mtconnect.org/probe`, `/current`, `/sample?from=&count=` (REST/XML) | RT | Free |
| Eclipse Milo demo server | Simulated variables, methods, events | `opc.tcp://milo.digitalpetri.com:62541/milo` (Docker image also available) | RT | Free |
| Unified Automation demo (opcuaserver.com) | Demo address space (boilers, machines) | `opc.tcp://opcuaserver.com:48010` | RT | Free |
| Prosys public Simulation Server | Sine, random and counter signals | `opc.tcp://uademo.prosysopc.com:53530/OPCUA/SimulationServer` | RT | Free |
| umati sample server | OPC UA Machine Tools companion spec | `opc.tcp://opcua3.umati.app:4840` | RT | Free |
| Other public OPC UA servers | Assorted demo nodes | `opc.tcp://opcuademo.sterfive.com:26543`, `opc.tcp://opcua.rocks:4840`, `opc.tcp://opcua-demo.factry.io:51210` | RT | Free |
| HiveMQ public broker | Open MQTT test broker (publish your own simulators) | `broker.hivemq.com` 1883 / 8883 TLS / 8000 WS / 8884 WSS | RT | Free, not for production |
| EMQX public broker | Open MQTT 5 test broker | `broker.emqx.io` 1883 / 8883 / 8083 WS `/mqtt` / 8084 WSS | RT | Free, all traffic public |
| Microsoft OPC PLC simulator | Sine waves with spikes and dips, boilers, pumps, stacklight, custom nodes | Docker `mcr.microsoft.com/iotedge/opc-plc`, OPC UA on port 50000 | RT (self-hosted) | Free, open source |
| Prosys OPC UA Simulation Server | Configurable signals, history, events; MQTT PubSub | Desktop app | RT | Free edition; Pro is paid |
| Eclipse Tahu | Sparkplug B reference edge nodes, usable as a simulator | MQTT / Sparkplug B (Java, JS, Python, C) | RT | Free, open source |
| Litmus Edge Developer Edition | Full Litmus Edge with 250+ connectors | Self-hosted; workspace resets every 2 h | RT | Free |
| Ignition trial / Maker Edition | SCADA/IIoT gateway with simulator devices and MQTT | OPC UA, MQTT, SQL, REST | RT | Trial free (2 h resets); Maker free for non-commercial use |
| NIST SMS Test Bed (VDS) | Real machining lab data over MTConnect | `https://smstestbed.nist.gov/vds/current` | RT | Free. **Host did not resolve during research; probably offline.** |

## 2. Open datasets to train agents or replay as streams

| Dataset | Content | Replay as stream | Licence |
|---|---|---|---|
| NASA PCoE repository (C-MAPSS turbofan, IMS/FEMTO bearings, milling) | Run-to-failure time series | Yes; ideal for the Maintenance agent | Free |
| Microsoft Azure Predictive Maintenance (Kaggle) | Hourly telemetry, errors, maintenance, failures for 100 machines | Yes; best "fleet" replay | Free |
| AI4I 2020 (UCI) | 10k records: temperature, rpm, torque, tool wear, 5 failure modes | Row by row | Free |
| SECOM (UCI) | 590 semiconductor process sensors, pass/fail | Yes (timestamped) | Free |
| Bosch Production Line Performance (Kaggle) | Station measurements and pass/fail | Partly (anonymized timing) | Kaggle terms |
| Tennessee Eastman Process | Chemical process with 21 fault types | Yes; fits Batch chemical / Pharma pipelines | Free |
| MVTec AD / AD 2 | Vision anomaly images | As image events for Vision QA | **CC BY-NC-SA: demos only, not commercial** |
| NIST AM Bench | Additive-manufacturing data | Partly | Free |
| CWRU Bearing Data Center | Vibration fault data | Yes | Free (URL not verified) |

## 3. Edge connectivity and industrial DataOps platforms

| Name | What it does | Interfaces | Pricing |
|---|---|---|---|
| HiveMQ Edge | Open-source gateway: OPC UA, Modbus, S7, EtherNet/IP, MTConnect, BACnet → MQTT | MQTT | Free open source; commercial licence for extras |
| Litmus Edge / Litmus UNS | 250+ PLC/CNC drivers, normalizes and publishes; powers Google Manufacturing Connect | OPC UA, MQTT, REST, Kafka | Free Developer Edition; production by quote |
| HighByte Intelligence Hub | Contextualizes data, models a Unified Namespace; MQTT broker, REST, MCP | OPC UA, MQTT/Sparkplug, REST, SQL, PI | Professional $18.5k/yr; Enterprise by quote |
| Kepware Server | 150+ PLC drivers; IoT Gateway for MQTT/REST | OPC UA/DA, MQTT, REST | Per driver. **Now sold by Velotic** (PTC Kepware + ThingWorx + GE Proficy, Mar 2026) |
| Ignition (Inductive Automation) | SCADA, MES, UNS hub | OPC UA, MQTT/Sparkplug, REST, SQL | Per server |
| Softing edgeConnector | Docker connectors for S7, 840D and similar | OPC UA, MQTT | Per licence |
| AVEVA PI System / CONNECT | Historian and cloud time-series store | PI Web API, CONNECT REST, OMF | Enterprise |
| Cognite Data Fusion | Industrial knowledge graph and data models | REST/GraphQL, SDKs | Enterprise |
| Rockwell FactoryTalk DataMosaix | DataOps built on Cognite | REST | Enterprise |
| Siemens Insights Hub + Industrial Edge | IIoT platform and edge apps | REST | Quote |
| MachineMetrics | CNC monitoring, cycles, downtime | GraphQL, REST | Subscription |
| Tulip | Frontline apps and machine monitoring | REST, OPC UA/MQTT connectors | Subscription |
| Seeq | Process analytics with an AI agent (2026) | Historian connectors, REST/Python | Enterprise |
| TrendMiner | Time-series analytics (now owned by Proemion) | Historian connectors, REST | Quote |
| Crosser | Low-code edge streaming | MQTT, OPC UA, Kafka, REST | Quote |

## 4. Cloud industrial IoT, brokers and time-series databases

| Name | Role in Ordo | Interfaces | Pricing / status |
|---|---|---|---|
| AWS IoT SiteWise + SiteWise Edge | Asset models and industrial time series; edge ingests OPC UA and MQTT | OPC UA, MQTT, REST | Pay per use. SiteWise Monitor is closed to new customers |
| AWS IoT Core / Greengrass v2 | MQTT ingress, edge runtime | MQTT, HTTPS, WebSocket | Pay per use, free tier |
| Azure IoT Operations | Kubernetes edge: MQTT broker, OPC UA connector, data flows | MQTT, OPC UA | Pay per use; active |
| Azure IoT Hub | Device telemetry ingress | MQTT, AMQP, HTTPS | Free tier 8,000 msgs/day |
| Azure Event Grid MQTT broker | Managed MQTT with Sparkplug B | MQTT 3.1.1/5 | Pay per use |
| Microsoft Fabric Real-Time Intelligence | Streaming ingest, KQL time-series analytics, alerts | Event Hubs/Kafka, MQTT | Fabric capacity |
| Google Manufacturing Data Engine + Manufacturing Connect | Plant data model → BigQuery/Vertex AI (Litmus edge) | Pub/Sub, BigQuery | Quote / pay per use |
| ClearBlade IoT Core | Replacement for retired Google Cloud IoT Core | MQTT, REST | Usage-based |
| HiveMQ Platform / Cloud | Enterprise MQTT / UNS broker | MQTT, Sparkplug | Free "Lab" tier; Cloud from $0.34/h |
| EMQX Cloud | Managed MQTT | MQTT 5, rules engine | Serverless free quota (1M session-min/month) |
| Confluent Cloud | Managed Kafka event bus | Kafka, REST | 30-day trial credit, then usage |
| InfluxDB 3 | Time-series DB | Line protocol, SQL | Core free/open source |
| TimescaleDB / Tiger Cloud | Postgres time series: plant state + telemetry together | Postgres | Open source; cloud from ~$30/month |
| QuestDB | High-ingest time-series DB | Line protocol, Postgres, REST | Open source; self-serve cloud discontinued |

**Retired or retiring, avoid:** AWS IoT Analytics (retired Dec 2025), AWS IoT Events (retired May 2026), Amazon Lookout for Equipment (ends 7 Oct 2026), Greengrass v1, Azure IoT Central (retiring 2029, no new apps), Azure Time Series Insights and Google Cloud IoT Core (retired).

## 5. External market, supply-chain and macro data (Planning & Supply agents)

| Name | Data | Access | Mode | Pricing |
|---|---|---|---|---|
| LME (LMElive) | Official base-metal prices | Vendor feeds | RT / 30-min delayed | From $315/month RT; 4-week trial |
| Metals-API | LME and precious metals | REST/JSON | NRT | $19.99–$999/month |
| Fastmarkets | Metals and battery-material prices | REST API | Batch/NRT | Subscription |
| EIA Open Data API v2 | US electricity, fuels, prices | REST, free key | Hourly | Free |
| ENTSO-E Transparency Platform | EU day-ahead prices, load, generation | `https://web-api.tp.entsoe.eu/api` (token by email) | Hourly / 15-min | Free |
| Electricity Maps | Grid carbon intensity, forecasts | REST | RT/hourly | Free non-commercial; commercial ~€4.5–6k per signal/yr |
| IEX India Real-Time Market | 15-min power prices | Web table/export (no public API) | 15-min | Free |
| Freightos Terminal (FBX/FAX) | Container and air freight indices | Data API | Daily | From $119/month |
| project44 / FourKites | Shipment visibility | REST, webhooks | RT | Enterprise |
| Kpler (MarineTraffic, Spire) | Vessel tracking, port calls | REST/streaming | RT | From ~$100/month |
| Interos / Resilinc / Everstream | Supplier and multi-tier risk | Platform/API | NRT | Enterprise |
| FRED API v2 | 800k+ economic series incl. industrial production | REST, free key | On release | Free |
| S&P Global PMI (incl. HSBC India PMI) | Manufacturing PMI | Press releases / subscription | Monthly | Headlines free |
| Eurostat | EU industrial production, prices | SDMX 3.0 REST | Monthly | Free |
| **MoSPI eSankhyiki (India)** | IIP, CPI, WPI, ASI, energy | REST `api.mospi.gov.in`; **MCP server** `https://mcp.mospi.gov.in` (beta) | Monthly | Free; agents can call the MCP server directly |
| Open-Meteo | Weather forecast and history | REST, no key | Hourly | Free non-commercial |
| Tomorrow.io | Weather and hazards | REST | RT | Free 500 req/day |

---

## Recommended stack

**Prototype (free or under ~$50/month)**
- Shop floor: Microsoft OPC PLC containers per line, the live MTConnect demo for machining, and NASA C-MAPSS / Azure PdM data replayed over MQTT Sparkplug B (Tahu) for maintenance; Tennessee Eastman for batch/pharma.
- Edge: HiveMQ Edge (open source) or Litmus Edge Developer Edition.
- Broker: self-hosted EMQX or Mosquitto (public brokers only for quick tests; everything there is visible).
- Storage: TimescaleDB or InfluxDB 3 Core.
- External: FRED, EIA or ENTSO-E, MoSPI API/MCP, Open-Meteo.

**Production**
- Edge: Litmus Edge, or Kepware/Ignition with HighByte for UNS modelling, Sparkplug B over MQTT.
- Broker: HiveMQ Enterprise or EMQX Dedicated bridged to Confluent Kafka.
- Cloud: Azure IoT Operations + Fabric RTI, or AWS SiteWise + IoT Core/Greengrass v2, or Google MDE + Litmus.
- Connect to AVEVA PI or Cognite where customers already run them.
- Paid feeds: LMElive or Metals-API, Freightos, project44, Electricity Maps, Interos or Resilinc.

**Not verified:** `test.mosquitto.org`, CWRU URL, ISM / Argus / FourKites / World Bank details, current status of Canvass AI, Crosser, Everstream.

## Key sources
- Public OPC UA servers registry: https://github.com/node-opcua/node-opcua/wiki/publicly-available-OPC-UA-Servers-and-Clients
- MTConnect demo: https://demo.mtconnect.org/current · https://www.mtconnect.org/getting-started
- Microsoft OPC PLC: https://github.com/Azure-Samples/iot-edge-opc-plc
- Prosys Simulation Server: https://prosysopc.com/products/opc-ua-simulation-server/
- HiveMQ public broker: https://www.mqtt-dashboard.com/ · HiveMQ Edge: https://www.hivemq.com/products/hivemq-edge/
- EMQX public broker: https://www.emqx.com/en/mqtt/public-mqtt5-broker
- Litmus Developer Edition: https://litmus.io/blog/litmus-edge-developer-edition
- HighByte pricing: https://www.highbyte.com/pricing
- Velotic / Kepware: https://www.velotic.com/products/kepware/kepware-server/trial
- AWS SiteWise: https://docs.aws.amazon.com/iot-sitewise/latest/userguide/what-is-sitewise.html
- AWS IoT Analytics end of support: https://docs.aws.amazon.com/iotanalytics/latest/userguide/iotanalytics-end-of-support.html
- Azure IoT Operations OPC UA: https://learn.microsoft.com/en-us/azure/iot-operations/discover-manage-assets/overview-opc-ua-connector
- Fabric Real-Time Intelligence: https://learn.microsoft.com/en-us/fabric/real-time-intelligence/overview
- Google MDE: https://docs.cloud.google.com/manufacturing-data-engine/docs/overview
- NASA PCoE data: https://www.nasa.gov/intelligent-systems-division/discovery-and-systems-health/pcoe/pcoe-data-set-repository/
- Azure PdM dataset: https://www.kaggle.com/datasets/arnabbiswas1/microsoft-azure-predictive-maintenance
- Tennessee Eastman: https://dataverse.harvard.edu/dataset.xhtml?persistentId=doi:10.7910/DVN/6C3JR1
- MVTec AD 2: https://www.mvtec.com/research-teaching/datasets/mvtec-ad-2
- LMElive: https://www.lme.com/en/market-data/accessing-market-data/lmelive
- Metals-API: https://metals-api.com/pricing
- EIA API: https://www.eia.gov/opendata/documentation.php
- Freightos Terminal: https://www.freightos.com/enterprise/terminal/pricing/
- FRED API: https://fred.stlouisfed.org/docs/api/fred/v2/api_key.html
- MoSPI eSankhyiki: https://esankhyiki.mospi.gov.in/macroindicators?product=iip · MCP: https://github.com/nso-india/esankhyiki-mcp
- Open-Meteo: https://open-meteo.com/en/pricing
