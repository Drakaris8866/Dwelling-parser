import {
  DEFAULT_PREFERENCE_WEIGHTS,
  createFeedbackInputSchema,
  type CreateFeedbackInput,
  type ParsedSignals,
  type PreferenceWeights,
  type UpdateFeedbackInput,
  type UserFeedback,
  type UserPreferences
} from "../contracts/userFeedback.js";
import { FEEDBACK_SIGNALS, parseComment } from "../domain/userFeedbackParser.js";
import type { StoredFeedback, UserFeedbackRepository } from "../infrastructure/repositories/userFeedbackRepository.js";
import type { Logger } from "../infrastructure/logger.js";

const MAX_DELTA_PER_FEEDBACK = 5;
const MIN_WEIGHT = 5;
const MAX_WEIGHT = 95;
const NON_MONEY_TOTAL = 55;

export const toPublicFeedback = (stored: StoredFeedback): UserFeedback => ({
  id: stored.id,
  propertyId: stored.propertyId,
  rating: (stored.rating as -1 | 0 | 1 | null) ?? null,
  parsedSignals: stored.parsedSignals,
  confirmed: stored.confirmed,
  createdAt: stored.createdAt,
  updatedAt: stored.updatedAt
});

export class UserFeedbackService {
  constructor(
    private readonly repository: UserFeedbackRepository,
    private readonly logger?: Logger
  ) {}

  /**
   * Submits new or updated feedback for a property.
   * Parses comment text into positive/negative/ambiguous signals.
   * Keeps feedback unconfirmed until explicitly confirmed by the user.
   */
  async submitFeedback(input: CreateFeedbackInput): Promise<{
    readonly feedback: UserFeedback;
    readonly parsedSignals: ParsedSignals | null;
  }> {
    const validated = createFeedbackInputSchema.parse(input);
    const parsedSignals = validated.commentRaw ? parseComment(validated.commentRaw) : null;

    const existing = await this.repository.getFeedback(validated.propertyId);
    let stored: StoredFeedback;

    if (existing) {
      stored = await this.repository.updateFeedback(existing.id, {
        rating: validated.rating,
        commentRaw: validated.commentRaw,
        confirmed: false,
        parsedSignals
      });
    } else {
      stored = await this.repository.createFeedback({
        ...validated,
        parsedSignals
      });
    }

    const publicFeedback = toPublicFeedback(stored);
    return {
      feedback: publicFeedback,
      parsedSignals
    };
  }

  /**
   * Confirms a feedback by id.
   * Recalculates preference weights based on all confirmed feedbacks.
   */
  async confirmFeedback(id: string): Promise<{
    readonly feedback: UserFeedback;
    readonly preferences: UserPreferences;
  }> {
    const existing = await this.repository.getFeedbackById(id);
    if (!existing) {
      throw new Error(`Feedback not found: ${id}`);
    }

    const updated = await this.repository.updateFeedback(id, { confirmed: true });
    const confirmedList = await this.repository.listConfirmedFeedbacks();
    const newWeights = this.updateWeights(confirmedList);
    const preferences = await this.repository.updatePreferences(newWeights);

    return {
      feedback: toPublicFeedback(updated),
      preferences
    };
  }

  /**
   * Cancels/deletes feedback by id.
   * Deterministically recalculates preference weights from all remaining confirmed feedbacks.
   */
  async cancelFeedback(id: string): Promise<{
    readonly success: boolean;
    readonly preferences: UserPreferences;
  }> {
    const existing = await this.repository.getFeedbackById(id);
    if (!existing) {
      throw new Error(`Feedback not found: ${id}`);
    }

    await this.repository.deleteFeedback(id);
    const remainingConfirmed = await this.repository.listConfirmedFeedbacks();
    const newWeights = this.updateWeights(remainingConfirmed);
    const preferences = await this.repository.updatePreferences(newWeights);

    return {
      success: true,
      preferences
    };
  }

  /**
   * Resets preferences back to the default weights.
   */
  async resetPreferences(): Promise<UserPreferences> {
    const updated = await this.repository.updatePreferences(DEFAULT_PREFERENCE_WEIGHTS);
    this.logger?.info("Preferences reset to default weights");
    return updated;
  }

