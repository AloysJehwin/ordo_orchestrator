// A local stand-in for the Ordo proof-of-work API.
import http from "node:http";

/**
 * @typedef {object} FakeOrdoState
 * @property {"open" | "submitted" | "signed" | "expired"} status
 * @property {string | null} contributionId
 * @property {any[]} finishBodies
 * @property {{ method: string, path: string, headers: http.IncomingHttpHeaders, body: string }[]} requests
 * @property {number} pollsAfterSubmit
 * @property {number | null} goneStatus  When set, every authorized request answers with this status.
 */

/**
 * @param {{ secret: string, session: any, initialStatus?: FakeOrdoState["status"], submittedPolls?: number, goneStatus?: number }} options
 */
export async function startFakeOrdo({ secret, session, initialStatus = "open", submittedPolls = 2, goneStatus }) {
  /** @type {FakeOrdoState} */
  const state = {
    status: initialStatus,
    contributionId: initialStatus === "open" ? null : "c_existing",
    finishBodies: [],
    requests: [],
    pollsAfterSubmit: 0,
    goneStatus: goneStatus ?? null,
  };
  let base = "";

  const statusBody = () => ({
    status: state.status,
    contributionId: state.contributionId,
    signUrl: state.contributionId ? `${base}/#/pow/sign/${state.contributionId}` : null,
    proofUrl: state.status === "signed" ? `${base}/#/proof/contribution/${state.contributionId}` : null,
  });

  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const path = new URL(req.url ?? "/", "http://local").pathname;
    state.requests.push({ method: req.method ?? "", path, headers: req.headers, body });
    /** @param {number} status @param {unknown} data */
    const send = (status, data) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    if (req.headers.authorization !== `Bearer ${secret}`) return send(401, { error: "unauthorized" });
    if (state.goneStatus) return send(state.goneStatus, { error: "session expired" });

    if (req.method === "GET" && path === "/v1/pow/session") return send(200, session);
    if (req.method === "POST" && path === "/v1/pow/session/finish") {
      if (state.status !== "open") return send(409, { error: "already submitted" });
      state.finishBodies.push(JSON.parse(body));
      state.status = "submitted";
      state.contributionId = "c_1";
      return send(200, { contributionId: state.contributionId, signUrl: statusBody().signUrl });
    }
    if (req.method === "GET" && path === "/v1/pow/session/status") {
      if (state.status === "submitted") {
        state.pollsAfterSubmit += 1;
        if (state.pollsAfterSubmit > submittedPolls) state.status = "signed";
      }
      return send(200, statusBody());
    }
    return send(404, { error: "not found" });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = /** @type {import("node:net").AddressInfo} */ (server.address());
  base = `http://127.0.0.1:${address.port}`;
  return {
    url: base,
    state,
    close: () => new Promise((resolve) => server.close(() => resolve(undefined))),
  };
}
