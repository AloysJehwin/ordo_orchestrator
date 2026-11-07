import { fmt, targetText } from "./metric.js";
import type { CaptureSpec } from "./media/capture.js";

/** One answer from the 0G Router, with the receipts it came with. */
export interface BrainReply {
  text: string;
  json: Record<string, unknown> | null;
  requestId: string | null;
  provider: string | null;
  teeVerified: boolean | null;
  model: string;
  ms: number;
}
export interface Perception {
  value: number | null;
  summary: string;
  anomaly: string | null;
  reply: BrainReply;
}
export type Action = "continue" | "adjust" | "hold";
export interface Decision {
  action: Action;
  reason: string;
  /** an outcome to capture again after adjusting */
  recapture: string | null;
  /** the process signal to bring back toward its nominal value */
  signal: string | null;
  reply: BrainReply;
}
/** What the body tells its agent before it decides. */
export interface Situation {
  kind: string;
  runId: string;
  stage: string;
  stageName: string;
  progress: number;
  units: { made: number; of: number };
  signals: { name: string; value: number; unit: string; warn?: number; alarm?: number }[];
  captures: { outcome: string; label: string; value: number; target: string; inSpec: boolean; attempt: number; agentRead: number | null; anomaly: string | null }[];
  pending: string[];
}

export class BrainError extends Error {}

const THINK = /<think>[\s\S]*?<\/think>/g;

