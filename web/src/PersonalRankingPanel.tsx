import { useQuery } from "@tanstack/react-query";
import { api } from "./api.js";
import type { MoneyRange } from "../../src/contracts/personalRanking.js";
import "./personalRanking.css";

const number = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 });
const range = (value: MoneyRange, currency: string): string => `${number.format(value.low)}–${number.format(value.high)} ${currency}`;
const reasons: Readonly<Record<string, string>> = {
  ineligible: "Объект не прошёл отбор", "missing-budget": "Бюджет ремонта неизвестен",
  "insufficient-comparables": "Недостаточно подходящих местных аналогов", "invalid-input": "Недостаточно проверенных данных",
  "unknown-condition": "Состояние квартиры не подтверждено", "missing-rates": "Не заданы ставки ремонта",
  "future-rates": "Дата ставок ещё не наступила", "missing-fx": "Курс BYN/USD не задан", "stale-fx": "Курс BYN/USD устарел", "invalid-fx": "Курс BYN/USD не подтверждён"
};
const components: Readonly<Record<string, string>> = { money: "Полная стоимость", house: "Дом", commute: "Поездка", location: "Расположение", layout: "Планировка" };
const rejectionLabels: Readonly<Record<string, string>> = {
  self: "Сам объект", inactive: "Неактивные", disposition: "Не прошли отбор", disputedPrice: "Спорная цена", invalidTimestamp: "Нет даты", stale: "Устарели", future: "Дата в будущем", invalidPrice: "Некорректная цена",
  locality: "Другой населённый пункт", marketZone: "Другая зона", rooms: "Другое число комнат", studio: "Другой тип квартиры", floorClass: "Другая этажность", area: "Другая площадь", year: "Другой год постройки", material: "Другой материал дома", layout: "Другая планировка", repair: "Другой ремонт", readiness: "Не готовы к проживанию", distance: "За радиусом", duplicate: "Повторная публикация"
};

