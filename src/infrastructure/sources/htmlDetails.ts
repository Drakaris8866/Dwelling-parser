import * as cheerio from "cheerio";
import type { ListingCandidate } from "../../domain/listing.js";
import { featuresSchema } from "../../contracts/catalog.js";
import { inferFeatures, localityFromPropertyAddress } from "../../utils/listingFeatures.js";
import { propertyTypeFromDescription } from "../../utils/listingIntent.js";
import type { Logger } from "../logger.js";

export const extractListingDescription = (html: string, externalId: string, logger: Logger): string | null => {
  const $ = cheerio.load(html);
  let result = "";
  const raw = $("#__NEXT_DATA__").text();
  if (raw) {
    try {
      const queue: unknown[] = [JSON.parse(raw) as unknown];
      for (let i = 0; i < queue.length && i < 20000; i++) {
        const value = queue[i];
        if (Array.isArray(value)) { if (queue.length < 30000) queue.push(...value); continue; }
        if (value === null || typeof value !== "object") continue;
        const record = value as Readonly<Record<string, unknown>>;
        const own = ([record["adId"], record["ad_id"]].some((id) => String(id) === externalId) && ["price", "priceUsd", "price_usd", "adParams", "ad_parameters"].some((key) => key in record))
          || ([record["code"], record["id"]].some((id) => String(id) === externalId) && ["areaTotal", "number_of_rooms", "rooms"].some((key) => key in record));
        if (own) for (const key of ["body", "description"]) {
          const text = record[key];
          if (typeof text === "string" && text.trim().length > result.length) result = text.trim();
        }
        if (queue.length < 30000) queue.push(...Object.values(record).filter((entry) => entry !== null && typeof entry === "object"));
      }
    } catch (error: unknown) { logger.warn({ err: error, externalId }, "Failed to parse embedded full listing description"); }
  }
  if (!result) result = $("[itemprop=description], [data-testid=description], [data-name=description]").map((_, element) => $(element).text().trim()).get().sort((a, b) => b.length - a.length)[0] ?? "";
  if (!result) return null;
  const text = cheerio.load(`<div>${result}</div>`);
  text("script,style").remove(); text("br").replaceWith("\n"); text("p").append("\n");
  return text.root().text().trim();
};

