import { decodeErrorResult, type Abi } from "viem";
import { ORDO_POLICIES_ABI, ORDO_WORK_ORDERS_ABI } from "./ordo-contracts-abi.js";
import { ORDO_TRUST_ABI } from "./ordo-trust-abi.js";

const ERRORS = [...ORDO_TRUST_ABI, ...ORDO_WORK_ORDERS_ABI, ...ORDO_POLICIES_ABI].filter((x) => x.type === "error") as Abi;
const args = (a: readonly unknown[] | undefined) => (a?.length ? `(${a.map(String).join(", ")})` : "");

/**
 * A readable reason for a failed contract call: the Ordo contract's custom error when the revert data is
 * anywhere in the error chain (RPCs nest it differently), otherwise the client's short message.
 */
export function chainErrorMessage(e: unknown): string {
  let cur = e as { data?: unknown; cause?: unknown } | undefined;
  for (let i = 0; i < 10 && cur; i++) {
    const d = cur.data as { errorName?: string; args?: readonly unknown[]; data?: unknown } | string | undefined;
    if (d && typeof d === "object" && d.errorName) return `${d.errorName}${args(d.args)}`;
    const raw = typeof d === "string" ? d : typeof d?.data === "string" ? d.data : null;
    if (raw && /^0x[0-9a-fA-F]{8}/.test(raw)) {
      try {
        const r = decodeErrorResult({ abi: ERRORS, data: raw as `0x${string}` });
        return `${r.errorName}${args(r.args as readonly unknown[] | undefined)}`;
      } catch {
        /* not one of ours: keep walking */
      }
    }
    cur = cur.cause as typeof cur;
  }
  return (e instanceof Error ? ((e as Error & { shortMessage?: string }).shortMessage ?? e.message) : String(e)).slice(0, 400);
}
