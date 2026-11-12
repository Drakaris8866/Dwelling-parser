import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { personalRankingSettingsSchema, type PersonalRankingSettings } from "../../../src/contracts/personalRanking.js";
import { api } from "../api.js";
import "../personalRanking.css";

const today = (): string => new Date().toISOString().slice(0, 10);
const numeric = (value: number | undefined): number | string => value !== undefined && Number.isFinite(value) ? value : "";

function RankingSettingsEditor({ initial }: { initial: PersonalRankingSettings }) {
  const client = useQueryClient();
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const [invalidFields, setInvalidFields] = useState<string[]>([]);
  const attributes = (path: string) => ({ name: path, "aria-invalid": invalidFields.some((field) => path === field || path.startsWith(field + ".")) || undefined, "aria-describedby": error ? "ranking-settings-error" : undefined });
  const mutation = useMutation({ mutationFn: api.updatePersonalRankingSettings, onSuccess: (saved) => {
    setValue(saved);
    client.setQueryData(["personal-ranking-settings"], saved);
    void client.invalidateQueries({ queryKey: ["personal-ranking"] });
  } });
  const update = (next: PersonalRankingSettings): void => { setValue(next); setError(null); setInvalidFields([]); mutation.reset(); };
  const rangeField = (kind: "labor" | "materials", label: string) => <fieldset className="ranking-range"><legend>{label}, BYN/м²</legend>{(["low", "base", "high"] as const).map((key, index) => <label key={key}>{["Минимум", "База", "Максимум"][index]}<input {...attributes(`rates.${kind}.${key}`)} type="number" min="0" step="any" required value={numeric(value.rates?.[kind][key])} onChange={(event) => { if (value.rates) update({ ...value, rates: { ...value.rates, [kind]: { ...value.rates[kind], [key]: event.target.valueAsNumber } } }); }} /></label>)}</fieldset>;
  return <form ref={form} className="settings-form personal-ranking-settings" noValidate onSubmit={(event) => {
    event.preventDefault();
    const parsed = personalRankingSettingsSchema.safeParse(value);
    if (!parsed.success) {
      setError(parsed.error.issues.some((issue) => issue.path[0] === "minimumComparables")
        ? "Минимум аналогов — целое число от 3 до 20."
        : "Проверьте значения: диапазоны должны идти от минимума к максимуму, даты — ГГГГ-ММ-ДД, источник обязателен.");
      const paths = parsed.error.issues.map((issue) => issue.path.join("."));
      setInvalidFields(paths);
      const inputs = Array.from(form.current?.querySelectorAll<HTMLInputElement>("input[name]") ?? []);
      inputs.find((input) => paths.some((path) => input.name === path || input.name.startsWith(path + ".")))?.focus();
      return;
    }
    setError(null); setInvalidFields([]); mutation.mutate(parsed.data);
  }}>
    <section className="settings-section"><h2>Персональный рейтинг · предпросмотр</h2><p className="ranking-help">Покупка и ремонт сравниваются с местными готовыми квартирами. Сохранение настроек не запускает расчёты и не меняет порядок каталога.</p>
      <label className="check ranking-check"><input type="checkbox" checked={value.previewEnabled} onChange={(event) => update({ ...value, previewEnabled: event.target.checked })} />Показывать сохранённые расчёты</label>
      <label className="ranking-field">Минимум аналогов<input {...attributes("minimumComparables")} type="number" min="3" max="20" step="1" required value={numeric(value.minimumComparables ?? 5)} onChange={(event) => update({ ...value, minimumComparables: event.target.valueAsNumber })} /></label>
      <p className="ranking-help">От 3 до 20 разных квартир. При небольшом числе аналогов оценка менее устойчива. Изменение применяется после сохранения настроек и нового пробного расчёта.</p>
      <label className="check ranking-check"><input type="checkbox" checked={value.zeroBudgetForFinishedRepair ?? false} onChange={(event) => update({ ...value, zeroBudgetForFinishedRepair: event.target.checked })} />Бюджет ремонта готовой квартиры с отделкой — 0 USD</label>
      <p className="ranking-help">Правило применяется к косметическому, хорошему и дизайнерскому ремонту при готовности к проживанию. Неизвестное состояние не считается готовым. Ручной бюджет квартиры имеет приоритет.</p>
      <fieldset className="ranking-choice"><legend>Выбранный уровень ремонта</legend>{(["good", "designer"] as const).map((level) => <label key={level}><input type="radio" name="ranking-target" value={level} checked={value.targetLevel === level} onChange={() => update({ ...value, targetLevel: level })} />{level === "good" ? "Хороший" : "Дизайнерский"}</label>)}</fieldset>
      <label className="ranking-field">Резерв на ремонт, %<input {...attributes("reservePct")} type="number" min="0" max="100" step="any" required value={numeric(value.reservePct)} onChange={(event) => update({ ...value, reservePct: event.target.valueAsNumber })} /></label>
      <label className="check ranking-check"><input type="checkbox" checked={Boolean(value.usdRate)} onChange={(event) => update(event.target.checked ? { ...value, usdRate: { usdPerSqm: NaN, scope: "full", observedOn: today(), source: "" } } : { ...value, usdRate: undefined })} />Задать стоимость ремонта в USD/м²</label>
      {value.usdRate && <div className="ranking-settings-fields">
        <label className="ranking-field">Стоимость ремонта, USD/м²<input {...attributes("usdRate.usdPerSqm")} type="number" min="0.01" step="any" required value={numeric(value.usdRate.usdPerSqm)} onChange={(event) => { if (value.usdRate) update({ ...value, usdRate: { ...value.usdRate, usdPerSqm: event.target.valueAsNumber } }); }} /></label>
        <fieldset className="ranking-choice"><legend>Объём работ по ставке USD</legend>{(["full", "cosmetic"] as const).map((scope) => <label key={scope}><input type="radio" name="ranking-usd-scope" checked={value.usdRate?.scope === scope} onChange={() => { if (value.usdRate) update({ ...value, usdRate: { ...value.usdRate, scope } }); }} />{scope === "full" ? "Полный ремонт" : "Косметический"}</label>)}</fieldset>
        <label className="ranking-field">Дата ставки USD, ГГГГ-ММ-ДД<input {...attributes("usdRate.observedOn")} type="text" inputMode="numeric" required pattern="[0-9]{4}-[0-9]{2}-[0-9]{2}" value={value.usdRate.observedOn} onChange={(event) => { if (value.usdRate) update({ ...value, usdRate: { ...value.usdRate, observedOn: event.target.value } }); }} /></label>
        <label className="ranking-field">Источник ставки USD<input {...attributes("usdRate.source")} required maxLength={300} value={value.usdRate.source} onChange={(event) => { if (value.usdRate) update({ ...value, usdRate: { ...value.usdRate, source: event.target.value } }); }} /></label>
        <p className="ranking-help">Ставка включает работы и материалы. Бюджет: площадь × ставка × (1 + резерв / 100). При резерве 0% к ставке ничего не добавляется. Курс валют не применяется. Для выбранного объёма работ ставка USD имеет приоритет перед ставками BYN.</p>
      </div>}
      <label className="check ranking-check"><input type="checkbox" checked={Boolean(value.rates)} onChange={(event) => update(event.target.checked ? { ...value, rates: { scope: "full", labor: { low: NaN, base: NaN, high: NaN }, materials: { low: NaN, base: NaN, high: NaN }, observedOn: today(), source: "" } } : { ...value, rates: undefined })} />Задать ставки ремонта</label>
      {value.rates && <div className="ranking-settings-fields"><fieldset className="ranking-choice"><legend>Объём работ</legend>{(["full", "cosmetic"] as const).map((scope) => <label key={scope}><input type="radio" name="ranking-scope" checked={value.rates?.scope === scope} onChange={() => { if (value.rates) update({ ...value, rates: { ...value.rates, scope } }); }} />{scope === "full" ? "Полный ремонт" : "Косметический"}</label>)}</fieldset>{rangeField("labor", "Работы")}{rangeField("materials", "Материалы")}
        <label className="ranking-field">Дата ставок, ГГГГ-ММ-ДД<input {...attributes("rates.observedOn")} type="text" inputMode="numeric" required pattern="[0-9]{4}-[0-9]{2}-[0-9]{2}" value={value.rates.observedOn} onChange={(event) => { if (value.rates) update({ ...value, rates: { ...value.rates, observedOn: event.target.value } }); }} /></label>
        <label className="ranking-field">Источник ставок<input {...attributes("rates.source")} required maxLength={300} value={value.rates.source} onChange={(event) => { if (value.rates) update({ ...value, rates: { ...value.rates, source: event.target.value } }); }} /></label>
      </div>}
      <label className="check ranking-check"><input type="checkbox" checked={Boolean(value.fx)} onChange={(event) => update(event.target.checked ? { ...value, fx: { bynPerUsd: NaN, observedOn: today(), source: "" } } : { ...value, fx: undefined })} />Задать подтверждённый курс BYN/USD</label>
      {value.fx && <div className="ranking-settings-fields"><label className="ranking-field">BYN за 1 USD<input {...attributes("fx.bynPerUsd")} required type="number" min="0.000001" step="any" value={numeric(value.fx.bynPerUsd)} onChange={(event) => { if (value.fx) update({ ...value, fx: { ...value.fx, bynPerUsd: event.target.valueAsNumber } }); }} /></label>
        <label className="ranking-field">Дата курса, ГГГГ-ММ-ДД<input {...attributes("fx.observedOn")} type="text" inputMode="numeric" required pattern="[0-9]{4}-[0-9]{2}-[0-9]{2}" value={value.fx.observedOn} onChange={(event) => { if (value.fx) update({ ...value, fx: { ...value.fx, observedOn: event.target.value } }); }} /></label>
        <label className="ranking-field">Источник курса<input {...attributes("fx.source")} required maxLength={300} value={value.fx.source} onChange={(event) => { if (value.fx) update({ ...value, fx: { ...value.fx, source: event.target.value } }); }} /></label>
      </div>}
      <p className="ranking-help">Без ставок или подтверждённого состояния бюджет остаётся неизвестным. Курс старше семи дней не используется для перевода в USD. Ручной бюджет квартиры заменяет расчёт по ставкам.</p>
    </section>
    <div className="ranking-feedback" aria-live="polite">{(error || mutation.error) && <p id="ranking-settings-error" className="error-text" role="alert">{error ?? mutation.error?.message}</p>}{mutation.isSuccess && <p className="saved-confirmation">Настройки персонального рейтинга сохранены.</p>}</div>
    <button className="primary-button ranking-save" type="submit" disabled={mutation.isPending}>{mutation.isPending ? "Сохраняем настройки…" : "Сохранить настройки рейтинга"}</button>
  </form>;
}

export function PersonalRankingSettingsForm() {
  const query = useQuery({ queryKey: ["personal-ranking-settings"], queryFn: api.personalRankingSettings });
  if (query.isPending) return <section className="settings-section personal-ranking-settings" role="status">Загружаем настройки персонального рейтинга…</section>;
  if (query.error) return <section className="settings-section personal-ranking-settings" role="alert"><p>Не удалось загрузить настройки рейтинга: {query.error.message}</p><button className="secondary-button" onClick={() => { void query.refetch(); }}>Повторить загрузку настроек</button></section>;
  return <RankingSettingsEditor initial={query.data} />;
}
