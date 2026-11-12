import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, LocateFixed, RefreshCw, Route as RouteIcon } from "lucide-react";
import { decode } from "@googlemaps/polyline-codec";
import L from "leaflet";
import type { CatalogItem, RoutePlan } from "../../../src/contracts/catalog.js";
import { routeLegLabel } from "../../../src/contracts/labels.js";
import { api } from "../api.js";
import { openStreetMapTiles } from "../mapTiles.js";
import { COMMUTE_VERSION } from "../../../src/domain/commutePolicy.js";
import { queueDescription } from "../routeQueue.js";
import "../listingDetail.css";

export type RouteChoice = "primary" | "fastest" | "surface" | "tram";
export const choiceNames: Readonly<Record<RouteChoice, string>> = { primary: "Основной", fastest: "Самый быстрый", surface: "Без метро", tram: "С трамваем" };
const modeColors: Readonly<Record<string, string>> = { WALK: "#64758a", BUS: "#2864a2", TROLLEYBUS: "#8456a0", TRAM: "#b95129", SUBWAY: "#177354" };
const minskTime = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Minsk" });
type Segment = { readonly points: L.LatLngTuple[]; readonly mode: string; readonly label: string };
const routeSegments = (route: RoutePlan | null | undefined): Segment[] => (route?.legs ?? []).flatMap((leg) => {
  if (!leg.encodedPath) return [];
  try {
    const points = decode(leg.encodedPath, 5);
    if (points.length < 2 || points.some(([lat, lon]) => lat === undefined || lon === undefined || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180)) return [];
    return [{ points: points.map(([lat, lon]): L.LatLngTuple => [lat!, lon!]), mode: leg.mode, label: routeLegLabel(leg.mode, leg.route) }];
  } catch { return []; }
});
const textNode = (label: string): HTMLElement => { const span = document.createElement("span"); span.textContent = label; return span; };