/** The first JSON object in a model's answer, if it wrote one. */
export function jsonIn(text: string): Record<string, unknown> | null {
  const t = text.replace(THINK, "").replace(/```(?:json)?/g, "");
  for (let i = t.indexOf("{"); i >= 0; i = t.indexOf("{", i + 1)) {
    let depth = 0;
    let inStr = false;
    for (let j = i; j < t.length; j++) {
      const ch = t[j]!;
      if (inStr) {
        if (ch === "\\") j++;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        try {
          const v = JSON.parse(t.slice(i, j + 1)) as unknown;
          if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
        } catch {
          // not JSON: try the next brace
        }
        break;
      }
    }
  }
  return null;
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

/**
 * The machine's on-board agent: it reads what the machine captured and decides what the machine does next, through the
 * 0G Router in Ordo's trust mode: private (TEE providers only, `verify_tee`) unless Ordo runs on standard routing, which
 * has no TEE and says so. Every answer's request ID goes in the episode log.
 * Ordo mints the key for each start and revokes it on stop.
 */
export class Brain {
  constructor(
    private o: { url: string; key: string; model: string; trustMode?: string; timeoutMs?: number; fetch?: typeof fetch },
  ) {}
  get model() {
    return this.o.model;
  }
  get trustMode() {
    return this.o.trustMode ?? "private";
  }

  /** the Router refused `chat_template_kwargs` once: send requests without it from then on */
  private plain = false;

  /**
   * One chat completion. The agent's tasks are short JSON answers, so thinking is turned off
   * (`chat_template_kwargs.enable_thinking: false`): 0G's private-mode model `0gm-1.0-35b-a3b` reasons by default and
   * spends a small token budget on its reasoning, answering with no content at all. A model that reasons anyway, and
   * runs out of room, is asked once more with four times the budget.
   */
  async chat(messages: unknown[], maxTokens: number, timeoutMs = this.o.timeoutMs ?? 60_000): Promise<BrainReply> {
    const first = await this.once(messages, maxTokens, timeoutMs);
    if (first.kind === "reply") return first.reply;
    if (first.thought) {
      const again = await this.once(messages, Math.min(maxTokens * 4, 4000), timeoutMs);
      if (again.kind === "reply") return again.reply;
      throw new BrainError(`0G Router answered without content: ${this.o.model} spent its whole ${Math.min(maxTokens * 4, 4000)}-token budget reasoning`);
    }
    throw new BrainError(`0G Router answered without content${first.finish ? ` (finish: ${first.finish})` : ""}`);
  }

  private async once(messages: unknown[], maxTokens: number, timeoutMs: number): Promise<{ kind: "reply"; reply: BrainReply } | { kind: "empty"; thought: boolean; finish: string | null }> {
    const t0 = Date.now();
    let res: Response;
    const send = () =>
      (this.o.fetch ?? fetch)(`${this.o.url.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.o.key}`, "content-type": "application/json", accept: "application/json", "x-0g-provider-trust-mode": this.trustMode },
        body: JSON.stringify({
          model: this.o.model,
          messages,
          max_tokens: maxTokens,
          temperature: 0.2,
          stream: false,
          ...(this.plain ? {} : { chat_template_kwargs: { enable_thinking: false } }),
          ...(this.trustMode === "private" ? { verify_tee: true } : {}),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    try {
      res = await send();
      // a provider that does not take chat_template_kwargs: drop it and ask again
      if (res.status === 400 && !this.plain) {
        const text = await res.clone().text();
        if (/chat_template_kwargs|enable_thinking|unrecognized|unknown (field|param)/i.test(text)) {
          this.plain = true;
          res = await send();
        }
      }
    } catch (e) {
      throw new BrainError(`0G Router unreachable: ${(e as Error).name === "TimeoutError" ? "timed out" : (e as Error).message}`);
    }
    const raw = await res.text();
    let body: {
      choices?: { message?: { content?: unknown; reasoning_content?: unknown }; finish_reason?: string }[];
      x_0g_trace?: { request_id?: string; provider?: string; tee_verified?: boolean };
      error?: { message?: string } | string;
      model?: string;
    } = {};
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      // not JSON: reported below
    }
    if (!res.ok) {
      const msg = typeof body.error === "string" ? body.error : body.error?.message;
      throw new BrainError(`0G Router answered ${res.status}${msg ? `: ${msg.slice(0, 200)}` : ""}`);
    }
    const choice = body.choices?.[0];
    const content = choice?.message?.content;
    const text = (typeof content === "string" ? content : Array.isArray(content) ? content.map((p: { text?: string }) => p.text ?? "").join("") : "").replace(THINK, "").trim();
    if (!text) return { kind: "empty", thought: typeof choice?.message?.reasoning_content === "string" && choice.message.reasoning_content.length > 0 && choice.finish_reason === "length", finish: choice?.finish_reason ?? null };
    const trace = body.x_0g_trace ?? {};
    const reply: BrainReply = {
      text,
      json: jsonIn(text),
      requestId: trace.request_id ?? res.headers.get("x-request-id") ?? res.headers.get("zg-res-key") ?? null,
      provider: trace.provider ?? res.headers.get("x-provider") ?? null,
      teeVerified: typeof trace.tee_verified === "boolean" ? trace.tee_verified : null,
      model: body.model ?? this.o.model,
      ms: Date.now() - t0,
    };
    return { kind: "reply", reply };
  }

  /** Read one capture: the image (or its spectrogram, keyframe, chart or page), against what the outcome measures. */
  async perceive(c: CaptureSpec, image: Uint8Array): Promise<Perception> {
    const m = c.outcome.metric;
    const prompt = [
      `You are the on-board agent of a ${c.kind.replace("_", " ")} in a factory pipeline (run ${c.runId}, stage ${c.stage} ${c.stageName}).`,
      `Its instrument "${c.outcome.instrument}" captured "${c.outcome.label}" (${c.outcome.media}). The image is ${c.outcome.media === "audio" ? "the recording's spectrogram" : c.outcome.media === "video" ? "the recording's last frame" : c.outcome.media === "spectrum" ? "the spectrum chart" : c.outcome.media === "document" ? "the report's page" : "the capture"}.`,
      `It measures ${m.label} in ${m.unit || "units"}; the target is ${targetText(m)}.`,
      `Read the ${m.label} from the image, say in one or two sentences what you see, and name anything anomalous (out of target, an artefact, a reading that does not match the image).`,
      `Answer with only JSON: {"value": number or null, "summary": string, "anomaly": string or null}.`,
    ].join("\n");
    const reply = await this.chat(
      [
        { role: "system", content: "You read industrial instrument captures precisely and answer only with the JSON asked for." },
        { role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: `data:image/png;base64,${Buffer.from(image).toString("base64")}` } }] },
      ],
      400,
    );
    const j = reply.json ?? {};
    const value = num(j.value);
    let anomaly = str(j.anomaly, 500) || null;
    if (anomaly && /^(none|null|no anomal)/i.test(anomaly)) anomaly = null;
    const summary = str(j.summary, 1800) || reply.text.slice(0, 600);
    // the agent's reading and the instrument's disagree: that is worth a note, the instrument's value stands
    const tol = Math.max(Math.abs(c.value) * 0.05, 10 ** -6);
    if (value !== null && Math.abs(value - c.value) > tol && !anomaly) anomaly = `The agent read ${value} from the image; the instrument reported ${fmt(c.value, m)}.`;
    return { value, summary, anomaly, reply };
  }

  /** What the machine does next: carry on, adjust its process (and capture an outcome again), or hold the stage for a person. */
  async decide(s: Situation): Promise<Decision> {
    const prompt = [
      `You run a ${s.kind.replace("_", " ")} in a factory pipeline. Run ${s.runId}, stage ${s.stage} ${s.stageName}: ${Math.round(s.progress * 100)}% through, ${s.units.made} of ${s.units.of} units.`,
      `Process signals now: ${s.signals.map((x) => `${x.name} ${x.value} ${x.unit}${x.warn !== undefined ? ` (warn ${x.warn}${x.alarm !== undefined ? `, alarm ${x.alarm}` : ""})` : ""}`).join("; ") || "none"}.`,
      `Captures so far: ${s.captures.map((c) => `${c.label} = ${c.value} (target ${c.target}, ${c.inSpec ? "in spec" : "OUT OF SPEC"}, attempt ${c.attempt}${c.anomaly ? `, note: ${c.anomaly}` : ""})`).join("; ") || "none"}.`,
      `Still to capture: ${s.pending.join(", ") || "nothing"}.`,
      `Decide: "continue"; "adjust" to bring a drifting signal back to nominal (name it) and optionally capture an out-of-spec outcome again (its key); or "hold" to stop the stage for a person when something is wrong that adjusting cannot fix.`,
      `Answer with only JSON: {"action": "continue" | "adjust" | "hold", "reason": string, "signal": string or null, "recapture": outcome key or null}.`,
    ].join("\n");
    const reply = await this.chat(
      [
        { role: "system", content: "You are a careful machine controller. Prefer continuing; adjust when a signal drifts or a capture is out of spec; hold only for a real fault. Answer only with the JSON asked for." },
        { role: "user", content: prompt },
      ],
      300,
      30_000,
    );
    const j = reply.json ?? {};
    const a = str(j.action, 20).toLowerCase();
    const action: Action = a === "adjust" || a === "hold" ? a : "continue";
    return { action, reason: str(j.reason, 400) || reply.text.slice(0, 300), recapture: str(j.recapture, 40) || null, signal: str(j.signal, 40) || null, reply };
  }

  /** Answer a question about the machine's work from its episode log. */
  async answer(question: string, context: string): Promise<BrainReply> {
    return this.chat(
      [
        { role: "system", content: "You are the on-board agent of a virtual machine. Answer questions about its work from its episode log only; cite the 0G request IDs of the perceptions and decisions you rely on. If the log does not say, say so." },
        { role: "user", content: `Episode log (JSON lines, newest last):\n${context}\n\nQuestion: ${question}` },
      ],
      600,
      90_000,
    );
  }

  /** A small request to see whether the Router answers again after a safe stop. */
  async probe(): Promise<BrainReply> {
    return this.chat([{ role: "user", content: 'Reply with {"ok": true}' }], 20, 20_000);
  }
}