export function PersonalRankingPanel({ listingId }: { listingId: string }) {
  const query = useQuery({ queryKey: ["personal-ranking", listingId], queryFn: () => api.personalRanking(listingId) });
  const snapshot = query.data?.snapshot;
  return <section className="detail-section personal-ranking-panel" aria-labelledby="personal-ranking-title" aria-busy={query.isPending}>
    <h3 id="personal-ranking-title">Персональный рейтинг</h3>
    {query.isPending ? <p className="ranking-state" role="status">Загружаем сохранённый расчёт…</p>
      : query.error ? <div className="ranking-state" role="alert"><p>Не удалось загрузить расчёт: {query.error.message}</p><button className="secondary-button" onClick={() => { void query.refetch(); }}>Повторить загрузку</button></div>
      : query.data?.status === "disabled" ? <p className="ranking-state">Предпросмотр выключен. Его можно включить в настройках персонального рейтинга.</p>
      : !snapshot ? <p className="ranking-state">Сохранённого расчёта пока нет. Он появится после отдельного пробного расчёта выбранных квартир.</p>
      : <>
        {query.data?.status === "stale" && <p className="ranking-notice" role="status">Расчёт устарел: данные или настройки изменились. Ниже показан прежний результат; нужен новый пробный расчёт.</p>}
        {snapshot.result.provisional && <p className="ranking-notice">Предварительный расчёт — часть данных неизвестна или выборка аналогов невелика.</p>}
        <dl className="ranking-budget">
          <div><dt>Покупка</dt><dd>{number.format(snapshot.purchaseUsd)} USD</dd></div>
          <div><dt>Ремонт</dt><dd>{snapshot.renovation.status === "known" ? snapshot.renovation.usd ? range(snapshot.renovation.usd, "USD") : snapshot.renovation.byn ? range(snapshot.renovation.byn, "BYN") : "Неизвестно" : reasons[snapshot.renovation.reason] ?? "Неизвестно"}</dd></div>
          <div className="ranking-total"><dt>Покупка и ремонт</dt><dd>{snapshot.result.totalUsd ? range(snapshot.result.totalUsd, "USD") : "Полный бюджет неизвестен"}</dd></div>
        </dl>
        {snapshot.renovation.status === "known" && <p>{snapshot.renovation.source === "manual" ? "Указан ручной бюджет ремонта; он заменяет расчёт по ставкам." : snapshot.renovation.source === "user-rule" ? "Бюджет ремонта принят равным 0 USD по вашему правилу для готовой квартиры с отделкой." : snapshot.renovation.source === "not-needed" ? "Подтверждено соответствие выбранному уровню ремонта." : snapshot.renovation.source === "usd-rate" ? `Ставка: ${number.format(snapshot.renovation.usdRate!.usdPerSqm)} USD/м², ${snapshot.renovation.usdRate!.scope === "full" ? "полный ремонт" : "косметический ремонт"}. Источник: ${snapshot.renovation.usdRate!.source}, ${snapshot.renovation.usdRate!.observedOn}. Резерв: ${number.format(snapshot.settings.reservePct)}%. Курс валют не применяется.` : `Ставки: ${snapshot.renovation.rates?.source}, ${snapshot.renovation.rates?.observedOn}.`}
          {snapshot.renovation.fx && ` Курс: ${number.format(snapshot.renovation.fx.bynPerUsd)} BYN/USD, ${snapshot.renovation.fx.observedOn}, ${snapshot.renovation.fx.source}.`}
          {snapshot.renovation.usdUnavailable && ` ${reasons[snapshot.renovation.usdUnavailable]}.`}</p>}
        <p className="ranking-score">{snapshot.result.score === null ? snapshot.result.reason === "insufficient-comparables" ? `Для оценки нужно не менее ${snapshot.settings.minimumComparables ?? 5} подходящих местных аналогов.` : reasons[snapshot.result.reason ?? "invalid-input"] : <>Итоговый балл: <strong>{number.format(snapshot.result.score)} / 100</strong></>}</p>
        <p>Минимум аналогов в этом расчёте: {snapshot.settings.minimumComparables ?? 5}.</p>
        <p>Покрытие данных: {number.format(snapshot.result.coverage)}%. Неизвестные признаки не дают преимущества.</p>
        <div className="table-scroll"><table className="ranking-table"><caption>Состав персонального балла</caption><thead><tr><th scope="col">Критерий</th><th scope="col">Вес</th><th scope="col">Оценка</th></tr></thead><tbody>{snapshot.result.breakdown.map((row) => <tr key={row.key}><th scope="row">{components[row.key]}</th><td>{row.weight}%</td><td>{row.observed === null ? "Неизвестно" : number.format(row.observed)}</td></tr>)}</tbody></table></div>
        <p>Рыночная оценка «как есть»: {snapshot.result.asIsScore === null ? "недостаточно аналогов" : `${number.format(snapshot.result.asIsScore)} / 100`}. Она показана отдельно и не добавляется к денежной части повторно.</p>
        {snapshot.result.readyMedianUsdSqm !== null && <p>Ориентир готовых аналогов: {number.format(snapshot.result.readyMedianUsdSqm)} USD/м².</p>}
        <p>Диапазон — ориентир, а не смета или цена сделки. При пересечении бюджетов преимущество не гарантировано.</p>
        <details className="ranking-evidence"><summary>Аналоги и причины отбора</summary>
          {[{ label: "Как есть", rows: snapshot.asIsComparables, rejected: snapshot.rejections.asIs }, { label: "Готовые", rows: snapshot.readyComparables, rejected: snapshot.rejections.ready }].map(({ label, rows, rejected }) => <div key={label}><h4>{label}: {rows.length}</h4>{rows.length > 0 && <ul>{rows.map((row) => <li key={row.propertyId}>{row.address || row.externalId} · {number.format(row.priceUsd)} USD · {number.format(row.distanceMeters)} м · {row.platform}</li>)}</ul>}<p>Причины отказа: {Object.entries(rejected).filter(([, count]) => count > 0).map(([key, count]) => `${rejectionLabels[key] ?? key}: ${count}`).join("; ") || "нет"}.</p></div>)}
          {snapshot.priceEvidence.some((row) => row.disputed) && <p>Спорные цены исключены. Источники: {snapshot.priceEvidence.filter((row) => row.disputed).flatMap((row) => row.publications.map((source) => `${source.platform} ${source.externalId}: ${number.format(source.priceUsd)} USD`)).join("; ")}.</p>}
        </details>
        <p className="ranking-meta">Расчёт от {new Date(snapshot.calculatedAt).toLocaleString("ru-RU")}. Правила: {snapshot.result.version}. Настройки: {snapshot.settingsVersion}.</p>
      </>}
  </section>;
}

export default PersonalRankingPanel;
