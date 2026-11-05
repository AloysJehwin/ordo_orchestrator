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
 * What the stage's machine read from one outcome's media through 0G (its on-board agent).
 * @typedef {object} MachineReading
 * @property {string} summary
 * @property {number} [value]
 * @property {string} [anomaly]
 * @property {string} [requestId]
 * @property {string} [model]
 * @property {string} [provider]
 * @property {boolean | null} [teeVerified]
 */

/**
 * The newest file the machine captured for an outcome.
 * @typedef {object} OutcomeOutput
 * @property {number} version
 * @property {number} versions
 * @property {string} mime
 * @property {number} size
 * @property {string} sha256      "sha256:<hex>"
 * @property {boolean} hasPreview  A keyframe (video), spectrogram (audio) or chart image.
 * @property {number} value        The value the machine read, in the metric's unit.
 * @property {string} device       The machine's signing address.
 * @property {MachineReading | null} analysis
 */

/**
 * One outcome of the stage: media its machine captures, with the number read from it.
 * @typedef {object} Outcome
 * @property {string} key
 * @property {string} label
 * @property {"thermal" | "image" | "audio" | "video" | "spectrum" | "document"} media
 * @property {string} [mediaLabel]
 * @property {string} instrument
 * @property {boolean} required
 * @property {{ label: string, unit: string, op: string, target: number, targetMax?: number }} metric
 * @property {boolean | null} ok        The metric against its target; null until measured.
 * @property {boolean} captured
 * @property {string | null} capturedAt
 * @property {OutcomeOutput | null} output
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
 * @property {Outcome[]} [outcomes]
 * @property {{ id: string, name: string | null, answers: boolean } | null} [machine]  The machine running the stage; answers: Ordo can relay questions to it.
 */

/**
 * @typedef {object} RouterConfig
 * @property {string} baseUrl
 * @property {string} apiKey
 * @property {string} model
 * @property {string | null} [audioModel]  Speech to text for voice notes (whisper-large-v3), when the session's key allows it.
 * @property {string} [trustMode]  private (TEE providers only), verified or standard (no TEE)
 * @property {"transcriptions" | "chat"} [audioVia]  how voice notes become text: whisper's endpoint or an omni chat model
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
 * @property {string} [mediaType]  Detected from the file's first bytes, else its extension.
 * @property {{ model: string, requestId: string | null, kind: "vision" | "transcription" }} [analyzedBy]  Set when the contributor let a 0G model read the file.
 */

/**
 * The contributor's verdict on what the machine captured for one outcome.
 * @typedef {object} Confirmation
 * @property {string} outcome
 * @property {string | null} sha256    The file they reviewed; null when nothing was captured.
 * @property {"confirm" | "dispute" | "unsure"} verdict
 * @property {number} [observed]       The value they observed for the metric.
 * @property {string} note
 */

/**
 * A voice note transcribed through 0G.
 * @typedef {object} VoiceNote
 * @property {string} name
 * @property {string} sha256
 * @property {number} size
 * @property {string} mediaType
 * @property {string} transcript
 * @property {string} model
 * @property {string | null} requestId
 * @property {string} at
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
 * @property {"transcription"} [kind]     Set on a voice note's speech-to-text call; chat turns have none.
 */

/**
 * @typedef {object} FinishPayload
 * @property {string} summary
 * @property {Measurement[]} measurements
 * @property {Note[]} notes
 * @property {Evidence[]} evidence
 * @property {Confirmation[]} confirmations
 * @property {VoiceNote[]} voiceNotes
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
 * A part of a multimodal message: text, or an image as a data URL.
 * @typedef {{ type: "text", text: string } | { type: "image_url", image_url: { url: string, detail?: "auto" | "low" | "high" } }} ContentPart
 */

/**
 * An OpenAI-compatible chat message, as sent to the Router. A user message may carry content parts (images).
 * @typedef {object} ChatMessage
 * @property {"system" | "user" | "assistant" | "tool"} role
 * @property {string | ContentPart[] | null} [content]
 * @property {ToolCall[]} [tool_calls]
 * @property {string} [tool_call_id]
 */

export {};