  /**
   * Pure deterministic calculation of personal ranking weights from confirmed feedbacks.
   * Shift per component per feedback is capped at ±5%.
   * Bounds for each component are [5, 95].
   * The 4 components are normalized to sum to exactly 55% (45% fixed for money component).
   */
  updateWeights(
    confirmedFeedbacks: readonly Pick<StoredFeedback, "rating" | "parsedSignals">[]
  ): PreferenceWeights {
    if (confirmedFeedbacks.length === 0) {
      return { ...DEFAULT_PREFERENCE_WEIGHTS };
    }

    type ComponentKey = keyof PreferenceWeights;
    const accumulatedDeltas: Record<ComponentKey, number> = {
      house: 0,
      commute: 0,
      location: 0,
      layout: 0
    };

    for (const feedback of confirmedFeedbacks) {
      const signals = feedback.parsedSignals;
      const rating = feedback.rating ?? 0;

      const pos = new Set(signals?.positive ?? []);
      const neg = new Set(signals?.negative ?? []);

      // Calculate component delta for this feedback
      const feedbackDelta: Record<ComponentKey, number> = {
        house: 0,
        commute: 0,
        location: 0,
        layout: 0
      };

      // House: brick, repair_done (+) vs panel, repair_needed (-)
      if (pos.has(FEEDBACK_SIGNALS.BRICK) || pos.has(FEEDBACK_SIGNALS.REPAIR_DONE)) {
        feedbackDelta.house += rating === -1 ? -0.5 : 1.0;
      }
      if (neg.has(FEEDBACK_SIGNALS.PANEL) || neg.has(FEEDBACK_SIGNALS.REPAIR_NEEDED)) {
        feedbackDelta.house += rating === -1 ? 1.5 : -1.0;
      }

      // Commute: close (+) vs far (-)
      if (pos.has(FEEDBACK_SIGNALS.CLOSE)) {
        feedbackDelta.commute += rating === -1 ? -0.5 : 1.0;
      }
      if (neg.has(FEEDBACK_SIGNALS.FAR)) {
        feedbackDelta.commute += rating === -1 ? 1.5 : -1.0;
      }

      // Location: quiet (+) vs noisy (-)
      if (pos.has(FEEDBACK_SIGNALS.QUIET)) {
        feedbackDelta.location += rating === -1 ? -0.5 : 1.0;
      }
      if (neg.has(FEEDBACK_SIGNALS.NOISY)) {
        feedbackDelta.location += rating === -1 ? 1.5 : -1.0;
      }

      // Layout: good_layout (+) vs bad_layout (-)
      if (pos.has(FEEDBACK_SIGNALS.GOOD_LAYOUT)) {
        feedbackDelta.layout += rating === -1 ? -0.5 : 1.0;
      }
      if (neg.has(FEEDBACK_SIGNALS.BAD_LAYOUT)) {
        feedbackDelta.layout += rating === -1 ? 1.5 : -1.0;
      }

      // Cap shift per component per feedback at MAX_DELTA_PER_FEEDBACK (±5%)
      for (const key of Object.keys(feedbackDelta) as ComponentKey[]) {
        const capped = Math.max(-MAX_DELTA_PER_FEEDBACK, Math.min(MAX_DELTA_PER_FEEDBACK, feedbackDelta[key]));
        accumulatedDeltas[key] += capped;
      }
    }

    // Apply accumulated deltas to default base weights
    const raw: Record<ComponentKey, number> = {
      house: DEFAULT_PREFERENCE_WEIGHTS.house + accumulatedDeltas.house,
      commute: DEFAULT_PREFERENCE_WEIGHTS.commute + accumulatedDeltas.commute,
      location: DEFAULT_PREFERENCE_WEIGHTS.location + accumulatedDeltas.location,
      layout: DEFAULT_PREFERENCE_WEIGHTS.layout + accumulatedDeltas.layout
    };

    // Clamp to [MIN_WEIGHT, MAX_WEIGHT] before normalization
    const clamped: Record<ComponentKey, number> = {
      house: Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, raw.house)),
      commute: Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, raw.commute)),
      location: Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, raw.location)),
      layout: Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, raw.layout))
    };

    // Normalize so sum is exactly NON_MONEY_TOTAL (55)
    const sum = clamped.house + clamped.commute + clamped.location + clamped.layout;
    if (sum === 0) {
      return { ...DEFAULT_PREFERENCE_WEIGHTS };
    }

    const scale = NON_MONEY_TOTAL / sum;
    const rounded: Record<ComponentKey, number> = {
      house: Math.round(clamped.house * scale * 10) / 10,
      commute: Math.round(clamped.commute * scale * 10) / 10,
      location: Math.round(clamped.location * scale * 10) / 10,
      layout: Math.round(clamped.layout * scale * 10) / 10
    };

    // Fix potential 0.1 rounding discrepancy to ensure exact sum == 55.0
    const roundedSum = Math.round((rounded.house + rounded.commute + rounded.location + rounded.layout) * 10) / 10;
    const diff = Math.round((NON_MONEY_TOTAL - roundedSum) * 10) / 10;
    if (diff !== 0) {
      rounded.house = Math.round((rounded.house + diff) * 10) / 10;
    }

    return {
      house: Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, rounded.house)),
      commute: Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, rounded.commute)),
      location: Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, rounded.location)),
      layout: Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, rounded.layout))
    };
  }
}
