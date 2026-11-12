import type { CatalogFilters } from "../../../src/contracts/catalog.js";
import { confidenceLabels, layoutLabels, materialLabels, platformLabels, readinessLabels, repairLabels, sellerLabels } from "../../../src/contracts/labels.js";
import { RotateCcw, Search } from "lucide-react";

export function MultiSelect<T extends string>({ label, choices, value = [], onChange }: { label: string; choices: Readonly<Record<T, string>>; value?: readonly T[] | undefined; onChange: (value: T[]) => void }) {
  return <fieldset className="filter-group"><legend>{label}</legend><div className="check-options">{(Object.keys(choices) as T[]).map((key) => <label className="check" key={key}><input type="checkbox" checked={value.includes(key)} onChange={(e) => onChange(e.target.checked ? [...value, key] : value.filter((v) => v !== key))} /><span>{choices[key]}</span></label>)}</div></fieldset>;
}
type NumericKey = "minPrice" | "maxPrice" | "minPriceSqm" | "maxPriceSqm" | "minArea" | "maxArea" | "minKitchen" | "maxKitchen" | "minLiving" | "maxLiving" | "minFloor" | "maxFloor" | "minYear" | "maxYear" | "maxTransit" | "maxMetroWalk" | "minValueScore" | "minComfortScore";
export function Filters({ value, onChange, localities, districts }: { value: CatalogFilters; onChange: (f: CatalogFilters) => void; localities: string[]; districts: string[] }) {
  const set = <K extends keyof CatalogFilters>(key: K, next: CatalogFilters[K]): void => onChange({ ...value, [key]: next });
  const numberInput = (key: NumericKey, placeholder: string) => <input aria-label={placeholder} type="number" min="0" value={value[key] ?? ""} placeholder={placeholder} onChange={(e) => set(key, e.target.value === "" ? undefined : Math.max(0, Number(e.target.value)))} />;
  const range = (label: string, min: NumericKey, max: NumericKey) => <fieldset className="filter-group"><legend>{label}</legend><div className="range">{numberInput(min, `${label}: от`)}<span>—</span>{numberInput(max, `${label}: до`)}</div></fieldset>;
  const boolean = (label: string, key: "balcony" | "elevator" | "studio") => <label className="field-inline"><span>{label}</span><select aria-label={label} value={value[key] === undefined ? "" : String(value[key])} onChange={(e) => set(key, e.target.value === "" ? undefined : e.target.value === "true")}><option value="">Любой вариант</option><option value="true">Да</option><option value="false">Нет</option></select></label>;
  return <aside className="filters">
    <div className="filters-heading"><h2>Фильтры</h2><button className="icon-button" title="Сбросить фильтры" onClick={() => onChange({})}><RotateCcw size={17} /></button></div>
    <label className="search-field"><Search size={16} /><input aria-label="Поиск по адресу и описанию" placeholder="Адрес, район, описание" value={value.text ?? ""} onChange={(e) => set("text", e.target.value || undefined)} /></label>
    {range("Цена, $", "minPrice", "maxPrice")}
    <fieldset className="filter-group"><legend>Комнаты</legend><div className="room-options">{[1, 2, 3, 4, 5].map((room) => {
      const selected = room === 5 ? value.rooms?.some((r) => r >= 5) ?? false : value.rooms?.includes(room) ?? false;
      return <label className={`room-option ${selected ? "selected" : ""}`} key={room}><input type="checkbox" checked={selected} onChange={(e) => {
        const group = room === 5 ? Array.from({ length: 16 }, (_, i) => i + 5) : [room];
        set("rooms", e.target.checked ? [...new Set([...value.rooms ?? [], ...group])] : value.rooms?.filter((r) => !group.includes(r)));
      }} /><span>{room === 5 ? "5+" : room}</span></label>;
    })}</div></fieldset>
    {boolean("Студия", "studio")}
    {range("Общая площадь, м²", "minArea", "maxArea")}
    <MultiSelect label="Площадки" choices={platformLabels} value={value.platforms} onChange={(v) => set("platforms", v)} />
    <MultiSelect label="Населённый пункт" choices={Object.fromEntries(localities.map((v) => [v, v]))} value={value.localities} onChange={(v) => set("localities", v)} />
    <MultiSelect label="Район" choices={Object.fromEntries(districts.map((v) => [v, v]))} value={value.districts} onChange={(v) => set("districts", v)} />
    <details open><summary>Оценки и транспорт</summary><div className="field-stack">
      <label>Выгодность от{numberInput("minValueScore", "Выгодность от 0 до 100")}</label>
      <label>Удобство от{numberInput("minComfortScore", "Удобство от 0 до 100")}</label>
      <label>До текущей точки, не более мин{numberInput("maxTransit", "До текущей точки, мин")}</label>
      <label>Пешком до метро, не более мин{numberInput("maxMetroWalk", "Пешком до метро, мин")}</label>
    </div><MultiSelect label="Надёжность оценки цены" choices={confidenceLabels} value={value.confidence} onChange={(v) => set("confidence", v)} /></details>
    <details><summary>Квартира и дом</summary>
      {range("Цена за м², $", "minPriceSqm", "maxPriceSqm")}{range("Кухня, м²", "minKitchen", "maxKitchen")}{range("Жилая площадь, м²", "minLiving", "maxLiving")}
      {range("Этаж", "minFloor", "maxFloor")}{range("Год постройки", "minYear", "maxYear")}
      <label className="check"><input type="checkbox" checked={value.notFirstFloor ?? false} onChange={(e) => set("notFirstFloor", e.target.checked)} />Не первый этаж</label>
      <label className="check"><input type="checkbox" checked={value.notLastFloor ?? false} onChange={(e) => set("notLastFloor", e.target.checked)} />Не последний этаж</label>
      {boolean("Лифт", "elevator")}{boolean("Балкон / лоджия", "balcony")}
      <MultiSelect label="Ремонт" choices={repairLabels} value={value.repair} onChange={(v) => set("repair", v)} />
      <MultiSelect label="Материал дома" choices={materialLabels} value={value.materials} onChange={(v) => set("materials", v)} />
      <MultiSelect label="Планировка" choices={layoutLabels} value={value.layout} onChange={(v) => set("layout", v)} />
      <MultiSelect label="Готовность" choices={readinessLabels} value={value.readiness} onChange={(v) => set("readiness", v)} />
      <MultiSelect label="Продавец" choices={sellerLabels} value={value.sellers} onChange={(v) => set("sellers", v)} />
    </details>
    <fieldset className="filter-group"><legend>Отображение</legend><label className="check"><input type="checkbox" checked={value.showReview ?? false} onChange={(e) => set("showReview", e.target.checked)} />Требующие проверки</label><label className="check"><input type="checkbox" checked={value.showHidden ?? false} onChange={(e) => set("showHidden", e.target.checked)} />Показывать скрытые</label></fieldset>
  </aside>;
}
