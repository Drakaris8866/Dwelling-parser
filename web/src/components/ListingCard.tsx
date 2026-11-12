import { Building2, BusFront, EyeOff, Heart, MapPin } from "lucide-react";
import type { CatalogItem, CatalogProcessing } from "../../../src/contracts/catalog.js";
import { platformLabels, repairLabels } from "../../../src/contracts/labels.js";
import { formatDisplayAddress } from "../utils/addressFormatter.js";
import { queueDescription, queueDuration } from "../routeQueue.js";
import "../processing.css";

export const money = (value: number): string => new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(value);
const statusLabels: Readonly<Record<CatalogProcessing["value"]["state"], string>> = {
  pending: "В очереди", running: "Рассчитывается", ready: "Нет данных", insufficient: "Мало данных", review: "Нужна проверка", failed: "Ошибка расчёта", "missing-coordinates": "Нет координат", "no-route": "Нет маршрута"
};
const preciseScore = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 });
export function Rating({ label, value, provisional = false, status, precise = false }: { label: string; value: number | null; provisional?: boolean; status?: CatalogProcessing["value"] | undefined; precise?: boolean }) {
  return <div className={`rating ${value !== null && value >= 70 ? "positive" : ""}`}><span>{label}</span><strong className={value === null ? "rating-status" : ""} title={status?.message}>{value === null ? statusLabels[status?.state ?? "pending"] : precise ? preciseScore.format(value) : Math.round(value)}{value !== null && <small>/100</small>}</strong>{provisional && value !== null && <span className="provisional" title="Недостаточно известных параметров">Предв.</span>}</div>;
}
const routeLabel = (item: CatalogItem): string => item.processing?.route.state === "pending" && item.routeQueue
  ? item.routeQueue.estimatedSeconds === null ? `Очередь: № ${item.routeQueue.position}` : `Ожидание: ${queueDuration(item.routeQueue.estimatedSeconds)}`
  : item.routes?.target ? `${item.routes.target.durationMinutes} мин до точки`
  : item.processing?.route.state === "failed" ? "Ошибка OTP" : item.processing?.route.state === "missing-coordinates" ? "Нет координат"
    : item.processing?.route.state === "no-route" ? "Маршрут не найден" : item.processing?.route.state === "running" ? "Расчёт маршрута" : "Маршрут в очереди";
export function ListingCard({ item, onOpen, onState }: { item: CatalogItem; onOpen: (id: string) => void; onState: (id: string, state: { favorite?: boolean; hidden?: boolean }) => void }) {
  const displayAddress = formatDisplayAddress(item.features.address, item.features.locality, item.title);
  return <article className={`listing-card ${item.hidden ? "is-hidden" : ""}`}>
    <button className="listing-image" onClick={() => onOpen(item.id)} aria-label={`Открыть ${displayAddress}`}>
      {item.photos[0] ? <img src={item.photos[0]} alt={item.title} loading="lazy" onError={(e) => { e.currentTarget.style.display = "none"; }} /> : null}
      <Building2 className="image-fallback" size={44} /><span className="photo-count">{item.photos.length} фото</span>
    </button>
    <div className="listing-body"><div className="price-row"><button className="title-button" onClick={() => onOpen(item.id)}><strong>${money(item.priceUsd)}</strong></button><div className="listing-actions"><button className={`icon-button ${item.favorite ? "favorite" : ""}`} title={item.favorite ? "Убрать из избранного" : "В избранное"} onClick={() => onState(item.id, { favorite: !item.favorite })}><Heart size={19} fill={item.favorite ? "currentColor" : "none"} /></button><button className="icon-button" title={item.hidden ? "Вернуть в каталог" : "Скрыть квартиру"} onClick={() => onState(item.id, { hidden: !item.hidden })}><EyeOff size={18} /></button></div></div>
      <div className="muted price-meter">${money(item.priceSqm)}/м²{item.priceByn !== null ? ` · ${money(item.priceByn)} BYN` : ""}</div>
      <button className="title-button apartment-name" onClick={() => onOpen(item.id)}>{item.features.isStudio ? "Студия" : `${item.rooms}-комнатная квартира`} · {item.areaSqm} м²{item.features.floor !== undefined ? ` · ${item.features.floor}/${item.features.totalFloors ?? "?"} эт.` : ""}</button>
      <div className="address-line"><MapPin size={14} /><span>{displayAddress}</span></div>
      <div className="condition-line">{item.features.repair ? repairLabels[item.features.repair] : "Ремонт не указан"}{item.features.buildingYear ? ` · ${item.features.buildingYear} г.` : ""}</div>
      <div className="rating-row"><Rating label="Выгодность" value={item.assessment?.valueScore ?? null} status={item.processing?.value} /><Rating label="Удобство" value={item.assessment?.comfortScore ?? null} status={item.processing?.comfort} provisional={!!item.assessment && item.assessment.coverage < 70} /></div>
      <div className="card-bottom"><span className="commute" title={item.routeQueue ? queueDescription(item.routeQueue) : item.processing?.route.message}><BusFront size={15} />{routeLabel(item)}</span><div className="source-badges">{[...new Map(item.sources.map((source) => [source.platform, source])).values()].map((source) => <span className={`source-badge ${source.platform.toLowerCase()}`} key={source.platform} title={`${source.platform} #${source.externalId}`}>{platformLabels[source.platform]}</span>)}</div></div>
      {item.disposition === "REVIEW" && <div className="review-label">Требует проверки</div>}
    </div>
  </article>;
}
