import assert from "node:assert/strict";
import { descriptionDuplicate, type ApartmentIdentity } from "../src/domain/duplicateIdentity.js";

const description = "Продаётся уютная квартира с большой застеклённой лоджией. Окна выходят в тихий зелёный двор. В прихожей установлен вместительный шкаф, на кухне остаётся мебель и вся встроенная техника. Во дворе есть детская площадка, рядом находятся школа и магазины.";
const listing: ApartmentIdentity & { description: string } = {
  address: "Минск, ул. Ротмистрова, 32", locality: "Минск", latitude: 53.8403, longitude: 27.6942,
  floor: 8, totalFloors: 9, rooms: 1, areaSqm: 34.04, priceUsd: 69900, priceByn: 209833,
  livingSqm: 16.94, kitchenSqm: 7.2, buildingYear: 1984, description
};

export const testDuplicateIdentity = (): void => {
  const repost = { ...listing, areaSqm: 34, livingSqm: 16.9,
    description: `• ${description.replace("Продаётся", "Продается")} Звоните и записывайтесь на просмотр.` };
  assert.equal(descriptionDuplicate(listing, repost), true, "Rounded dimensions and formatted copies retain listing identity");
  assert.equal(descriptionDuplicate(listing, { ...repost, address: "" }), true, "A nearby listing with corroborating copy can omit the street address");
  assert.equal(descriptionDuplicate(listing, { ...repost, address: "", latitude: 53.8408 }), false, "A missing address requires a close map pin");
  assert.equal(descriptionDuplicate(listing, { ...repost, address: "Минск, ул. Ротмистрова, 32/2" }), false, "Different stated buildings cannot match through copied text");
  assert.equal(descriptionDuplicate(listing, { ...repost, floor: 7 }), false, "A different floor contradicts the copy");
  assert.equal(descriptionDuplicate(listing, { ...repost, livingSqm: 19.2 }), false, "A different layout contradicts the copy");
  assert.equal(descriptionDuplicate({ ...listing, description: "Продается уютная квартира." }, { ...repost, description: "Продается уютная квартира." }), false, "A generic short description is insufficient");
  assert.equal(descriptionDuplicate(
    { ...listing, description: `${"балкон прихожая ремонт шкаф окна ".repeat(12)} ${description}` },
    { ...repost, description: `${"лифт потолки спальня подъезд лоджия ".repeat(12)} ${description}` }
  ), false, "A common footer within mostly different descriptions is insufficient");
};
