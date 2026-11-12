import cron, { type ScheduledTask } from "node-cron";
import type { ListingSource } from "../infrastructure/sources/listingSource.js";
import type { ListingIngestionService } from "./listingIngestionService.js";
import type { Logger } from "../infrastructure/logger.js";

export class SchedulerService {
  private readonly tasks: ScheduledTask[] = [];

  constructor(
    private readonly ingestionService: ListingIngestionService,
    private readonly logger: Logger
  ) {}

  start(jsonSources: readonly ListingSource[], realtSource?: ListingSource | undefined): void {
    this.tasks.push(
      cron.schedule("*/10 * * * *", () => {
        void this.runSources(jsonSources);
      })
    );

    const startupSources = [...jsonSources];
    if (realtSource !== undefined) {
      this.tasks.push(
        cron.schedule("*/30 * * * *", () => {
          void this.runSources([realtSource]);
        })
      );
      startupSources.push(realtSource);
    }

    void this.runSources(startupSources);
    this.logger.info("Scheduler started");
  }

  stop(): void {
    for (const task of this.tasks) {
      task.stop();
    }
    this.logger.info("Scheduler stopped");
  }

  private async runSources(sources: readonly ListingSource[]): Promise<void> {
    await Promise.all(sources.map((source) => this.ingestionService.ingestSource(source)));
  }
}
