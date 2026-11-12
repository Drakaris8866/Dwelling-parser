import { z } from "zod";
import { personalRankingSettingsSchema, personalRankingSnapshotResponseSchema, type PersonalRankingSettings } from "../../src/contracts/personalRanking.js";
import type { PhotoDecision } from "../../src/contracts/photoRepair.js";
import { duplicateAuditPageSchema, duplicateSnapshot, type DuplicatePair } from "../../src/contracts/duplicateAudit.js";
import { catalogPageSchema, catalogDetailSchema, healthSchema, settingsSchema, savedSearchSchema, facetsSchema, mapResultSchema, type CatalogFilters, type CatalogSort, type CatalogSettings } from "../../src/contracts/catalog.js";

const request = async <T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> => {
  const response = await fetch(`/api${path}`, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  const data: unknown = await response.json();
  if (!response.ok) {
    const error = z.object({ message: z.string() }).safeParse(data);
    throw new Error(error.success ? error.data.message : `Ошибка сервера ${response.status}`);
  }
  return schema.parse(data);
};
const okSchema = z.object({ ok: z.boolean() });
export const api = {
  personalRanking: (id: string) => request(`/listings/${id}/personal-ranking`, personalRankingSnapshotResponseSchema),
  personalRankingSettings: () => request("/personal-ranking/settings", personalRankingSettingsSchema),
  updatePersonalRankingSettings: (value: PersonalRankingSettings) => request("/personal-ranking/settings", personalRankingSettingsSchema, { method: "PUT", body: JSON.stringify(value) }),
  duplicates: (page: number, address: string) => request(`/duplicates?${new URLSearchParams({ page: String(page), address })}`, duplicateAuditPageSchema),
  scanDuplicates: () => request("/duplicates/scan", okSchema, { method: "POST", body: "{}" }),
  confirmDuplicate: (pair: DuplicatePair) => request("/duplicates/confirm", okSchema, { method: "POST", body: JSON.stringify({ leftId: pair.left.listingId, rightId: pair.right.listingId, snapshot: duplicateSnapshot(pair) }) }),
  catalog: (filters: CatalogFilters, page: number, sort: CatalogSort) => request(`/listings?${new URLSearchParams({ filters: JSON.stringify(filters), page: String(page), sort })}`, catalogPageSchema),
  map: (filters: CatalogFilters, zoom: number) => request(`/map?${new URLSearchParams({ filters: JSON.stringify(filters), zoom: String(zoom) })}`, mapResultSchema),
  detail: (id: string) => request(`/listings/${id}`, catalogDetailSchema),
  requestRoute: (id: string) => request(`/listings/${id}/route`, okSchema, { method: "POST", body: "{}" }),
  analyzePhotos: (id: string) => request(`/listings/${id}/photo-repair`, okSchema, { method: "POST", body: "{}" }),
  reviewPhotos: (id: string, decision: PhotoDecision) => request(`/listings/${id}/photo-repair`, okSchema, { method: "PATCH", body: JSON.stringify(decision) }),
  renovationBudget: (id: string, budgetUsd: number | null) => request(`/listings/${id}/renovation-budget`, okSchema, { method: "PATCH", body: JSON.stringify({ budgetUsd }) }),
  state: (id: string, value: { favorite?: boolean; hidden?: boolean }) => request(`/listings/${id}/state`, okSchema, { method: "PATCH", body: JSON.stringify(value) }),
  health: () => request("/health", healthSchema), facets: () => request("/facets", facetsSchema),
  settings: () => request("/settings", settingsSchema),
  updateSettings: (value: CatalogSettings) => request("/settings", settingsSchema, { method: "PUT", body: JSON.stringify(value) }),
  searches: () => request("/searches", z.array(savedSearchSchema)),
  saveSearch: (name: string, filters: CatalogFilters, notifications: boolean) => request("/searches", savedSearchSchema, { method: "POST", body: JSON.stringify({ name, filters, notifications }) }),
  updateSearch: (id: string, value: { notifications?: boolean; name?: string; filters?: CatalogFilters }) => request(`/searches/${id}`, okSchema, { method: "PATCH", body: JSON.stringify(value) }),
  deleteSearch: (id: string) => request(`/searches/${id}`, okSchema, { method: "DELETE" }),
  sync: () => request("/sync", okSchema, { method: "POST", body: "{}" })
};
