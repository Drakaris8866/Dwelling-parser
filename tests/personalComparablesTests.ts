import assert from "node:assert/strict";
import type { ListingFeatures } from "../src/contracts/catalog.js";
import { selectComparableGroup, type ComparableCandidate, type ComparableSubject } from "../src/domain/personalComparables.js";

const now = new Date("2026-01-31T12:00:00.000Z");
const day = 24 * 60 * 60 * 1000;
const features: ListingFeatures = {
  locality: "\u041c\u0438\u043d\u0441\u043a", marketZone: "minsk", isStudio: false, totalFloors: 5,
  buildingYear: 1980, buildingMaterial: "brick", layout: "isolated", repair: "needs-repair",
  readiness: "unfinished", provenance: {}
};
const subject: ComparableSubject = { propertyId: "subject", rooms: 2, areaSqm: 50, features };

function candidate(id: string, changes: Partial<ComparableCandidate> = {}): ComparableCandidate {
  return {
    propertyId: id, externalId: id, platform: "KUFAR", address: null, priceUsd: 100_000,
    priceSqm: 2_000, areaSqm: 50, distanceMeters: 100, rooms: 2, features,
    isActive: true, disposition: "ACCEPTED", lastSeenAt: now, ...changes
  };
}

function select(candidates: readonly ComparableCandidate[], mode: "as-is" | "ready" = "as-is", target = subject): ReturnType<typeof selectComparableGroup> {
  return selectComparableGroup(target, candidates, mode, now);
}

function publicationIds(result: ReturnType<typeof selectComparableGroup>): string[] {
  return result.comparables.map(({ externalId }) => externalId).sort();
}

