// Shared JSDoc types. This module has no runtime code; import types with `@import`.

/**
 * @typedef {object} Criterion
 * @property {string} label
 * @property {string} kind
 * @property {unknown} target
 * @property {string} [unit]
 * @property {string} [signal]
 */

/**
 * @typedef {object} Parameter
 * @property {string} signal
 * @property {string} [unit]
 */

/**
 * @typedef {object} Stage
 * @property {string} runId
 * @property {string} [orderRef]
 * @property {string} [templateName]
 * @property {string} [code]
 * @property {string} name
 * @property {string} [state]
 * @property {Criterion[]} criteria
 * @property {Parameter[]} parameters
 */

/**
 * @typedef {object} RouterConfig
 * @property {string} baseUrl
 * @property {string} apiKey
 * @property {string} model
 * @property {string} [trustMode]
 * @property {"mainnet" | "testnet" | "mock"} [network] "mock": the Ordo deployment has no Router key
 */

/**
 * @typedef {object} Session
 * @property {string} sessionId
 * @property {string} expiresAt
 * @property {{ id: string, name: string }} org
 * @property {{ address: string, name: string | null }} contributor
 * @property {Stage} stage
 * @property {string} guide
 * @property {RouterConfig} router
 */

/**
 * @typedef {"open" | "submitted" | "signed" | "expired"} SessionState
 */

/**
 * @typedef {object} SessionStatus
 * @property {SessionState} status
 * @property {string | null} contributionId
 * @property {string | null} signUrl
 * @property {string | null} proofUrl
 */

/**
 * @typedef {object} Measurement
 * @property {string} criterion
 * @property {number} value
 * @property {string} [unit]
 * @property {string} [note]
 */

/**
 * @typedef {object} Note
 * @property {string} text
 * @property {string} at
 */

/**
 * @typedef {object} Evidence
 * @property {string} name
 * @property {string} sha256
 * @property {number} size
 */

/**
 * @typedef {object} TranscriptEntry
 * @property {"assistant" | "user"} role
 * @property {string} content
 * @property {string} at
 */

/**
 * One per Router response.
 * @typedef {object} Receipt
 * @property {string | null} resKey            ZG-Res-Key response header (the provider's chat id), else the body's id.
 * @property {string | null} requestId         x_0g_trace.request_id, else the X-Request-ID header.
 * @property {string | null} provider          x_0g_trace.provider (provider address), else the X-Provider header.
 * @property {string | null} providerIdentity  x_0g_trace.provider_identity, when the provider reports one.
 * @property {boolean | null} teeVerified      x_0g_trace.tee_verified: the Router's own check of the TEE signature; null when absent.
 * @property {string} model
 * @property {string} at
 * @property {string} requestSha256
 * @property {string} responseSha256
 * @property {Record<string, string>} headers
 * @property {unknown} [trace]
 */

/**
 * @typedef {object} FinishPayload
 * @property {string} summary
 * @property {Measurement[]} measurements
 * @property {Note[]} notes
 * @property {Evidence[]} evidence
 * @property {TranscriptEntry[]} transcript
 * @property {Receipt[]} receipts
 */

/**
 * @typedef {object} FinishResult
 * @property {string} contributionId
 * @property {string} signUrl
 */

/**
 * An OpenAI-compatible tool call.
 * @typedef {object} ToolCall
 * @property {string} id
 * @property {"function"} [type]
 * @property {{ name: string, arguments: string }} function
 */

/**
 * An OpenAI-compatible chat message, as sent to the Router.
 * @typedef {object} ChatMessage
 * @property {"system" | "user" | "assistant" | "tool"} role
 * @property {string | null} [content]
 * @property {ToolCall[]} [tool_calls]
 * @property {string} [tool_call_id]
 */

export {};