export function ListingMap({ item, target, choice, onChoice }: { item: CatalogItem; target: RoutePlan | null | undefined; choice: RouteChoice; onChoice: (value: RouteChoice) => void }) {
  const container = useRef<HTMLDivElement>(null), map = useRef<L.Map | null>(null), overlays = useRef<L.LayerGroup | null>(null);
  const bounds = useRef<L.LatLngBounds | null>(null), focus = useRef<"home" | "route">("home");
  const [tileWarning, setTileWarning] = useState(false);
  const queryClient = useQueryClient();
  const { latitude, longitude } = item, destination = target?.destination;
  const segments = useMemo(() => routeSegments(target), [target]);
  const hasRoute = segments.length > 0;
  const status = item.processing?.route;
  const request = useMutation({ mutationFn: () => api.requestRoute(item.id), onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["detail", item.id] }); } });
  const waiting = request.isPending || (request.isSuccess && (status?.state === "pending" || status?.state === "running"));

  useEffect(() => {
    if (!container.current || latitude === null || longitude === null) return;
    const instance = L.map(container.current, { scrollWheelZoom: false, zoomControl: false }).setView([latitude, longitude], 16);
    L.control.zoom({ zoomInTitle: "Приблизить", zoomOutTitle: "Отдалить" }).addTo(instance);
    openStreetMapTiles().on("tileerror", () => setTileWarning(true)).on("tileload", () => setTileWarning(false)).addTo(instance);
    map.current = instance; overlays.current = L.layerGroup().addTo(instance);
    const resize = new ResizeObserver(() => {
      instance.invalidateSize();
      if (focus.current === "route" && bounds.current) instance.fitBounds(bounds.current, { padding: [24, 24], maxZoom: 16, animate: false });
    });
    resize.observe(container.current);
    return () => { resize.disconnect(); instance.remove(); map.current = null; overlays.current = null; bounds.current = null; };
  }, [latitude, longitude]);

  useEffect(() => {
    const layer = overlays.current;
    if (!layer || latitude === null || longitude === null) return;
    layer.clearLayers();
    const area = L.latLngBounds([[latitude, longitude]]);
    for (const segment of segments) {
      const walking = segment.mode === "WALK";
      L.polyline(segment.points, { className: `commute-line ${walking ? "walk" : "transit"}`, color: modeColors[segment.mode] ?? "#177354",
        weight: walking ? 4 : 5, opacity: 0.92, ...(walking ? { dashArray: "6 7" } : {}) }).bindTooltip(textNode(segment.label)).addTo(layer);
      area.extend(L.latLngBounds(segment.points));
    }
    L.marker([latitude, longitude], { title: "Квартира", icon: L.divIcon({ className: "detail-map-pin home-pin", iconSize: [18, 18] }) })
      .bindTooltip(textNode("Квартира"), { permanent: true, direction: "top", offset: [0, -10] }).addTo(layer);
    if (destination && segments.length) {
      const point: L.LatLngTuple = [destination.latitude, destination.longitude];
      area.extend(point);
      L.marker(point, { title: "Работа · точка назначения", icon: L.divIcon({ className: "detail-map-pin work-pin", iconSize: [18, 18] }) })
        .bindTooltip(textNode("Работа · точка назначения"), { direction: "top" }).addTo(layer);
    }
    bounds.current = area;
    if (focus.current === "route" && segments.length) map.current?.fitBounds(area, { padding: [24, 24], maxZoom: 16, animate: false });
  }, [latitude, longitude, segments, destination]);

  if (latitude === null || longitude === null) return <section className="detail-section"><h3>На карте</h3><p className="muted">Координаты квартиры не указаны.</p></section>;
  const osm = `https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=16/${latitude}/${longitude}`;
  return <section className="detail-section listing-map-section" aria-label="Расположение и маршрут">
    <div className="listing-map-heading"><h3>На карте</h3><a href={osm} target="_blank" rel="noreferrer" title="Открыть точку в OpenStreetMap"><ExternalLink size={15} /><span>OpenStreetMap</span></a></div>
    {!!item.routes?.alternatives?.length && <div className="segmented commute-options" aria-label="Варианты маршрута">{(["primary", ...item.routes.alternatives.map((option) => option.kind)] as RouteChoice[]).map((option) => <button key={option} aria-pressed={choice === option} className={choice === option ? "selected" : ""} onClick={() => { focus.current = "route"; onChoice(option); }}>{choiceNames[option]}</button>)}</div>}
    <div ref={container} className="listing-detail-map" role="region" aria-label="Карта квартиры" />
    <div className="listing-map-actions">
      {hasRoute ? <>
        <button className="secondary-button" onClick={() => { focus.current = "route"; if (bounds.current) map.current?.fitBounds(bounds.current, { padding: [24, 24], maxZoom: 16 }); }}><RouteIcon size={16} />Весь маршрут</button>
        <button className="icon-button" title="Вернуться к квартире" aria-label="Вернуться к квартире" onClick={() => { focus.current = "home"; map.current?.setView([latitude, longitude], 16); }}><LocateFixed size={17} /></button>
        {(item.routes?.policyVersion !== COMMUTE_VERSION || item.routes.alternativesIncomplete) && <button className="icon-button" title="Пересчитать маршрут" aria-label="Пересчитать маршрут" disabled={waiting} onClick={() => { focus.current = "route"; request.mutate(); }}><RefreshCw size={17} /></button>}
      </> : <button className="secondary-button" disabled={waiting} onClick={() => { focus.current = "route"; request.mutate(); }}><RouteIcon size={16} />{waiting ? "Маршрут рассчитывается" : "Построить маршрут до работы"}</button>}
      {target && <span className="map-trip-duration">{target.durationMinutes} мин до работы</span>}
    </div>
    {hasRoute && <div className="map-route-legend">{[...new Map(segments.map(({ mode, label }) => [label, mode]))].map(([label, mode]) => <span key={label}><i className={mode === "WALK" ? "walk" : "transit"} style={{ borderColor: modeColors[mode] }} />{label}</span>)}</div>}
    {target?.arrivalAt && <p className="muted small">{target.departureAt && `Выход ${minskTime.format(new Date(target.departureAt))} · `}Прибытие {minskTime.format(new Date(target.arrivalAt))}{target.arrivalBufferMinutes !== undefined && ` · Запас ${target.arrivalBufferMinutes} мин до ${target.time}`} · Пешком {target.walkingMinutes} мин · Ожидание {target.waitingMinutes} мин</p>}
    {item.routes?.alternativesIncomplete && <p className="muted small">Часть вариантов маршрута недоступна.</p>}
    {status?.state === "pending" && item.routeQueue && <p className="muted small" role="status">Маршрут: {queueDescription(item.routeQueue)}</p>}
    {!hasRoute && !waiting && <p className="muted small">{status?.state === "ready" ? target?.destination ? "OTP не вернул линию маршрута." : "Для сохранённого маршрута пока нет линии на карте." : status?.message ?? "Маршрут ещё не рассчитан."}</p>}
    {hasRoute && (target?.legs.filter((leg) => leg.durationMinutes > 0).length ?? 0) > segments.length && <p className="muted small">Некоторые участки не нанесены: OTP не вернул их геометрию.</p>}
    {request.error && <p role="alert" className="error-text">{request.error.message}</p>}
    {tileWarning && <p className="muted small">Часть карты не загрузилась.</p>}
  </section>;
}
