import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { duplicateSnapshot } from "../../../src/contracts/duplicateAudit.js";
import { platformLabels } from "../../../src/contracts/labels.js";
import { api } from "../api.js";
import { money } from "./ListingCard.js";
import "../duplicates.css";

export function DuplicateReview({ onOpen }: { onOpen: (id: string) => void }) {
  const [page, setPage] = useState(1), [address, setAddress] = useState(""), [selected, setSelected] = useState<string | null>(null);
  const client = useQueryClient();
  const refresh = (): void => { void client.invalidateQueries({ queryKey: ["duplicates"] }); };
  const query = useQuery({ queryKey: ["duplicates", page, address], queryFn: () => api.duplicates(page, address), refetchInterval: 5000 });
  const scan = useMutation({ mutationFn: api.scanDuplicates, onSuccess: refresh });
  const merge = useMutation({ mutationFn: api.confirmDuplicate, onSuccess: () => {
    setSelected(null); refresh(); void client.invalidateQueries({ queryKey: ["catalog"] }); void client.invalidateQueries({ queryKey: ["detail"] }); void client.invalidateQueries({ queryKey: ["map"] });
  } });
  const error = query.error ?? scan.error ?? merge.error;
  return <section className="workspace-page"><div className="page-heading"><h1>Дубли объявлений</h1><button className="secondary-button" onClick={() => scan.mutate()} disabled={scan.isPending}><RefreshCw size={16} />Обновить проверку</button></div>
    <label className="duplicate-search">Адрес<input maxLength={120} value={address} onChange={(event) => { setAddress(event.target.value); setPage(1); }} /></label>
    {error && <p className="error-text" role="alert">{error.message}</p>}
    {query.data?.scannedAt ? <p className="muted small">{query.data.total.toLocaleString("ru-RU")} пар · {query.data.publications.toLocaleString("ru-RU")} проверенных публикаций · {new Date(query.data.scannedAt).toLocaleString("ru-RU", { timeZone: "Europe/Minsk" })}</p> : <p className="muted">{query.isPending ? "Загрузка…" : "Проверка ещё не завершена"}</p>}
    {query.data?.pairs.map((pair) => {
      const key = `${pair.left.listingId}:${pair.right.listingId}`;
      const confirmation = duplicateSnapshot(pair);
      return <article className="duplicate-pair" key={key}><h2>{pair.address}</h2><p className="muted small">{pair.rooms} комн. · {pair.areaSqm} м² · этаж {pair.floor}</p>
        <div className="duplicate-publications">{[pair.left, pair.right].map((source) => <button className="duplicate-publication" key={source.listingId} onClick={() => onOpen(source.propertyId)}>{source.photo && <img src={source.photo} alt="" loading="lazy" />}<span>{platformLabels[source.platform]} #{source.externalId}<strong>${money(source.priceUsd)}</strong></span></button>)}</div>
        <p className="muted small">{[pair.exactPhotos ? `Общих оригиналов фото: ${pair.exactPhotos}` : null, pair.structured ? "Совпадают координаты, цена и параметры квартиры" : null, pair.sameDescription ? "Совпадает описание" : null].filter(Boolean).join(" · ") || "Совпадают адрес, этаж, комнаты, площадь и цена; доказательств недостаточно"}</p>
        {pair.structured || pair.exactPhotos >= 3 ? <div className="duplicate-actions">{selected === confirmation ? <><button className="primary-button" disabled={merge.isPending} onClick={() => merge.mutate(pair)}>Подтвердить объединение</button><button className="secondary-button" disabled={merge.isPending} onClick={() => setSelected(null)}>Отмена</button></> : <button className="secondary-button" disabled={merge.isPending} onClick={() => { merge.reset(); setSelected(confirmation); }}>Объединить</button>}</div> : null}
      </article>;
    })}
    {query.data && <div className="pagination"><button className="icon-button" title="Предыдущая страница" disabled={page === 1} onClick={() => setPage(page - 1)}><ChevronLeft size={18} /></button><span>{page} / {query.data.pages}</span><button className="icon-button" title="Следующая страница" disabled={page >= query.data.pages} onClick={() => setPage(page + 1)}><ChevronRight size={18} /></button></div>}
  </section>;
}
