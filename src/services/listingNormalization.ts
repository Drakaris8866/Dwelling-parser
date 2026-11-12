import type { ListingCandidate } from "../domain/listing.js";
import type { CollectionArea } from "../infrastructure/geo/collectionArea.js";
import { featuresSchema } from "../contracts/catalog.js";
import { cleanText, inferFeatures, usableLocality } from "../utils/listingFeatures.js";

export const normalizeCandidate = (candidate: ListingCandidate, area: CollectionArea): ListingCandidate => {
  const f = inferFeatures(candidate);
  let scope = f.inCollectionArea, locality = usableLocality(f.locality, f.address);
  let inMinskWorld = false;
  if (candidate.latitude !== undefined && candidate.longitude !== undefined) {
    const location = area.locate(candidate.latitude, candidate.longitude);
    scope = location !== "outside";
    if (location === "minsk") locality = "Минск";
    inMinskWorld = area.isMinskWorld(candidate.latitude, candidate.longitude);
  }
  let zone = locality ? cleanText(locality) : undefined;
  const name = `${f.district ?? ""} ${f.address ?? ""}`;
  if (/шабан/iu.test(name)) zone = "minsk:shabany";
  if (/(?:^|[^\p{L}])сокол(?:$|[^\p{L}])/iu.test(name)) zone = "minsk:sokol";
  return { ...candidate, features: featuresSchema.parse({ ...f, locality, inCollectionArea: scope, marketZone: zone,
    ...(inMinskWorld ? { complex: "Минск-Мир", provenance: { ...f.provenance, complex: "inferred" } } : {}) }) };
};
