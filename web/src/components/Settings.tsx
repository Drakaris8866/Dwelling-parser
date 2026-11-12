import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Save } from "lucide-react";
import { PersonalRankingSettingsForm } from "./PersonalRankingSettingsForm.js";
import { api } from "../api.js";
import { DEFAULT_SETTINGS, settingsSchema, type CatalogSettings } from "../../../src/contracts/catalog.js";

export function Settings() {
  const query = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const client = useQueryClient();
  const [value, setValue] = useState<CatalogSettings>(DEFAULT_SETTINGS);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (query.data) setValue(query.data); }, [query.data]);
  const mutation = useMutation({ mutationFn: api.updateSettings, onSuccess: () => { void client.invalidateQueries({ queryKey: ["settings"] }); void client.invalidateQueries({ queryKey: ["catalog"] }); } });
  const weight = (key: "transportWeight" | "conditionWeight" | "layoutWeight", label: string) => <label className="weight-row"><span>{label}</span><input aria-label={label} type="range" min="0" max="100" value={value[key]} onChange={(e) => setValue({ ...value, [key]: Number(e.target.value) })} /><strong>{value[key]}%</strong></label>;
  return <section className="workspace-page"><h1>Настройки</h1><form className="settings-form" noValidate onSubmit={(event) => { event.preventDefault(); const parsed = settingsSchema.safeParse(value); if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? "Проверьте настройки"); return; } setError(null); mutation.mutate(parsed.data); }}>
    <section className="settings-section"><h2>Работа · точка назначения</h2><div className="settings-coordinate"><label>Широта<input type="number" step="0.000001" value={value.targetLatitude} onChange={(e) => setValue({ ...value, targetLatitude: Number(e.target.value) })} /></label><label>Долгота<input type="number" step="0.000001" value={value.targetLongitude} onChange={(e) => setValue({ ...value, targetLongitude: Number(e.target.value) })} /></label></div><label className="time-field">Прибыть не позже<input type="time" value={value.arrivalTime} onChange={(e) => setValue({ ...value, arrivalTime: e.target.value })} /></label></section>
    <section className="settings-section"><h2>Вес параметров удобства</h2>{weight("transportWeight", "Транспорт")}{weight("conditionWeight", "Состояние квартиры и дома")}{weight("layoutWeight", "Планировка")}<p className={value.transportWeight + value.conditionWeight + value.layoutWeight === 100 ? "muted" : "error-text"}>Сумма: {value.transportWeight + value.conditionWeight + value.layoutWeight}%</p></section>
    {(error || mutation.error || query.error) && <p className="error-text">{error ?? mutation.error?.message ?? query.error?.message}</p>}
    <button className="primary-button" type="submit" disabled={mutation.isPending}><Save size={16} />{mutation.isPending ? "Сохраняем…" : "Сохранить"}</button>{mutation.isSuccess && <span className="saved-confirmation">Сохранено. Переоценка поставлена в очередь.</span>}
  </form><PersonalRankingSettingsForm /></section>;
}
