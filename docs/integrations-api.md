# Integrations & API

## Enterprise and shop-floor systems

| System | Direction | Data |
| --- | --- | --- |
| ERP | In / out | Orders, BOMs, inventory, costs; confirmations back |
| MES | In / out | Work orders, routings, counts, genealogy |
| QMS | Out | Deviations, CAPA triggers, approved validation records |
| CMMS | In / out | Maintenance work orders, spares |
| WMS | In / out | Stock locations, picks, kit status |
| PLM | In | Drawings, revisions, engineering change requests |
| Identity provider | In | SSO (SAML / OIDC), groups mapped to roles |
| Shop floor | In / out | OPC UA, MQTT / Sparkplug B, Modbus TCP, MTConnect |

For real providers, demo endpoints and datasets that can feed these interfaces, see [data-sources.md](data-sources.md).

## Representative endpoints

The API gateway exposes REST and GraphQL, an event stream and webhooks.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/v1/runs/{runId}` | Run, stages, live metrics |
| POST | `/v1/runs` | Start a run from a template version |
| POST | `/v1/runs/{runId}/stages/{id}/approve` | Release a gate |
| POST | `/v1/runs/{runId}/stages/{id}/hold` | Hold a gate |
| GET | `/v1/templates` | List templates |
| POST | `/v1/templates/{id}/versions` | Publish a builder draft |
| POST | `/v1/validations` | Create a package |
| POST | `/v1/validations/{id}/precheck` | Run agent pre-check |
| POST | `/v1/validations/{id}/evidence` | Attach a file (multipart) |
| POST | `/v1/validations/{id}/signatures` | Sign / request changes / reject |
| GET | `/v1/audit?entity={type}:{id}` | Audit entries |

## Events

Delivered on the event stream and as webhooks:

| Event | When |
| --- | --- |
| `run.started` | A run starts from a template version |
| `stage.state_changed` | A stage moves between node states |
| `agent.decision` | An agent action is recorded |
| `gate.awaiting` | A stage reaches a gate that needs a person |
| `alert.raised` | An alert or exception is raised |
| `validation.submitted` | A package is signed "Performed by" and submitted |
| `validation.signed` | A reviewer or approver signs |
| `validation.released` | The package outcome is applied |
