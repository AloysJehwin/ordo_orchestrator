import { useEffect, useState } from "react";

export interface Route {
  page: string;
  id: string | null;
  sub: string | null;
  query: URLSearchParams;
}
const parse = (): Route => {
  const h = window.location.hash.replace(/^#\/?/, "");
  const [path, qs] = h.split("?");
  const [page, id, sub] = (path ?? "").split("/").map(decodeURIComponent);
  return { page: page || "pipelines", id: id || null, sub: sub || null, query: new URLSearchParams(qs ?? "") };
};
export function useRoute(): Route {
  const [r, setR] = useState(parse);
  useEffect(() => {
    const f = () => setR(parse());
    window.addEventListener("hashchange", f);
    return () => window.removeEventListener("hashchange", f);
  }, []);
  return r;
}
export const go = (path: string) => {
  window.location.hash = `#/${path.replace(/^\/?#?\/?/, "")}`;
};
export const href = (path: string) => `#/${path.replace(/^\//, "")}`;
