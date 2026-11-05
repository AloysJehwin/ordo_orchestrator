import { api } from "../api";
import type { InboxItemView, TypedSignature } from "../types";
import { useApp } from "./app";
import { useSign } from "./sign";

/** Decide an inbox item (approve an option, or reject with -1). Always wallet-signed. */
export function useDecide() {
  const sign = useSign();
  const { path, refresh } = useApp();
  return async (item: InboxItemView, option: number, comment = "") => {
    const label = option === -1 ? "Reject & hold" : item.options[option]?.label ?? "Decide";
    const r = await sign({
      title: label,
      request: (chainId) => api.post<TypedSignature>(path(`/inbox/${item.id}/sign-request`), { option, comment, chainId }),
      submit: (proof) => api.post<InboxItemView>(path(`/inbox/${item.id}/decide`), { option, comment, ...proof }),
      done: `${label}: signed and recorded`,
    });
    await refresh();
    return r;
  };
}
