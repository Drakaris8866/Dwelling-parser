import type { Comparable, ListingFeatures } from "../contracts/catalog.js";
import { cleanText, normalizeLocality } from "../utils/listingFeatures.js";
import { PRICE_POLICY } from "./catalogPricePolicy.js";

export const PERSONAL_COMPARABLES_VERSION = 1;

export interface ComparableSubject {
  propertyId: string;
  rooms: number;
  areaSqm: number;
  features: ListingFeatures;
}

export interface ComparableCandidate extends Comparable {
  rooms: number;
  features: ListingFeatures;
  isActive: boolean;
  disposition: "ACCEPTED" | "REVIEW" | "EXCLUDED";
  lastSeenAt: Date;
  priceIsDisputed?: boolean;
}

type Mode = "as-is" | "ready";
type RejectionCounts = ReturnType<typeof emptyRejections>;
type RejectionReason = keyof RejectionCounts;
type ComparableGroup = {
  comparables: Comparable[];
  radiusMeters: number | null;
  status: "ready" | "insufficient" | "subject-incomplete";
  rejected: RejectionCounts;
};

const emptyRejections = () => ({
  self: 0, inactive: 0, disposition: 0, disputedPrice: 0, invalidTimestamp: 0, stale: 0, future: 0,
  invalidPrice: 0, locality: 0, marketZone: 0, rooms: 0, studio: 0, floorClass: 0,
  area: 0, year: 0, material: 0, layout: 0, repair: 0, readiness: 0, distance: 0, duplicate: 0
});

const positiveFinite = (value: number): boolean => Number.isFinite(value) && value > 0;
const localityKey = (value: string | undefined): string => normalizeLocality(cleanText(value ?? ""));
const floorClass = (floors: number | undefined): number | undefined => {
  if (floors === undefined || !Number.isInteger(floors) || floors < 5) return undefined;
  return floors <= 6 ? 5 : floors <= 10 ? 7 : floors <= 16 ? 11 : 17;
};

const compareText = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const publicationOrder = (a: ComparableCandidate, b: ComparableCandidate): number =>
  b.lastSeenAt.getTime() - a.lastSeenAt.getTime()
  || compareText(a.platform, b.platform)
  || compareText(a.externalId, b.externalId);

const comparableEvidence = ({
  propertyId, externalId, platform, address, priceUsd, priceSqm, areaSqm, distanceMeters
}: ComparableCandidate): Comparable => ({ propertyId, externalId, platform, address, priceUsd, priceSqm, areaSqm, distanceMeters });

export const selectComparableGroup = (
  subject: ComparableSubject, candidates: readonly ComparableCandidate[], mode: Mode, now: Date, minimumComparables: number = PRICE_POLICY.minimumComparables
): ComparableGroup => {
  const rejected = emptyRejections();
  const a = subject.features;
  const locality = localityKey(a.locality);
  const floors = floorClass(a.totalFloors);
  if (!locality || !a.marketZone?.trim() || a.isStudio === undefined || floors === undefined
    || !Number.isInteger(subject.rooms) || subject.rooms < 0 || !positiveFinite(subject.areaSqm)) {
    return { comparables: [], radiusMeters: null, status: "subject-incomplete", rejected };
  }

  const nowMs = now.getTime();
  const cutoff = nowMs - PRICE_POLICY.freshnessDays * 86_400_000;
  const maxRadius = PRICE_POLICY.radiusMeters[2];
  // Keep decimal areas on the inclusive boundary despite floating-point roundoff.
  const maxAreaDifference = subject.areaSqm * (PRICE_POLICY.areaTolerance + Number.EPSILON);

  const rejectionReason = (candidate: ComparableCandidate): RejectionReason | undefined => {
    if (candidate.propertyId === subject.propertyId) return "self";
    if (!candidate.isActive) return "inactive";
    if (candidate.disposition !== "ACCEPTED") return "disposition";
    if (candidate.priceIsDisputed) return "disputedPrice";
    const seenAt = candidate.lastSeenAt.getTime();
    if (!Number.isFinite(seenAt) || !Number.isFinite(nowMs)) return "invalidTimestamp";
    if (seenAt < cutoff) return "stale";
    if (seenAt > nowMs) return "future";
    if (!positiveFinite(candidate.priceUsd) || !positiveFinite(candidate.priceSqm)) return "invalidPrice";
    if (!Number.isFinite(candidate.distanceMeters) || candidate.distanceMeters < 0 || candidate.distanceMeters > maxRadius) return "distance";
    if (candidate.rooms !== subject.rooms) return "rooms";
    if (!positiveFinite(candidate.areaSqm) || Math.abs(candidate.areaSqm - subject.areaSqm) > maxAreaDifference) return "area";

    const b = candidate.features;
    if (localityKey(b.locality) !== locality) return "locality";
    if (b.marketZone !== a.marketZone) return "marketZone";
    if (b.isStudio !== a.isStudio) return "studio";
    if (floorClass(b.totalFloors) !== floors) return "floorClass";
    if (a.buildingYear !== undefined
      && (b.buildingYear === undefined || !(Math.abs(a.buildingYear - b.buildingYear) <= PRICE_POLICY.yearTolerance))) return "year";
    if (a.buildingMaterial !== undefined && b.buildingMaterial !== a.buildingMaterial) return "material";
    if (a.layout !== undefined && b.layout !== a.layout) return "layout";
    if (mode === "ready") {
      if (b.repair !== "good" && b.repair !== "designer") return "repair";
      if (b.readiness !== "ready") return "readiness";
    } else {
      if (a.repair !== undefined && b.repair !== a.repair) return "repair";
      if (a.readiness !== undefined && b.readiness !== a.readiness) return "readiness";
    }
    return undefined;
  };

  const byProperty = new Map<string, ComparableCandidate>();
  for (const candidate of candidates) {
    const reason = rejectionReason(candidate);
    if (reason !== undefined) {
      rejected[reason]++;
      continue;
    }
    const previous = byProperty.get(candidate.propertyId);
    if (previous) rejected.duplicate++;
    if (!previous || publicationOrder(candidate, previous) < 0) byProperty.set(candidate.propertyId, candidate);
  }

  const distinct = [...byProperty.values()].sort((a, b) =>
    a.distanceMeters - b.distanceMeters || compareText(a.propertyId, b.propertyId));
  for (const radiusMeters of PRICE_POLICY.radiusMeters) {
    const withinRadius = distinct.filter((candidate) => candidate.distanceMeters <= radiusMeters);
    if (withinRadius.length >= minimumComparables) {
      rejected.distance += distinct.length - withinRadius.length;
      return { comparables: withinRadius.map(comparableEvidence), radiusMeters, status: "ready", rejected };
    }
  }
  return {
    comparables: distinct.map(comparableEvidence), radiusMeters: distinct.length ? maxRadius : null,
    status: "insufficient", rejected
  };
};
