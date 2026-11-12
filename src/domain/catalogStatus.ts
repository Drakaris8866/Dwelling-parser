import type { CatalogAssessment, CatalogProcessing, RoutingData } from "../contracts/catalog.js";

type StatusInput = {
  readonly assessment: CatalogAssessment | null; readonly routes: RoutingData | null;
  readonly routeStatus: string; readonly routeError: string | null; readonly assessmentError: string | null;
  readonly hasCoordinates: boolean; readonly disposition: string;
};
export const catalogProcessing = (input: StatusInput): CatalogProcessing => {
  const a = input.assessment;
  const route: CatalogProcessing["route"] = !input.hasCoordinates ? { state: "missing-coordinates", message: "Нет координат для расчёта маршрута" }
    : input.routeStatus === "FAILED" ? { state: "failed", message: input.routeError ?? "Ошибка OTP; расчёт будет повторён" }
    : input.routeStatus === "NO_ROUTE" ? { state: "no-route", message: "OTP не нашёл маршрут до текущей точки" }
    : input.routeStatus === "RUNNING" ? { state: "running", message: "Рассчитывается маршрут OTP" }
    : input.routeStatus !== "PENDING" && input.routes?.target ? { state: "ready", message: "Маршрут рассчитан" }
    : { state: "pending", message: "Маршрут ожидает расчёта" };
  const pending = { state: "pending", message: "Оценка ожидает расчёта" } as const;
  const failed = { state: "failed", message: input.assessmentError ?? "Не удалось рассчитать оценку" } as const;
  const value: CatalogProcessing["value"] = input.disposition !== "ACCEPTED" ? { state: "review", message: "Объект требует проверки и не участвует в оценке рынка" }
    : input.assessmentError ? failed : a?.valueScore !== null && a?.valueScore !== undefined ? { state: "ready", message: "Выгодность рассчитана по сопоставимым предложениям" }
    : a ? { state: "insufficient", message: !input.hasCoordinates ? "Нет координат для подбора местных аналогов" : `Найдено ${a.comparableCount} сопоставимых предложений; требуется минимум 5 с подтверждёнными характеристиками` } : pending;
  const comfort: CatalogProcessing["comfort"] = input.assessmentError ? failed
    : a?.comfortScore !== null && a?.comfortScore !== undefined ? { state: "ready", message: a.coverage < 70 ? "Предварительная оценка: заполненность ниже 70%" : "Удобство рассчитано" }
    : a ? { state: "insufficient", message: "Неизвестны параметры, необходимые для оценки удобства" } : pending;
  return { route, value, comfort };
};
