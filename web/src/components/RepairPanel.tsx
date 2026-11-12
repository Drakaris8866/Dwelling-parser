import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ScanLine } from "lucide-react";
import type { CatalogDetail } from "../../../src/contracts/catalog.js";
import { buildingConditionLabels, repairLabels } from "../../../src/contracts/labels.js";
import { PHOTO_PROMPT_VERSION, renovationBudgetSchema, type PhotoDecision, type PhotoObservation } from "../../../src/contracts/photoRepair.js";
import { api } from "../api.js";

const sceneLabels: Readonly<Record<PhotoObservation["scene"], string>> = {
  interior: "Квартира", exterior: "Фасад", "common-area": "Подъезд", "floor-plan": "Планировка", render: "Рендер", unclear: "Неразборчивый снимок"
};

export function RepairPanel({ detail }: { detail: CatalogDetail }) {
  const { item, photoRepair: result } = detail, client = useQueryClient();
  const refresh = (): void => { void client.invalidateQueries({ queryKey: ["detail", item.id] }); void client.invalidateQueries({ queryKey: ["catalog"] }); };
  const request = useMutation({ mutationFn: () => api.analyzePhotos(item.id), onSuccess: refresh });
  const decision = useMutation({ mutationFn: (value: PhotoDecision) => api.reviewPhotos(item.id, value), onSuccess: refresh });
  const busy = request.isPending || result?.status === "QUEUED" || result?.status === "RUNNING";
  const outdated = !!result && (result.promptVersion ?? 0) < PHOTO_PROMPT_VERSION;
  const complete = result?.status === "READY" || result?.status === "INSUFFICIENT";
  const unknown = result?.status === "STALE" ? "Фото изменились" : busy ? "Анализируется" : complete ? "Недостаточно данных" : "Нет оценки";
  return <section className="detail-section repair-panel"><h3>Квартира и дом по фото</h3>
    <dl className="price-evidence repair-facts"><div><dt>Ремонт по объявлению</dt><dd>{item.features.repair ? repairLabels[item.features.repair] : "Не указан"}</dd></div>
      <div><dt>Ремонт по фото</dt><dd>{complete && result.suggestion ? repairLabels[result.suggestion] : unknown}</dd></div>
      <div><dt>Фасад по фото</dt><dd>{complete && result.buildingSuggestion ? buildingConditionLabels[result.buildingSuggestion] : outdated && complete ? "Нужен новый анализ" : unknown}</dd></div></dl>
    {result?.status === "READY" && result.decision === "APPROVED" && <p className="muted small">{result.repairNeedsConfirmation ? "Фасад подтверждён. Ремонт ожидает подтверждения." : "Подтверждённые категории используются в выгодности и удобстве."}</p>}
    {outdated && complete && result.decision === "APPROVED" && <p className="muted small">Для нового анализа сначала отмените прежнее подтверждение.</p>}
    {result?.status === "READY" && result.decision === "REJECTED" && <p className="muted small">Результат отклонён.</p>}
    {result?.status !== "STALE" && result?.message && <p className="muted small">{result.message}</p>}
    {result?.status !== "STALE" && !!result?.evidence.length && <details className="assessment-disclosure"><summary>Наблюдения по снимкам</summary>
      <ul className="reason-list">{result.evidence.map((photo) => {
        const position = item.photos.indexOf(photo.photoUrl);
        const category = photo.scene === "exterior" && photo.buildingCondition ? buildingConditionLabels[photo.buildingCondition] : photo.scene === "interior" && photo.condition ? repairLabels[photo.condition] : null;
        return <li key={photo.photoUrl}><a href={photo.photoUrl} target="_blank" rel="noreferrer">{position >= 0 ? `Снимок ${position + 1}` : "Снимок"}</a>: {sceneLabels[photo.scene]}{category ? ` · ${category}` : ""}{photo.observations.length ? `. ${photo.observations.join("; ")}` : ""}</li>;
      })}</ul>
    </details>}
    <div className="listing-map-actions">
      {result?.status === "READY" && result.repairNeedsConfirmation && <button className="primary-button" disabled={decision.isPending} onClick={() => decision.mutate({ analysisId: result.id, decision: "APPROVED", confirmRepair: true })}>Подтвердить ремонт</button>}
      {(!result || busy || result.status === "FAILED" || result.status === "STALE" || (outdated && result.decision !== "APPROVED")) && <button className="secondary-button" disabled={busy || !detail.photoRepairAvailable || !item.photos.length} onClick={() => request.mutate()}><ScanLine size={16} />{busy ? "Анализ фото в работе" : outdated && complete ? "Переоценить квартиру и дом" : "Оценить квартиру и дом по фото"}</button>}
      {result?.status === "READY" && (result.suggestion || result.buildingSuggestion) && (result.decision === "APPROVED" ? <button className="secondary-button" disabled={decision.isPending} onClick={() => decision.mutate({ analysisId: result.id, decision: "PENDING" })}>Отменить подтверждение</button>
        : <><button className="primary-button" disabled={decision.isPending} onClick={() => decision.mutate({ analysisId: result.id, decision: "APPROVED" })}>Подтвердить для оценок</button>
          {result.decision !== "REJECTED" && <button className="secondary-button" disabled={decision.isPending} onClick={() => decision.mutate({ analysisId: result.id, decision: "REJECTED" })}>Отклонить</button>}</>)}
    </div>
    {!detail.photoRepairAvailable && <p className="muted small">Локальный анализ Ollama не включён.</p>}
    {(request.error || decision.error) && <p className="error-text" role="alert">{request.error?.message ?? decision.error?.message}</p>}
  </section>;
}

export function RenovationBudget({ detail }: { detail: CatalogDetail }) {
  const { item } = detail, client = useQueryClient();
  const saved = item.renovationBudgetUsd;
  const [draft, setDraft] = useState(saved == null ? "" : String(saved));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => { setDraft(saved == null ? "" : String(saved)); setInvalid(false); }, [item.id, saved]);
  const mutation = useMutation({ mutationFn: (budget: number | null) => api.renovationBudget(item.id, budget), onSuccess: () => { void client.invalidateQueries({ queryKey: ["detail", item.id] }); } });
  return <form className="renovation-budget" onSubmit={(event) => {
    event.preventDefault();
    const parsed = renovationBudgetSchema.safeParse({ budgetUsd: draft === "" ? null : Number(draft) });
    setInvalid(!parsed.success);
    if (parsed.success) mutation.mutate(parsed.data.budgetUsd);
  }}><label>Ваш бюджет ремонта, $<input type="number" step="0.01" min="0" max="999999999.99" value={draft} onChange={(event) => setDraft(event.target.value)} /></label>
    <button type="submit" className="secondary-button" disabled={mutation.isPending}>Сохранить бюджет</button>
    {(invalid || mutation.error) && <p className="error-text" role="alert">{mutation.error?.message ?? "Укажите неотрицательную сумму с точностью до центов."}</p>}
  </form>;
}
