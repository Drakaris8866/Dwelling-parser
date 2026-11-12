import { Building2, MapPin } from "lucide-react";
import type { Comparable } from "../../../src/contracts/catalog.js";
import { platformLabels, repairLabels } from "../../../src/contracts/labels.js";
import { formatDisplayAddress } from "../utils/addressFormatter.js";
import { money } from "./ListingCard.js";

export function ComparableCard({ item, onOpen }: { item: Comparable; onOpen: (id: string) => void }) {
  const photo = item.photo ?? (item.photos && item.photos.length > 0 ? item.photos[0] : null);
  const displayAddress = formatDisplayAddress(item.address, null, "Адрес не указан");
  const params = [
    item.rooms !== undefined ? `${item.rooms}-комн.` : null,
    `${item.areaSqm} м²`,
    item.floor !== undefined ? `${item.floor}/${item.totalFloors ?? "?"} эт.` : null
  ].filter(Boolean).join(" · ");

  return (
    <article
      className="comparable-card"
      onClick={() => onOpen(item.propertyId)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onOpen(item.propertyId); }}
    >
      <div className="comparable-card-photo">
        {photo ? (
          <img
            src={photo}
            alt={displayAddress}
            loading="lazy"
            onError={(e) => { e.currentTarget.style.display = "none"; }}
          />
        ) : null}
        <Building2 className="comparable-card-fallback" size={28} />
        <span className={`source-badge ${item.platform.toLowerCase()} comparable-badge`}>
          {platformLabels[item.platform]}
        </span>
        <span className="comparable-distance-tag">{item.distanceMeters} м</span>
      </div>
      <div className="comparable-card-body">
        <div className="comparable-card-price">
          <strong>${money(item.priceUsd)}</strong>
          <span className="muted small">${money(item.priceSqm)}/м²</span>
        </div>
        <div className="comparable-card-params">{params || `${item.areaSqm} м²`}</div>
        {(item.repair || item.buildingYear) && (
          <div className="comparable-card-sub muted small">
            {item.repair ? repairLabels[item.repair] : null}
            {item.repair && item.buildingYear ? " · " : null}
            {item.buildingYear ? `${item.buildingYear} г.` : null}
          </div>
        )}
        <div className="comparable-card-address" title={displayAddress}>
          <MapPin size={12} />
          <span>{displayAddress}</span>
        </div>
      </div>
    </article>
  );
}

