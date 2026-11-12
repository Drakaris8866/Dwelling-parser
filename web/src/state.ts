import { useEffect, useState } from "react";
import { filtersSchema, sortSchema, type CatalogFilters, type CatalogSort } from "../../src/contracts/catalog.js";

const initialState = (): { filters: CatalogFilters; sort: CatalogSort; page: number; view: "list" | "map"; item: string | null } => {
  const params = new URLSearchParams(location.search);
  let filters: CatalogFilters = {};
  try { filters = filtersSchema.parse(JSON.parse(params.get("filters") ?? "{}") as unknown); } catch { /* Invalid shared URLs fall back to an unfiltered catalog. */ }
  const sort = sortSchema.safeParse(params.get("sort") ?? "newest");
  return { filters, sort: sort.success ? sort.data : "newest", page: Math.max(1, Number(params.get("page")) || 1), view: params.get("view") === "map" ? "map" : "list", item: params.get("item") };
};
export const useCatalogState = () => {
  const [state, setState] = useState(initialState);
  useEffect(() => { const handler = (): void => setState(initialState()); window.addEventListener("popstate", handler); return () => window.removeEventListener("popstate", handler); }, []);
  useEffect(() => { const params = new URLSearchParams({ filters: JSON.stringify(state.filters), sort: state.sort, page: String(state.page), view: state.view }); if (state.item) params.set("item", state.item); history.replaceState(null, "", `${location.pathname}?${params}`); }, [state]);
  const setFilters = (filters: CatalogFilters): void => setState((s) => ({ ...s, filters, page: 1 }));
  return { ...state, setFilters, setSort: (sort: CatalogSort) => setState((s) => ({ ...s, sort, page: 1 })), setPage: (page: number) => setState((s) => ({ ...s, page })), setView: (view: "list" | "map") => setState((s) => ({ ...s, view })), openItem: (item: string | null) => setState((s) => ({ ...s, item })) };
};
