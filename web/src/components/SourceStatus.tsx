import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { api } from "../api.js";
import { platformLabels } from "../../../src/contracts/labels.js";
const statusLabels: Readonly<Record<string, string>> = { COMPLETE: "Сбор завершён", RUNNING: "Идёт сбор", BLOCKED: "Доступ ограничен", PARTIAL: "Неполный сбор", FAILED: "Ошибка", NOT_STARTED: "Ещё не запускался" };
const taskLabels: Readonly<Record<string, string>> = {
  "collect-kufar": "Сбор объявлений · Куфар",
  "collect-onliner": "Сбор объявлений · Онлайнер",
  "collect-realt": "Сбор объявлений · Realt",
  "enrich-kufar": "Обновление карточек · Куфар",
  "enrich-onliner": "Обновление карточек · Онлайнер",
  "enrich-realt": "Обновление карточек · Realt",
  enrich: "Обновление карточек",
  duplicate: "Проверка и объединение дублей",
  "duplicate-audit": "Поиск возможных дублей",
  route: "Расчёт маршрутов",
  "route-refresh": "Обновление фоновых очередей",
  assess: "Пересчёт оценок квартир",
  notify: "Отправка уведомлений",
  "photo-repair": "Анализ ремонта по фото"
};
export function SourceStatus() {
  const query = useQuery({ queryKey: ["health"], queryFn: api.health });
  const client = useQueryClient();
  const sync = useMutation({ mutationFn: api.sync, onSuccess: () => { void client.invalidateQueries({ queryKey: ["health"] }); } });
  return <section className="workspace-page">
    <div className="page-heading"><h1>Состояние сбора</h1><button className="secondary-button" disabled={sync.isPending} onClick={() => sync.mutate()}><RefreshCw size={16} />Проверить площадки</button></div>
    {sync.error && <p className="error-text">{sync.error.message}</p>}
    <section className="source-section background-tasks" aria-labelledby="background-tasks-title">
      <h2 id="background-tasks-title">Фоновые задачи</h2>
      {query.error && <p className="error-text" role="status">
        {query.data ? "Не удалось обновить данные. Показаны последние полученные значения." : "Не удалось загрузить фоновые задачи."}
        {" "}<button className="text-link" onClick={() => { void query.refetch(); }}>Повторить</button>
      </p>}
      {query.isPending && <p className="muted">Проверяем фоновые задачи…</p>}
      {query.data?.tasks.length === 0 && <p className="muted">Фоновых задач нет.</p>}
      {!!query.data?.tasks.length && <table aria-labelledby="background-tasks-title">
        <thead><tr><th scope="col">Действие</th><th scope="col">В работе</th><th scope="col">В очереди</th></tr></thead>
        <tbody>{query.data.tasks.map(({ name, active, queued }) => <tr key={name}>
          <th scope="row">{taskLabels[name] ?? name}</th>
          <td className={active > 0 ? "running-tasks" : undefined}>{active.toLocaleString("ru-RU")}</td>
          <td>{queued.toLocaleString("ru-RU")}</td>
        </tr>)}</tbody>
      </table>}
    </section>
    <div className="status-summary"><span className={`status-dot ${query.data?.otp.available ? "ok" : "warn"}`} />{query.data?.otp.message ?? (query.error ? "Состояние маршрутизации неизвестно" : "Проверяем подключения…")}</div>
    {query.data?.sources.map((source) => <section className="source-section" key={source.platform}>
      <div className="page-heading"><h2>{platformLabels[source.platform]}</h2><span className={`status-label ${source.status.toLowerCase()}`}>{statusLabels[source.status] ?? source.status}</span></div>
      <p className="muted">Сейчас в базе: квартир {source.catalogAccepted.toLocaleString("ru-RU")} · на проверке {source.catalogReview.toLocaleString("ru-RU")} · исключено {source.catalogExcluded.toLocaleString("ru-RU")}</p>
      <dl className="source-counters">
        {[['Страниц обхода', source.pages], ['Получено', source.received], ['Допущено при сборе', source.accepted], ['Проверка', source.review], ['Исключено', source.excluded], ['Ошибки данных', source.invalid], ['Ошибки карточек', source.detailErrors]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
      </dl>
      {source.error && <p className="source-error">{source.error}</p>}
      {Object.entries(source.reasons).map(([reason, count]) => <div className="reason-count" key={reason}><span>{reason}</span><strong>{count}</strong></div>)}
      <p className="muted small">{source.startedAt ? `Начало: ${new Date(source.startedAt).toLocaleString("ru-RU")}` : ""}{source.finishedAt ? ` · Завершение: ${new Date(source.finishedAt).toLocaleString("ru-RU")}` : ""}</p>
      <p className="muted small">Последний успешный обход: {source.lastSuccessfulAt ? new Date(source.lastSuccessfulAt).toLocaleString("ru-RU") : "Пока нет"}</p>
    </section>)}
  </section>;
}
