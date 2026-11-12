import { areAddressesCompatible, hasStreetAddress } from "../utils/duplicateEvidence.js";
import { haversineMeters } from "../utils/geoMath.js";

type NumberValue = number | { toNumber(): number };
export interface ApartmentIdentity {
  address: string | null; locality: string | null; latitude: NumberValue | null; longitude: NumberValue | null;
  floor: number | null; totalFloors: number | null; rooms: number; areaSqm: NumberValue;
  priceUsd: NumberValue; priceByn: NumberValue | null;
  livingSqm: number | null; kitchenSqm: number | null; buildingYear: number | null;
  readiness?: string | null;
}
const amount = (value: NumberValue): number => typeof value === "number" ? value : value.toNumber();
const same = (a: NumberValue | null, b: NumberValue | null, tolerance: number): boolean =>
  (a === null && b === null) || (a !== null && b !== null && Math.abs(amount(a) - amount(b)) <= tolerance + 1e-9);

type DescribedApartment = ApartmentIdentity & { description: string };

const descriptionWords = (text: string): string[] =>
  text.normalize("NFKC").toLocaleLowerCase("ru-RU").replace(/ё/g, "е").match(/[\p{L}\p{N}]+/gu) ?? [];

const descriptionPassages = (words: string[], passageLength: number): string[] => {
  const lastStart = Math.min(50, Math.floor(words.length / 3), words.length - passageLength);
  return Array.from({ length: Math.max(0, lastStart + 1) }, (_, index) =>
    words.slice(index, index + passageLength).join(" "));
};

export const descriptionDuplicate = (a: DescribedApartment, b: DescribedApartment): boolean => {
  if (a.readiness === "construction" || b.readiness === "construction" || !a.locality || a.locality !== b.locality) return false;
  if (a.floor === null || a.floor !== b.floor || a.rooms !== b.rooms || !same(a.areaSqm, b.areaSqm, 0.6)) return false;
  if (a.totalFloors !== null && b.totalFloors !== null && a.totalFloors !== b.totalFloors) return false;
  if (a.buildingYear !== null && b.buildingYear !== null && !same(a.buildingYear, b.buildingYear, 1)) return false;
  if (a.livingSqm !== null && b.livingSqm !== null && !same(a.livingSqm, b.livingSqm, 0.3)) return false;
  if (a.kitchenSqm !== null && b.kitchenSqm !== null && !same(a.kitchenSqm, b.kitchenSqm, 0.3)) return false;

  const addressA = a.address && hasStreetAddress(a.address) ? a.address : null;
  const addressB = b.address && hasStreetAddress(b.address) ? b.address : null;
  const distance = a.latitude !== null && a.longitude !== null && b.latitude !== null && b.longitude !== null
    ? haversineMeters({ latitude: amount(a.latitude), longitude: amount(a.longitude) }, { latitude: amount(b.latitude), longitude: amount(b.longitude) })
    : null;
  if (addressA && addressB) {
    if (!areAddressesCompatible(addressA, addressB, a.locality) || (distance !== null && distance > 75)) return false;
  } else {
    if (!addressA && !addressB) return false;
    if (distance === null || distance > 25 || a.totalFloors === null || a.totalFloors !== b.totalFloors) return false;
    if (Math.abs(amount(a.priceUsd) - amount(b.priceUsd)) > Math.max(amount(a.priceUsd), amount(b.priceUsd)) * 0.08) return false;
  }

  const wordsA = descriptionWords(a.description), wordsB = descriptionWords(b.description);
  const passageLength = Math.max(32, Math.ceil(Math.min(wordsA.length, wordsB.length) / 2));
  const passages = new Set(descriptionPassages(wordsA, passageLength));
  return descriptionPassages(wordsB, passageLength).some((passage) => passage.length >= 160 && passages.has(passage));
};

export const structuredDuplicate = (a: ApartmentIdentity, b: ApartmentIdentity): boolean => {
  if (a.readiness === "construction" || b.readiness === "construction") return false;
  if (!a.address || !b.address || !a.locality || a.locality !== b.locality || !hasStreetAddress(a.address) || !hasStreetAddress(b.address)) return false;
  const exactAddress = areAddressesCompatible(a.address, b.address, a.locality);
  const baseAddress = !exactAddress && areAddressesCompatible(a.address, b.address, a.locality, { allowBaseHouseMatch: true });
  if (!exactAddress && !baseAddress) return false;
  const areaMatches = same(a.areaSqm, b.areaSqm, 0.6) || Math.abs(amount(a.areaSqm) / amount(b.areaSqm) - 1) <= 0.015;
  if (a.floor === null || a.floor !== b.floor || a.rooms !== b.rooms || !same(a.totalFloors, b.totalFloors, 0) || !areaMatches) return false;
  if (!same(a.livingSqm, b.livingSqm, 0.1) || !same(a.kitchenSqm, b.kitchenSqm, 0.1) || (a.buildingYear !== null && b.buildingYear !== null && Math.abs(a.buildingYear - b.buildingYear) > 1)) return false;
  const priceMatches = a.priceByn !== null && b.priceByn !== null
    ? (same(a.priceByn, b.priceByn, 100) || Math.abs(amount(a.priceByn) / amount(b.priceByn) - 1) <= 0.02)
    : (same(a.priceUsd, b.priceUsd, 100) || Math.abs(amount(a.priceUsd) / amount(b.priceUsd) - 1) <= 0.06);
  if (!priceMatches) return false;
  if (baseAddress) {
    const strictPrice = (a.priceByn !== null && b.priceByn !== null && (same(a.priceByn, b.priceByn, 100) || Math.abs(amount(a.priceByn) / amount(b.priceByn) - 1) <= 0.01))
      || (same(a.priceUsd, b.priceUsd, 100) || Math.abs(amount(a.priceUsd) / amount(b.priceUsd) - 1) <= 0.015);
    const strictArea = same(a.areaSqm, b.areaSqm, 0.2);
    if (!strictPrice || !strictArea) return false;
  }
  if (a.latitude === null || a.longitude === null || b.latitude === null || b.longitude === null) return false;
  return haversineMeters({ latitude: amount(a.latitude), longitude: amount(a.longitude) }, { latitude: amount(b.latitude), longitude: amount(b.longitude) }) <= 75;
};
