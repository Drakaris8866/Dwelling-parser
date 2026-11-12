import assert from "node:assert/strict";
import {
  DEFAULT_PREFERENCE_WEIGHTS,
  createFeedbackInputSchema,
  updateFeedbackInputSchema,
  userFeedbackRatingSchema,
  userFeedbackSchema,
  userPreferencesSchema
} from "../src/contracts/userFeedback.js";
import {
  AMBIGUOUS_TOPICS,
  FEEDBACK_SIGNALS,
  parseComment
} from "../src/domain/userFeedbackParser.js";
import { UserFeedbackService, toPublicFeedback } from "../src/services/userFeedbackService.js";
import type { StoredFeedback } from "../src/infrastructure/repositories/userFeedbackRepository.js";

export function assertUserFeedback(): void {
  // 1. Zod contracts validation
  assert.equal(userFeedbackRatingSchema.parse(1), 1);
  assert.equal(userFeedbackRatingSchema.parse(0), 0);
  assert.equal(userFeedbackRatingSchema.parse(-1), -1);
  assert.throws(() => userFeedbackRatingSchema.parse(2));
  assert.throws(() => userFeedbackRatingSchema.parse(-2));

  const validCreate = createFeedbackInputSchema.parse({
    propertyId: "prop-123",
    rating: 1,
    commentRaw: "Отличный кирпичный дом, тихо"
  });
  assert.equal(validCreate.propertyId, "prop-123");
  assert.equal(validCreate.rating, 1);

  const validPatch = updateFeedbackInputSchema.parse({
    confirmed: true
  });
  assert.equal(validPatch.confirmed, true);

  const publicFeedback = userFeedbackSchema.parse({
    id: "fb-1",
    propertyId: "prop-123",
    rating: 1,
    parsedSignals: {
      positive: ["brick", "quiet"],
      negative: [],
      ambiguous: []
    },
    confirmed: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  assert.equal(publicFeedback.id, "fb-1");
  // commentRaw is NOT present on public feedback contract
  assert.equal("commentRaw" in publicFeedback, false);

  const prefs = userPreferencesSchema.parse({
    weightVersion: 1,
    weights: DEFAULT_PREFERENCE_WEIGHTS
  });
  assert.equal(prefs.weights.house, 20);
  assert.equal(prefs.weights.commute, 15);
  assert.equal(prefs.weights.location, 10);
  assert.equal(prefs.weights.layout, 10);

  // 2. Local comment parser - Positive signals
  const allPositive = parseComment("Кирпичный дом, тихо, метро близко, свежий ремонт, хорошая планировка");
  assert.ok(allPositive.positive.includes(FEEDBACK_SIGNALS.BRICK));
  assert.ok(allPositive.positive.includes(FEEDBACK_SIGNALS.QUIET));
  assert.ok(allPositive.positive.includes(FEEDBACK_SIGNALS.CLOSE));
  assert.ok(allPositive.positive.includes(FEEDBACK_SIGNALS.REPAIR_DONE));
  assert.ok(allPositive.positive.includes(FEEDBACK_SIGNALS.GOOD_LAYOUT));
  assert.equal(allPositive.negative.length, 0);
  assert.equal(allPositive.ambiguous.length, 0);

  // 3. Local comment parser - Negative signals
  const allNegative = parseComment("Панельный хрущ, шумно от дороги, далеко от метро, ремонт нужен, тесная маленькая кухня");
  assert.ok(allNegative.negative.includes(FEEDBACK_SIGNALS.PANEL));
  assert.ok(allNegative.negative.includes(FEEDBACK_SIGNALS.NOISY));
  assert.ok(allNegative.negative.includes(FEEDBACK_SIGNALS.FAR));
  assert.ok(allNegative.negative.includes(FEEDBACK_SIGNALS.REPAIR_NEEDED));
  assert.ok(allNegative.negative.includes(FEEDBACK_SIGNALS.BAD_LAYOUT));
  assert.equal(allNegative.positive.length, 0);
  assert.equal(allNegative.ambiguous.length, 0);

  // 4. Negation handling: "не шумно" -> negative.noise = false
  const negatedNoise = parseComment("Район отличный, не шумно, совсем не шумно");
  assert.equal(negatedNoise.negative.includes(FEEDBACK_SIGNALS.NOISY), false, "Negative must NOT contain noise when negated");
  assert.ok(negatedNoise.positive.includes(FEEDBACK_SIGNALS.QUIET), "Negated noise should indicate quiet");

  const negatedQuiet = parseComment("Не тихо, окна на проспект");
  assert.equal(negatedQuiet.positive.includes(FEEDBACK_SIGNALS.QUIET), false);
  assert.ok(negatedQuiet.negative.includes(FEEDBACK_SIGNALS.NOISY));

  const negatedFar = parseComment("Квартира хорошая, недалеко от метро и не далеко от остановки");
  assert.equal(negatedFar.negative.includes(FEEDBACK_SIGNALS.FAR), false);
  assert.ok(negatedFar.positive.includes(FEEDBACK_SIGNALS.CLOSE));

  const negatedClose = parseComment("Не близко к центру");
  assert.equal(negatedClose.positive.includes(FEEDBACK_SIGNALS.CLOSE), false);
  assert.ok(negatedClose.negative.includes(FEEDBACK_SIGNALS.FAR));

  const negatedRepairNeeded = parseComment("Квартира не требует ремонта, ремонт не нужен");
  assert.equal(negatedRepairNeeded.negative.includes(FEEDBACK_SIGNALS.REPAIR_NEEDED), false);
  assert.ok(negatedRepairNeeded.positive.includes(FEEDBACK_SIGNALS.REPAIR_DONE));

  const negatedRepairDone = parseComment("Ремонт не сделан");
  assert.equal(negatedRepairDone.positive.includes(FEEDBACK_SIGNALS.REPAIR_DONE), false);
  assert.ok(negatedRepairDone.negative.includes(FEEDBACK_SIGNALS.REPAIR_NEEDED));

  // 5. Ambiguity handling (no guessing, send to ambiguous)
  const questionComment = parseComment("Шумно ли вечером? Далеко ли до школы?");
  assert.ok(questionComment.ambiguous.includes(AMBIGUOUS_TOPICS.NOISE));
  assert.ok(questionComment.ambiguous.includes(AMBIGUOUS_TOPICS.COMMUTE));
  assert.equal(questionComment.positive.length, 0);
  assert.equal(questionComment.negative.length, 0);

  const uncertainComment = parseComment("С ремонтом непонятно, на любителя");
  assert.ok(uncertainComment.ambiguous.includes(AMBIGUOUS_TOPICS.REPAIR));
  assert.equal(uncertainComment.positive.length, 0);
  assert.equal(uncertainComment.negative.length, 0);

  const conflictingComment = parseComment("Двор тихий, но от трассы очень шумно");
  assert.ok(conflictingComment.ambiguous.includes(AMBIGUOUS_TOPICS.NOISE));
  assert.equal(conflictingComment.positive.includes(FEEDBACK_SIGNALS.QUIET), false);
  assert.equal(conflictingComment.negative.includes(FEEDBACK_SIGNALS.NOISY), false);

  // Empty string
  const emptyComment = parseComment("   ");
  assert.deepEqual(emptyComment, { positive: [], negative: [], ambiguous: [] });

  // 6. Weight update algorithm
  const service = new UserFeedbackService({} as any);

  // Defaults when no feedback exists
  const defaultWeights = service.updateWeights([]);
  assert.deepEqual(defaultWeights, DEFAULT_PREFERENCE_WEIGHTS);
  assert.equal(
    defaultWeights.house + defaultWeights.commute + defaultWeights.location + defaultWeights.layout,
    55
  );

  // Single feedback with commute emphasis
  const singleFeedback: StoredFeedback = {
    id: "f-1",
    propertyId: "p-1",
    rating: -1,
    commentRaw: "Ужасно далеко до метро",
    parsedSignals: {
      positive: [],
      negative: [FEEDBACK_SIGNALS.FAR],
      ambiguous: []
    },
    confirmed: true,
    createdAt: new Date(),
    updatedAt: new Date()
  };

  const weightsAfterOne = service.updateWeights([singleFeedback]);
  // Total of non-money weights must always equal 55.0
  const sumAfterOne =
    weightsAfterOne.house + weightsAfterOne.commute + weightsAfterOne.location + weightsAfterOne.layout;
  assert.equal(Math.round(sumAfterOne * 10) / 10, 55);

  // Commute weight should have increased (user cares about transit distance)
  assert.ok(weightsAfterOne.commute > DEFAULT_PREFERENCE_WEIGHTS.commute);

  // Check smooth change: no component shifts by more than 5% in a single review
  assert.ok(Math.abs(weightsAfterOne.commute - DEFAULT_PREFERENCE_WEIGHTS.commute) <= 5);
  assert.ok(Math.abs(weightsAfterOne.house - DEFAULT_PREFERENCE_WEIGHTS.house) <= 5);
  assert.ok(Math.abs(weightsAfterOne.location - DEFAULT_PREFERENCE_WEIGHTS.location) <= 5);
  assert.ok(Math.abs(weightsAfterOne.layout - DEFAULT_PREFERENCE_WEIGHTS.layout) <= 5);

  // All components must stay within [5, 95]
  assert.ok(weightsAfterOne.house >= 5 && weightsAfterOne.house <= 95);
  assert.ok(weightsAfterOne.commute >= 5 && weightsAfterOne.commute <= 95);
  assert.ok(weightsAfterOne.location >= 5 && weightsAfterOne.location <= 95);
  assert.ok(weightsAfterOne.layout >= 5 && weightsAfterOne.layout <= 95);

  // Deterministic cancellation / rollback: removing feedback restores default weights exactly
  const restoredWeights = service.updateWeights([]);
  assert.deepEqual(restoredWeights, DEFAULT_PREFERENCE_WEIGHTS);

  // Privacy: toPublicFeedback strips commentRaw
  const publicObj = toPublicFeedback(singleFeedback);
  assert.equal((publicObj as any).commentRaw, undefined);
  assert.equal(publicObj.id, "f-1");
  assert.equal(publicObj.propertyId, "p-1");
  assert.equal(publicObj.rating, -1);
}