export const enrichOnlinerHtml = (candidate: ListingCandidate, html: string): ListingCandidate => {
  const $ = cheerio.load(html);
  const descriptions = $(".apartment-info__cell_66 .apartment-info__sub-line, .apartment-info__sub-line_extended-bottom, .apartment-info__sub-line_large")
    .map((_, el) => { const clone = $(el).clone(); clone.find("script,style").remove(); return clone.text().trim(); }).get();
  const description = descriptions.sort((a, b) => b.length - a.length)[0] ?? "";
  if (!description && candidate.descriptionComplete !== true) throw new Error("Onliner did not contain a verifiable full description");
  const descriptionComplete = description.length > 0 || candidate.descriptionComplete === true;
  const details = [...candidate.details];
  $(".apartment-options-table__row").each((_, row) => {
    const cells = $(row).find(".apartment-options-table__cell");
    const key = cells.first().text().trim(), value = cells.last().text().trim();
    if (key && value) details.push(`${key}: ${value}`);
  });
  $(".apartment-options__item").each((_, row) => {
    const text = $(row).text().replace(/\s+/g, " ").trim();
    const house = /^(панельный|кирпичный|монолитный|каркасно-блочный|блочный|деревянный) дом ((?:18|19|20)\d{2}) года$/iu.exec(text);
    if (house) details.push(`Тип дома: ${house[1]}`, `Год постройки: ${house[2]}`);
    if (text) details.push(text.includes(":") ? text : `Параметр: ${text}`);
  });
  const title = $("h1").first().text().trim() || candidate.title;
  const photos: string[] = [];
  $(".apartment-gallery__slide img, .apartment-cover__thumbnail, .apartment-cover__thumbnail img").each((_, element) => {
    const node = $(element), style = node.attr("style") ?? "";
    const value = node.attr("data-src") ?? node.attr("data-original") ?? node.attr("src") ?? /url\(['"]?([^)'"\s]+)/.exec(style)?.[1];
    if (!value) return;
    try { const url = new URL(value, candidate.url); if (url.protocol === "https:") photos.push(url.toString()); } catch { /* Ignore malformed optional media metadata. */ }
  });
  const updated = enrichParameterHtml({ ...candidate, title, description: description || candidate.description, photos: [...new Set([...photos, ...candidate.photos])], photosComplete: photos.length > 0, details: [...new Set(details)] }, html);
  const features = inferFeatures(updated);
  const optionText = $(".apartment-options").text();
  const provenance = { ...features.provenance };
  provenance["propertyType"] = "description";
  if (description) provenance["description"] = "structured";
  return {
    ...updated,
    descriptionComplete,
    features: featuresSchema.parse({ ...features,
      descriptionComplete,
      propertyType: propertyTypeFromDescription(title, updated.description, features.address),
      balcony: /нет балкона|без балкона/i.test(optionText) ? false : /балкон|лоджи/i.test(optionText) ? true : features.balcony,
      elevator: /нет лифта|без лифта/i.test(optionText) ? false : /лифт/i.test(optionText) ? true : features.elevator,
      provenance
    })
  };
};

const PARAMETER_LABELS = new Set(["Ремонт", "Тип дома", "Материал стен", "Год постройки", "Год строительства", "Балкон", "Лифт", "Планировка", "Санузел", "Высота потолков", "Общая площадь", "Жилая площадь", "Площадь кухни", "Кухня", "Этаж", "Этажность", "Этажей", "Жилой комплекс", "ЖК"]);
const LABEL_ALIASES: Readonly<Record<string, string>> = { "Материал стен": "Тип дома", "Год строительства": "Год постройки", "Высота потолков": "Потолки", "Площадь кухни": "Кухня", "Этажность": "Этажей", "Жилой комплекс": "ЖК" };
export const enrichParameterHtml = (candidate: ListingCandidate, html: string): ListingCandidate => {
  const $ = cheerio.load(html), details = [...candidate.details];
  $("dt,span,div,th").each((_, element) => {
    const node = $(element);
    if (node.children().length > 0) return;
    const label = node.text().trim().replace(/:$/, "");
    if (!PARAMETER_LABELS.has(label)) return;
    let value = node.next().text().replace(/\s+/g, " ").trim();
    const labelContainer = node.parent();
    // REALT wraps the label and an empty separator separately from the value.
    if (!value && node.next().length === 1 && labelContainer.children().length === 2
      && labelContainer.children().first().is(node) && labelContainer.parent().children().length === 2) {
      const valueContainer = labelContainer.next();
      const containsLabel = valueContainer.find("dt,span,div,th").toArray()
        .some((child) => PARAMETER_LABELS.has($(child).text().trim().replace(/:$/, "")));
      if (!containsLabel) value = valueContainer.text().replace(/\s+/g, " ").trim();
    }
    if (value.length > 0 && value.length < 100 && !PARAMETER_LABELS.has(value)) details.push(`${LABEL_ALIASES[label] ?? label}: ${value}`);
  });
  const updated = { ...candidate, details: [...new Set(details)], features: featuresSchema.parse({}) };
  const parsed = inferFeatures(updated), original = candidate.features ?? featuresSchema.parse({});
  const merged = featuresSchema.parse({ ...original, ...Object.fromEntries(Object.entries(parsed).filter(([key, value]) => key !== "provenance" && value !== undefined)), provenance: { ...original.provenance, ...Object.fromEntries(Object.keys(parsed.provenance).map((key) => [key, "structured"])) } });
  return { ...candidate, details: updated.details, features: merged };
};

export const localityFromAddress = (address: string | undefined): string | undefined => {
  return localityFromPropertyAddress(address);
};
