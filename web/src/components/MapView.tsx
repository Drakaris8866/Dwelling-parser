import { useEffect, useRef } from "react";
import L from "leaflet";
import type { CatalogFilters, MapResult } from "../../../src/contracts/catalog.js";
import { money } from "./ListingCard.js";
import { openStreetMapTiles } from "../mapTiles.js";

export function MapView({ data, onOpen, onViewport, onCluster }: { data: MapResult | undefined; onOpen: (id: string) => void; onViewport: (zoom: number, bounds: NonNullable<CatalogFilters["bounds"]>) => void; onCluster: (bounds: NonNullable<CatalogFilters["bounds"]>) => void }) {
  const container = useRef<HTMLDivElement>(null), map = useRef<L.Map | null>(null), layer = useRef<L.LayerGroup | null>(null);
  const callbacks = useRef({ onOpen, onViewport, onCluster });
  callbacks.current = { onOpen, onViewport, onCluster };
  useEffect(() => {
    if (!container.current) return;
    const instance = L.map(container.current, { preferCanvas: true, zoomControl: true }).setView([53.91, 27.56], 11);
    map.current = instance; layer.current = L.layerGroup().addTo(instance);
    openStreetMapTiles().addTo(instance);
    const moved = (): void => { const bounds = instance.getBounds(); callbacks.current.onViewport(instance.getZoom(), { south: bounds.getSouth(), north: bounds.getNorth(), west: bounds.getWest(), east: bounds.getEast() }); };
    instance.on("moveend", moved); moved();
    const resize = new ResizeObserver(() => instance.invalidateSize()); resize.observe(container.current);
    return () => { resize.disconnect(); instance.remove(); map.current = null; };
  }, []);
  useEffect(() => {
    const group = layer.current;
    if (!group) return;
    group.clearLayers();
    for (const point of data?.points ?? []) {
      const marker = L.circleMarker([point.latitude, point.longitude], { radius: point.count > 1 ? 16 : 8, color: "#fff", weight: 2, fillColor: point.count > 1 ? "#2864a2" : "#197557", fillOpacity: 0.95 });
      const label = document.createElement("span"); label.textContent = point.count > 1 ? `${point.count} квартир · от $${money(point.minPrice)}` : `$${money(point.minPrice)}`;
      if (point.count > 1) { const count = document.createElement("span"); count.textContent = String(point.count); marker.bindTooltip(count, { permanent: true, className: "cluster-count", direction: "center" }); }
      else marker.bindTooltip(label, { direction: "top" });
      marker.on("click", () => {
        if (point.propertyId) callbacks.current.onOpen(point.propertyId);
        else if ((map.current?.getZoom() ?? 11) >= 17 || point.bounds.north - point.bounds.south < 0.00005) callbacks.current.onCluster({ south: point.bounds.south - 0.00001, north: point.bounds.north + 0.00001, west: point.bounds.west - 0.00001, east: point.bounds.east + 0.00001 });
        else map.current?.fitBounds([[point.bounds.south, point.bounds.west], [point.bounds.north, point.bounds.east]], { maxZoom: 18, padding: [50, 50] });
      });
      marker.addTo(group);
    }
  }, [data]);
  return <div className="map-shell"><div ref={container} className="property-map" /><div className="map-caption">На карте: {data?.located ?? 0} из {data?.total ?? 0}</div></div>;
}
