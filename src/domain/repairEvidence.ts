import type { ListingFeatures } from "../contracts/catalog.js";
import { photoEvidenceSchema, photoRepairCategory, type FloorPlan, type PhotoBuildingCategory, type PhotoEvidence, type PhotoRepairCategory } from "../contracts/photoRepair.js";

type Approval = { status: string; decision: string; galleryHash: string; suggestion: string | null; evidence?: unknown };
export const approvedRepair = (analysis: Approval | null | undefined, galleryHash: string | null): PhotoRepairCategory | undefined => {
  if (analysis?.status !== "READY" || analysis.decision !== "APPROVED" || analysis.galleryHash !== galleryHash) return undefined;
  const parsed = photoRepairCategory.safeParse(analysis.suggestion);
  return parsed.success ? parsed.data : undefined;
};

export const photoConsensus = (evidence: PhotoEvidence): PhotoRepairCategory | null => {
  const votes = evidence.flatMap((photo) => photo.scene === "interior" && photo.condition && photo.observations.length ? [photo.condition] : []);
  if (votes.includes("good") && votes.some((vote) => vote === "none" || vote === "needs-repair")) return null;
  return photoRepairCategory.options.find((category) => {
    const agreeing = votes.filter((vote) => vote === category).length;
    return agreeing >= 2 && agreeing * 2 > votes.length;
  }) ?? null;
};

export const repairSuggestionFromEvidence = (evidence: unknown): PhotoRepairCategory | null => {
  const parsed = photoEvidenceSchema.safeParse(evidence);
  return parsed.success ? photoConsensus(parsed.data) : null;
};

export const photoBuildingConsensus = (evidence: PhotoEvidence): PhotoBuildingCategory | null => {
  const votes = evidence.flatMap((photo) => photo.scene === "exterior" && photo.buildingCondition && photo.observations.length ? [photo.buildingCondition] : []);
  return votes.length >= 2 && votes.every((vote) => vote === votes[0]) ? votes[0]! : null;
};
export const buildingSuggestionFromEvidence = (evidence: unknown): PhotoBuildingCategory | null => {
  const parsed = photoEvidenceSchema.safeParse(evidence);
  return parsed.success ? photoBuildingConsensus(parsed.data) : null;
};
export const approvedBuilding = (analysis: Approval | null | undefined, galleryHash: string | null): PhotoBuildingCategory | undefined =>
  analysis?.status === "READY" && analysis.decision === "APPROVED" && analysis.galleryHash === galleryHash ? buildingSuggestionFromEvidence(analysis.evidence) ?? undefined : undefined;

export const planSuggestionFromEvidence = (evidence: unknown): FloorPlan | null => {
  const parsed = photoEvidenceSchema.safeParse(evidence);
  if (!parsed.success) return null;
  const plans = parsed.data.flatMap((photo) => photo.scene === "floor-plan" && photo.floorPlan && photo.observations.length ? [photo.floorPlan] : []);
  const agree = <T>(values: readonly (T | null)[]): T | null => {
    const known = new Set(values.filter((value): value is T => value !== null));
    return known.size === 1 ? [...known][0]! : null;
  };
  const layout = agree(plans.map((plan) => plan.layout)), bathroom = agree(plans.map((plan) => plan.bathroom));
  return layout || bathroom ? { layout, bathroom } : null;
};
export const approvedPlan = (analysis: Approval | null | undefined, galleryHash: string | null): FloorPlan | undefined =>
  analysis?.status === "READY" && analysis.decision === "APPROVED" && analysis.galleryHash === galleryHash ? planSuggestionFromEvidence(analysis.evidence) ?? undefined : undefined;

export const withPlan = (features: ListingFeatures, plan?: FloorPlan): ListingFeatures => ({
  ...features, layout: plan?.layout ?? features.layout, bathroom: plan?.bathroom ?? features.bathroom
});

const inferredReadiness = (repair: ListingFeatures["repair"]): ListingFeatures["readiness"] => repair === undefined ? undefined : repair === "none" || repair === "needs-repair" ? "unfinished" : "ready";
export const marketFeatures = (features: ListingFeatures, confirmed: PhotoRepairCategory | undefined): ListingFeatures => {
  if (!confirmed) return features;
  const derived = features.provenance["readiness"] === "inferred" || (features.provenance["readiness"] === "legacy" && features.readiness === inferredReadiness(features.repair));
  return { ...features, repair: confirmed, readiness: derived && features.readiness !== "construction" ? inferredReadiness(confirmed) : features.readiness };
};
