import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Building2, ChevronLeft, ChevronRight, ExternalLink, Heart, X } from "lucide-react";
import { api } from "../api.js";
import type { RoutePlan, CatalogProcessing } from "../../../src/contracts/catalog.js";
import { layoutLabels, materialLabels, platformLabels, readinessLabels, repairLabels, routeLegLabel, sellerLabels } from "../../../src/contracts/labels.js";
import { money } from "./ListingCard.js";
import { formatDisplayAddress } from "../utils/addressFormatter.js";
import { AssessmentPanel } from "./AssessmentPanel.js";
import { ComparableCard } from "./ComparableCard.js";
import { ListingMap, choiceNames, type RouteChoice } from "./ListingMap.js";
import { PersonalRankingPanel } from "./PersonalRankingPanel.js";
import { RepairPanel } from "./RepairPanel.js";

const routeTime = (date: string): string => new Date(date).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Minsk" });
function Route({ title, route, status }: { title: string; route: RoutePlan | null | undefined; status?: CatalogProcessing["route"] | undefined }) {
  return <section className="detail-section"><h3>{title}</h3>{!route ? <p className="muted">{status?.message ?? "Маршрут ожидает расчёта"}</p> : <><div className="route-duration">{route.durationMinutes} <span>мин</span></div><div className="route-legs">{route.legs.map((leg, i) => <span className="route-leg" key={i}><span className={`mode-dot ${leg.mode.toLowerCase()}`} />{routeLegLabel(leg.mode, leg.route)}<strong>{Math.round(leg.durationMinutes)} мин</strong>{i < route.legs.length - 1 && <ArrowRight size={13} />}</span>)}</div><p className="muted">Пешком {route.walkingMinutes} мин · Ожидание {route.waitingMinutes} мин · Пересадок {route.transfers}</p>{route.arriveBy && <p className="muted">{route.date} · прибыть до {route.time}{route.departureAt && route.arrivalAt ? ` · выход ${routeTime(route.departureAt)} · прибытие ${routeTime(route.arrivalAt)}` : ""}{route.arrivalBufferMinutes !== undefined && ` · запас ${route.arrivalBufferMinutes} мин`}</p>}</>}</section>;
}
export function Detail({ id, onClose, onOpen, onState }: { id: string; onClose: () => void; onOpen: (id: string) => void; onState: (id: string, value: { favorite?: boolean; hidden?: boolean }) => void }) {
  const query = useQuery({ queryKey: ["detail", id], queryFn: () => api.detail(id), refetchInterval: (q) => {
    const state = q.state.data?.item.processing?.route.state;
    const photo = q.state.data?.photoRepair?.status;
    const item = q.state.data?.item;
    const scenarioPending = item?.renovationBudgetUsd != null && (item.assessment?.renovationScenario?.budgetUsd !== item.renovationBudgetUsd || item.assessment.renovationScenario.purchaseUsd !== item.priceUsd);
    return state === "pending" || state === "running" || photo === "QUEUED" || photo === "RUNNING" || !item?.assessment || scenarioPending ? 3_000 : 30_000;
  } });
  const [photo, setPhoto] = useState(0);
  const [choice, setChoice] = useState<RouteChoice>("primary");
  useEffect(() => { setPhoto(0); setChoice("primary"); }, [id]);
  useEffect(() => { const handler = (event: KeyboardEvent): void => { if (event.key === "Escape") onClose(); }; document.addEventListener("keydown", handler); const previous = document.body.style.overflow; document.body.style.overflow = "hidden"; return () => { document.removeEventListener("keydown", handler); document.body.style.overflow = previous; }; }, [onClose]);
  const detail = query.data, item = detail?.item, f = item?.features, a = item?.assessment;
  const alternative = item?.routes?.alternatives?.find((option) => option.kind === choice);
  const selectedRoute = alternative?.route ?? item?.routes?.target;
  const facts = f ? [
    ["Населённый пункт", f.locality], ["Район", f.district], ["ЖК", f.complex],
    ["Ремонт", f.repair ? repairLabels[f.repair] : undefined], ["Дом", f.buildingMaterial ? materialLabels[f.buildingMaterial] : undefined],
    ["Год постройки", f.buildingYear], ["Этаж", f.floor === undefined ? undefined : `${f.floor}/${f.totalFloors ?? "?"}`],
    ["Лифт", f.elevator === undefined ? undefined : f.elevator ? "Есть" : "Нет"],
    ["Кухня", f.kitchenSqm === undefined ? undefined : `${f.kitchenSqm} м²`], ["Жилая площадь", f.livingSqm === undefined ? undefined : `${f.livingSqm} м²`],
    ["Планировка", f.layout ? layoutLabels[f.layout] : undefined], ["Балкон / лоджия", f.balcony === undefined ? undefined : f.balcony ? "Есть" : "Нет"],
    ["Санузел", f.bathroom === undefined ? undefined : f.bathroom === "separate" ? "Раздельный" : "Совмещённый"],
    ["Потолки", f.ceilingMeters === undefined ? undefined : `${f.ceilingMeters} м`], ["Продавец", f.seller ? sellerLabels[f.seller] : undefined],
    ["Готовность", f.readiness ? readinessLabels[f.readiness] : undefined]
  ] : [];
  return <div className="drawer-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}><aside className="detail-drawer" role="dialog" aria-modal="true" aria-label="Подробности квартиры">
    <header className="drawer-header"><span>Квартира</span><div>{item && <button className={`icon-button ${item.favorite ? "favorite" : ""}`} title="Избранное" onClick={() => onState(item.id, { favorite: !item.favorite })}><Heart size={19} fill={item.favorite ? "currentColor" : "none"} /></button>}<button className="icon-button" title="Закрыть" onClick={onClose}><X size={21} /></button></div></header>
    {query.isPending && <div className="empty-state">Загружаем квартиру…</div>}
    {query.error && <div className="error-state">{query.error.message}</div>}
    {item && detail && <>
      <div className="detail-gallery">{item.photos[photo] ? <img src={item.photos[photo]} alt={`${item.title}, фото ${photo + 1}`} /> : <Building2 size={64} />}{item.photos.length > 1 && <><button className="gallery-prev icon-button" title="Предыдущее фото" onClick={() => setPhoto((p) => (p - 1 + item.photos.length) % item.photos.length)}><ChevronLeft /></button><button className="gallery-next icon-button" title="Следующее фото" onClick={() => setPhoto((p) => (p + 1) % item.photos.length)}><ChevronRight /></button><span className="gallery-counter">{photo + 1} / {item.photos.length}</span></>}</div>
      <div className="detail-content"><div className="detail-price">${money(item.priceUsd)} <span>${money(item.priceSqm)}/м²</span></div>{item.priceByn !== null && <p className="muted">≈ {money(item.priceByn)} BYN</p>}<h2>{item.features.isStudio ? "Студия" : `${item.rooms}-комнатная квартира`} · {item.areaSqm} м²</h2><p className="detail-address">{formatDisplayAddress(item.features.address, item.features.locality, item.title)}</p>
        <div className="detail-sources">{item.sources.map((source) => <a href={source.url} target="_blank" rel="noreferrer" key={source.platform + source.externalId}>{platformLabels[source.platform]} #{source.externalId}<ExternalLink size={13} /><span>${money(source.priceUsd)}</span></a>)}</div>
        <ListingMap key={item.id} item={item} target={selectedRoute} choice={alternative?.kind ?? "primary"} onChoice={setChoice} />
        {item.disposition === "REVIEW" && <div className="review-notice"><strong>Требует проверки</strong>{item.reasons.map((r) => <p key={r}>{r}</p>)}</div>}
        {item.possibleDuplicateIds.length > 0 && <section className="detail-section"><h3>Возможные повторные публикации</h3>{[...new Set(item.possibleDuplicateIds)].map((other, i) => <p key={other}><button className="text-link" onClick={() => onOpen(other)}>Посмотреть публикацию {i + 1}</button></p>)}</section>}
        <RepairPanel key={item.id} detail={detail} />
        <AssessmentPanel detail={detail} onOpen={onOpen} />
        <PersonalRankingPanel listingId={detail.item.id} />
        <Route title={alternative ? `До работы · ${choiceNames[alternative.kind].toLocaleLowerCase("ru-RU")}` : "До работы"} route={selectedRoute} status={item.processing?.route} /><Route title={`До метро${item.routes?.metroName ? ` «${item.routes.metroName}»` : ""} пешком`} route={item.routes?.metro}
          status={item.routes?.metroStatus === "FAILED" ? { state: "failed", message: item.routes.metroError ?? "Ошибка OTP при расчёте пути до метро" } : item.routes?.metroStatus === "NO_ROUTE" ? { state: "no-route", message: "OTP не нашёл пеший маршрут до метро" } : item.processing?.route} />
        <section className="detail-section"><h3>Характеристики</h3><dl className="facts-grid">{facts.map(([key, value]) => <div key={String(key)}><dt>{key}</dt><dd>{value ?? "Не указано"}</dd></div>)}</dl></section>
        <section className="detail-section"><h3>Описание</h3><p className="description">{item.description || "Описание пока не получено"}</p></section>
        {!!a?.comparables.length && <section className="detail-section"><h3>Сопоставимые предложения ({a.comparables.length})</h3><div className="comparables-scroll">{a.comparables.map((c) => <ComparableCard key={c.propertyId} item={c} onOpen={onOpen} />)}</div></section>}
        <section className="detail-section"><h3>История цены</h3><div className="table-scroll"><table><thead><tr><th>Дата</th><th>Площадка</th><th>Цена</th></tr></thead><tbody>{query.data?.priceHistory.map((p, i) => <tr key={i}><td>{new Date(p.date).toLocaleDateString("ru-RU")}</td><td>{platformLabels[p.platform]}</td><td>${money(p.priceUsd)}</td></tr>)}</tbody></table></div></section>
        <p className="muted small">Впервые замечено: {new Date(item.firstSeenAt).toLocaleDateString("ru-RU")} · Последнее наблюдение: {new Date(item.lastSeenAt).toLocaleString("ru-RU")}</p>
      </div></>}
  </aside></div>;
}
