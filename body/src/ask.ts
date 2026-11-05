import { timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { BodyAnswer } from "../../server/src/core/bodies.js";
import { BrainError } from "./brain.js";
import type { Entry } from "./episode.js";
import type { Body } from "./loop.js";

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** What the log says, plainly, for a body without a brain: its captures, decisions and holds. */
function plainAnswer(body: Body, question: string): string {
  const entries = body.log.entries;
  const q = question.toLowerCase();
  const captures = entries.filter((e): e is Extract<Entry, { kind: "capture" }> => e.kind === "capture");
  const holds = entries.filter((e) => e.kind === "hold");
  const stages = entries.filter((e): e is Extract<Entry, { kind: "stage" }> => e.kind === "stage" && e.event === "started");
  const about = captures.filter((c) => q.includes(c.outcome.key) || q.includes(c.outcome.label.toLowerCase()));
  const shown = (about.length ? about : captures).slice(-8);
  const lines = [
    `This machine runs without a 0G brain, so this answer is read straight from its episode log, not reasoned by an agent.`,
    `It has worked ${stages.length} stage(s) since it started and captured ${captures.length} output(s); ${holds.length} hold(s).`,
  ];
  const buys = entries.filter((e): e is Extract<Entry, { kind: "purchase" }> => e.kind === "purchase");
  const bought = buys.filter((b) => b.event === "bought");
  const asked = buys.filter((b) => b.event === "over_budget");
  if (buys.length)
    lines.push(
      `It bought ${bought.length} resource(s) ahead over x402${bought.length ? ` (latest: ${bought.slice(-4).map((b) => `${b.qty ?? "?"} of ${b.resource} for ${b.forStage}, tx ${b.txId ?? "pending"}`).join("; ")})` : ""}, and asked the treasury for ${asked.length} top-up(s)${asked.length ? ` (latest: ${asked.slice(-3).map((a) => `${a.resource} for ${a.forStage}, ${a.reason}: ${a.topUp ? `${a.topUp.status} ${a.topUp.id}` : `refused: ${a.error ?? ""}`}`).join("; ")})` : ""}.`,
    );
  if (shown.length) lines.push(`${about.length ? "Captures of what you asked about" : "Latest captures"}: ${shown.map((c) => `${c.runId}/${c.stage} ${c.outcome.label} attempt ${c.attempt} = ${c.value}${c.outcome.metric.unit ? ` ${c.outcome.metric.unit}` : ""}${c.uploaded ? "" : c.skipped ? ` (skipped: ${c.skipped})` : " (not uploaded)"} at ${new Date(c.capturedAt * 1000).toISOString()}`).join("; ")}.`);
  return lines.join(" ");
}

/**
 * The body answers questions about its work on `GET /ask?q=`: from its episode log through its 0G agent (with the
 * request ID), or plainly from the log without one. Ordo sends the bearer token it started the body with.
 */
export function askServer(body: Body, o: { port: number; host: string; token: string | null }): Server {
  const server = createServer((req, res) => {
    const send = (code: number, json: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    };
    const url = new URL(req.url ?? "/", "http://body");
    if (url.pathname === "/health") return send(200, { ok: true, state: body.state, brain: body.cfg.brain ? "0g" : "none", asset: body.cfg.asset });
    if (url.pathname !== "/ask" || req.method !== "GET") return send(404, { error: "Not found" });
    const auth = req.headers.authorization ?? "";
    if (o.token && !same(auth, `Bearer ${o.token}`)) return send(401, { error: "Ordo asks with the body's token" });
    const q = (url.searchParams.get("q") ?? "").trim().slice(0, 1000);
    if (!q) return send(400, { error: "Ask with ?q=" });
    void (async () => {
      const brain = body.cfg.brain;
      if (!brain) return send(200, { answer: plainAnswer(body, q), requestId: null, model: null } satisfies BodyAnswer);
      try {
        const r = await brain.answer(q, body.log.tail());
        body.log.add({ kind: "note", text: `Answered a question through 0G (request ${r.requestId ?? "without an ID"}): ${q.slice(0, 200)}` });
        send(200, { answer: r.text, requestId: r.requestId, model: r.model } satisfies BodyAnswer);
      } catch (e) {
        // never made up: say the agent could not answer, and give what the log says
        send(e instanceof BrainError ? 503 : 500, { error: `The machine's agent could not answer: ${(e as Error).message}`, fallback: plainAnswer(body, q) });
      }
    })();
  });
  server.listen(o.port, o.host);
  return server;
}
