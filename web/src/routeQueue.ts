import type { RouteQueueStatus } from "../../src/contracts/catalog.js";

export const queueDuration = (seconds: number): string => {
  if (seconds < 60) return "меньше минуты";
  const minutes = Math.ceil(seconds / 60);
  return minutes < 60 ? `≈ ${minutes} мин` : `≈ ${Math.floor(minutes / 60)} ч ${minutes % 60} мин`;
};
export const queueDescription = (queue: RouteQueueStatus): string =>
  `№ ${queue.position.toLocaleString("ru-RU")} в очереди${queue.estimatedSeconds === null ? " · время пока неизвестно" : ` · ${queueDuration(queue.estimatedSeconds)} до готовности`}`;