export function assertPersonalComparables(): void {
  assert.equal(selectComparableGroup(subject, Array.from({ length: 3 }, (_, i) => candidate(String(i), { features: { ...features, repair: "good", readiness: "ready" } })), "ready", now, 3).status, "ready", "Configured threshold applies during radius selection");
  const latest = candidate("a", { lastSeenAt: new Date(now.getTime() - day) });
  const four = [latest, candidate("b"), candidate("c"), candidate("d")];
  const older = candidate("a", { externalId: "a-old", lastSeenAt: new Date(now.getTime() - 2 * day) });
  const newerIneligible = candidate("a", { externalId: "a-ineligible", priceIsDisputed: true });
  const ownPublication = candidate(subject.propertyId, { externalId: "other-platform-subject", platform: "REALT" });
  const insufficient = select([older, ownPublication, ...four, newerIneligible]);
  assert.equal(insufficient.status, "insufficient", "five publications do not make five distinct peers");
  assert.deepEqual(publicationIds(insufficient), ["a", "b", "c", "d"], "retain the newest qualifying publication and exclude the subject");

  const tied = candidate("a", { externalId: "a-tied", platform: "ONLINER", lastSeenAt: latest.lastSeenAt });
  assert.deepEqual(publicationIds(select([latest, tied])), publicationIds(select([tied, latest])), "publication ties are independent of input order");

  for (const radius of [500, 1000, 2000]) {
    const fifth = candidate("e", { distanceMeters: radius });
    const farther = candidate("farther", { distanceMeters: radius + 1 });
    const group = select([farther, ...four, fifth]);
    assert.equal(group.status, "ready", `five distinct peers qualify at ${radius} m`);
    assert.equal(group.radiusMeters, radius, "use the first qualifying radius, including its boundary");
    assert.deepEqual(publicationIds(group), ["a", "b", "c", "d", "e"], "exclude evidence outside the selected radius");
  }
  const outside = select([candidate("outside", { distanceMeters: 2001 })]);
  assert.equal(outside.status, "insufficient");
  assert.equal(outside.radiusMeters, null, "empty evidence has no radius");
  assert.deepEqual(outside.comparables, []);

  const atCutoff = now.getTime() - 30 * day;
  const recent = select([
    candidate("at-cutoff", { lastSeenAt: new Date(atCutoff) }),
    candidate("stale", { lastSeenAt: new Date(atCutoff - 1) }),
    candidate("future", { lastSeenAt: new Date(now.getTime() + 1) })
  ]);
  assert.deepEqual(publicationIds(recent), ["at-cutoff"], "accept exactly 30 days old, but not stale or future publications");

  const sokol = { ...features, marketZone: "minsk:sokol" };
  const geography = select([
    candidate("normalized-locality", { features: { ...sokol, locality: "  \u043c\u0438\u043d\u0441\u043a  " } }),
    candidate("shabany", { features: { ...sokol, marketZone: "minsk:shabany" } }),
    candidate("ordinary-minsk", { features }),
    candidate("different-locality", { features: { ...sokol, locality: "\u041a\u043e\u043b\u043e\u0434\u0438\u0449\u0438" } })
  ], "as-is", { ...subject, features: sokol });
  assert.deepEqual(publicationIds(geography), ["normalized-locality"], "require both normalized locality and the same exact market zone");

  const buildingClass = select([
    candidate("same-class", { features: { ...features, totalFloors: 6 } }),
    candidate("nine-floors", { features: { ...features, totalFloors: 9 } }),
    candidate("unknown-floors", { features: { ...features, totalFloors: undefined } })
  ]);
  assert.deepEqual(publicationIds(buildingClass), ["same-class"], "match by known total-floor class, not exact count or unknown class");
  assert.equal(select(four, "as-is", { ...subject, features: { ...features, totalFloors: undefined } }).status,
    "subject-incomplete", "an unknown subject floor class cannot produce a comparison group");

  const conditions = [
    candidate("unfinished"),
    candidate("good-ready", { features: { ...features, repair: "good", readiness: "ready" } }),
    candidate("designer-ready", { features: { ...features, repair: "designer", readiness: "ready" } }),
    candidate("cosmetic-ready", { features: { ...features, repair: "cosmetic", readiness: "ready" } }),
    candidate("good-unfinished", { features: { ...features, repair: "good" } }),
    candidate("same-repair-ready", { features: { ...features, readiness: "ready" } })
  ];
  assert.deepEqual(publicationIds(select(conditions)), ["unfinished"], "as-is requires both known subject condition fields to match");
  assert.deepEqual(publicationIds(select(conditions, "ready")), ["designer-ready", "good-ready"],
    "ready requires good or designer repair and ready status, regardless of subject condition");

  const listingEligibility = select([
    candidate("accepted"), candidate("review", { disposition: "REVIEW" }),
    candidate("excluded", { disposition: "EXCLUDED" }), candidate("inactive", { isActive: false }),
    candidate("disputed", { priceIsDisputed: true })
  ]);
  assert.deepEqual(publicationIds(listingEligibility), ["accepted"], "only active, accepted, undisputed publications qualify");

  const dimensions = select([
    candidate("area-lower", { areaSqm: 40 }), candidate("area-upper", { areaSqm: 60 }),
    candidate("area-below", { areaSqm: 39.99 }), candidate("area-above", { areaSqm: 60.01 }),
    candidate("year-lower", { features: { ...features, buildingYear: 1960 } }),
    candidate("year-upper", { features: { ...features, buildingYear: 2000 } }),
    candidate("year-below", { features: { ...features, buildingYear: 1959 } }),
    candidate("year-above", { features: { ...features, buildingYear: 2001 } }),
    candidate("year-unknown", { features: { ...features, buildingYear: undefined } })
  ]);
  assert.deepEqual(publicationIds(dimensions), ["area-lower", "area-upper", "year-lower", "year-upper"],
    "area and year limits are inclusive; a known subject year requires a known candidate year");

  const listingMatch = select([
    candidate("match"), candidate("different-rooms", { rooms: 3 }),
    candidate("different-studio", { features: { ...features, isStudio: true } }),
    candidate("unknown-studio", { features: { ...features, isStudio: undefined } }),
    candidate("different-material", { features: { ...features, buildingMaterial: "panel" } }),
    candidate("different-layout", { features: { ...features, layout: "walk-through" } }),
    candidate("zero-price", { priceUsd: 0 }), candidate("negative-price-sqm", { priceSqm: -1 }),
    candidate("nonfinite-price", { priceUsd: Infinity }), candidate("nonfinite-area", { areaSqm: NaN })
  ]);
  assert.deepEqual(publicationIds(listingMatch), ["match"], "require matching property facts and positive finite area and prices");
}
