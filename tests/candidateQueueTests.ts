import assert from "node:assert/strict";
import {
  CandidateQueueService,
  buildTaskSignature,
  type CandidateRecord
} from "../src/services/candidateQueueService.js";
import { COMMUTE_VERSION } from "../src/domain/commutePolicy.js";

function generateTestCandidates(count: number): CandidateRecord[] {
  const candidates: CandidateRecord[] = [];
  for (let i = 1; i <= count; i++) {
    candidates.push({
      id: `listing-${i}`,
      propertyId: `prop-${i}`,
      score: 100 - i, // strictly descending scores: listing-1 has 99, listing-2 has 98, etc.
      pricePerSqm: 1000 + i * 20,
      priceUsd: 50000 + i * 1000,
      disposition: "ACCEPTED",
      isActive: true,
      isRepresentative: true,
      latitude: 53.90 + (i * 0.001),
      longitude: 27.55 + (i * 0.001),
      photos: [`https://example.com/photos/${i}_1.jpg`, `https://example.com/photos/${i}_2.jpg`],
      photoSetHash: `photo-hash-${i}`,
      photoRepairStatus: i % 2 === 0 ? "READY" : null, // half have photo repair ready, half need it
      routeStatus: i % 3 === 0 ? "READY" : "PENDING", // one third have routes ready, two thirds need it
      routeVersion: COMMUTE_VERSION,
      settingsVersion: 1
    });
  }
  return candidates;
}

export async function assertCandidateQueue(): Promise<void> {
  // =========================================================================
  // 1. Проверка отбора топ-20 кандидатов + слота исследования (exploration slot)
  // =========================================================================
  {
    const candidates = generateTestCandidates(35);
    const service = new CandidateQueueService({ initialCandidates: candidates });

    const { top, explore } = await service.selectTopCandidates({ limit: 20, exploreRatio: 0.20 });

    // Top-20 must have exactly 20 candidates
    assert.equal(top.length, 20, "Top candidates should have length 20");
    // Verify top candidates are the 20 highest-scoring listings (listing-1 through listing-20)
    for (let i = 0; i < 20; i++) {
      assert.equal(top[i], `listing-${i + 1}`, `Expected top[${i}] to be listing-${i + 1}`);
    }

    // Explore slot: with ratio 0.20 and 20 top candidates, exactly 4 exploration candidates
    assert.equal(explore.length, 4, "Exploration candidates should have length 4 (20 * 0.20)");

    // Ensure top and explore are completely disjoint
    const topSet = new Set(top);
    for (const exploreId of explore) {
      assert.equal(topSet.has(exploreId), false, `Exploration candidate ${exploreId} must not be in top set`);
    }

    // Verify all exploration candidates come from outside top-20 (id > 20)
    for (const exploreId of explore) {
      const num = Number(exploreId.replace("listing-", ""));
      assert.ok(num > 20, `Exploration candidate ${exploreId} should be outside top-20`);
    }

    // Test with small pool (< 20 candidates): no exploration candidates outside top
    const smallPool = generateTestCandidates(10);
    const smallService = new CandidateQueueService({ initialCandidates: smallPool });
    const smallResult = await smallService.selectTopCandidates({ limit: 20, exploreRatio: 0.20 });
    assert.equal(smallResult.top.length, 10);
    assert.equal(smallResult.explore.length, 0, "No explore candidates when inventory <= limit");

    // Test custom limit and exploreRatio (e.g. limit: 10, exploreRatio: 0.30 -> 3 explore slots)
    const customResult = await service.selectTopCandidates({ limit: 10, exploreRatio: 0.30 });
    assert.equal(customResult.top.length, 10);
    assert.equal(customResult.explore.length, 3, "Expected 3 explore slots for limit 10 with 0.30 ratio");

    // Excluded or unlocated listings must NOT be included in candidates
    const withExcluded: CandidateRecord[] = [
      { id: "valid-1", disposition: "ACCEPTED", isActive: true, latitude: 53.9, longitude: 27.5, score: 90 },
      { id: "excluded-1", disposition: "EXCLUDED", isActive: true, latitude: 53.9, longitude: 27.5, score: 99 },
      { id: "inactive-1", disposition: "ACCEPTED", isActive: false, latitude: 53.9, longitude: 27.5, score: 95 },
      { id: "no-geo-1", disposition: "ACCEPTED", isActive: true, latitude: null, longitude: null, score: 98 }
    ];
    const filteredService = new CandidateQueueService({ initialCandidates: withExcluded });
    const filteredResult = await filteredService.selectTopCandidates({ limit: 20 });
    assert.deepEqual(filteredResult.top, ["valid-1"], "Only valid active non-excluded candidates with coordinates allowed");
  }

  // =========================================================================
  // 2. Проверка предотвращения зацикливания (повторная задача с идентичным отпечатком отсекается)
  // =========================================================================
  {
    // Check buildTaskSignature behavior
    const sig1 = buildTaskSignature("list-1", { photoHash: "h1", routeVersion: 4, settingsVersion: 1 });
    const sig2 = buildTaskSignature("list-1", { photoHash: "h1", routeVersion: 4, settingsVersion: 1 });
    assert.equal(sig1, sig2, "Identical inputs must yield identical task signatures");

    const sigPhotoChanged = buildTaskSignature("list-1", { photoHash: "h2", routeVersion: 4, settingsVersion: 1 });
    assert.notEqual(sig1, sigPhotoChanged, "Changed photo hash must yield different task signature");

    const sigRouteChanged = buildTaskSignature("list-1", { photoHash: "h1", routeVersion: 5, settingsVersion: 1 });
    assert.notEqual(sig1, sigRouteChanged, "Changed route version must yield different task signature");

    const sigSettingsChanged = buildTaskSignature("list-1", { photoHash: "h1", routeVersion: 4, settingsVersion: 2 });
    assert.notEqual(sig1, sigSettingsChanged, "Changed settings version must yield different task signature");

    // Test deduplication during batch enqueuing
    const candidates = generateTestCandidates(5);
    // Give all of them pending routes and pending photos
    for (const c of candidates) {
      c.routeStatus = "PENDING";
      c.photoRepairStatus = null;
    }

    const enqueuedRoutesList: string[] = [];
    const enqueuedPhotosList: string[] = [];

    const service = new CandidateQueueService({
      initialCandidates: candidates,
      hasOllama: true,
      enqueueRoute: async (id) => { enqueuedRoutesList.push(id); },
      enqueuePhoto: async (id) => { enqueuedPhotosList.push(id); }
    });

    // First batch run: should enqueue all 5 candidates
    const firstBatch = await service.enqueueTopCandidatesBatch({ limit: 5, exploreRatio: 0 });
    assert.equal(firstBatch.enqueuedRoutes, 5, "First batch must enqueue 5 routes");
    assert.equal(firstBatch.enqueuedPhotos, 5, "First batch must enqueue 5 photos");
    assert.equal(firstBatch.skippedSignatures, 0, "First batch must have 0 skipped signatures");

    // Second batch run with identical state: all 5 candidates must be deduplicated by signature
    const secondBatch = await service.enqueueTopCandidatesBatch({ limit: 5, exploreRatio: 0 });
    assert.equal(secondBatch.enqueuedRoutes, 0, "Second batch must enqueue 0 routes");
    assert.equal(secondBatch.enqueuedPhotos, 0, "Second batch must enqueue 0 photos");
    assert.equal(secondBatch.skippedSignatures, 5, "Second batch must skip all 5 identical signatures");

    // Modify photoSetHash on candidate 1: signature changes, so candidate 1 should be re-enqueued, others skipped
    const c1 = service.getCandidate("listing-1")!;
    c1.photoSetHash = "new-photo-set-hash";
    c1.photoRepairStatus = null; // needs photo analysis again

    const thirdBatch = await service.enqueueTopCandidatesBatch({ limit: 5, exploreRatio: 0 });
    assert.equal(thirdBatch.skippedSignatures, 4, "4 unchanged candidates must be skipped");
    assert.equal(thirdBatch.enqueuedPhotos, 1, "Modified candidate must be enqueued");
  }

  // =========================================================================
  // 3. Проверка поведения при недоступной Ollama (не ставит фото в очередь если Ollama недоступна)
  // =========================================================================
  {
    const candidates = generateTestCandidates(6);
    for (const c of candidates) {
      c.photoRepairStatus = null;
      c.routeStatus = "READY"; // route already ready, only photos need work
    }

    // Service with Ollama unavailable
    const serviceNoOllama = new CandidateQueueService({
      initialCandidates: candidates,
      hasOllama: false
    });

    // Direct check: shouldEnqueuePhoto must return false when hasOllama is false
    assert.equal(serviceNoOllama.shouldEnqueuePhoto("listing-1", false), false);
    assert.equal(serviceNoOllama.shouldEnqueuePhoto("listing-2", false), false);

    // Batch enqueuing must not enqueue any photos when Ollama is unavailable
    const resultNoOllama = await serviceNoOllama.enqueueTopCandidatesBatch({ limit: 6, exploreRatio: 0 });
    assert.equal(resultNoOllama.enqueuedPhotos, 0, "Must not enqueue any photos when Ollama is unavailable");

    // Check behavior when Ollama becomes available
    serviceNoOllama.setOllamaAvailable(true);
    serviceNoOllama.clearSignatures(); // reset signatures for clean test
    assert.equal(serviceNoOllama.shouldEnqueuePhoto("listing-1", true), true);

    const resultWithOllama = await serviceNoOllama.enqueueTopCandidatesBatch({ limit: 6, exploreRatio: 0 });
    assert.equal(resultWithOllama.enqueuedPhotos, 6, "Must enqueue photos once Ollama is available");

    // Candidate without photos should not enqueue photos even if Ollama is available
    serviceNoOllama.registerCandidate({
      id: "listing-empty-photos",
      disposition: "ACCEPTED",
      latitude: 53.9,
      longitude: 27.5,
      photos: [],
      photoRepairStatus: null
    });
    assert.equal(serviceNoOllama.shouldEnqueuePhoto("listing-empty-photos", true), false);

    // Candidate with photo repair already READY should not enqueue photos
    serviceNoOllama.registerCandidate({
      id: "listing-already-done",
      disposition: "ACCEPTED",
      latitude: 53.9,
      longitude: 27.5,
      photos: ["https://example.com/p1.jpg"],
      photoRepairStatus: "READY"
    });
    assert.equal(serviceNoOllama.shouldEnqueuePhoto("listing-already-done", true), false);
  }

  // =========================================================================
  // 4. Проверка, что каталог не блокируется
  // =========================================================================
  {
    const candidates = generateTestCandidates(10);
    let delayedJobRunning = false;
    let catalogReadCompletedWhileBatchRunning = false;

    const service = new CandidateQueueService({
      initialCandidates: candidates,
      hasOllama: true,
      enqueueRoute: async () => {
        delayedJobRunning = true;
        // Simulate background task execution
        await new Promise((resolve) => setTimeout(resolve, 80));
        delayedJobRunning = false;
      }
    });

    // Start background batch asynchronously
    const batchPromise = service.enqueueTopCandidatesBatch({ limit: 5, exploreRatio: 0 });

    // Ensure queue has entered isProcessing state
    await new Promise((resolve) => setTimeout(resolve, 10));
    const statusWhileRunning = service.getQueueStatus();
    assert.equal(statusWhileRunning.isProcessing, true, "Queue should be processing in background");

    // Simulate immediate, non-blocking catalog access (e.g. read / search / detail)
    const catalogReadStart = Date.now();
    const candidateSnapshot = service.getCandidate("listing-1");
    assert.ok(candidateSnapshot, "Catalog read must succeed immediately");
    const catalogReadElapsed = Date.now() - catalogReadStart;
    assert.ok(catalogReadElapsed < 50, "Catalog read must not be blocked by background queue processing");
    catalogReadCompletedWhileBatchRunning = true;

    // Await batch completion
    const batchResult = await batchPromise;
    assert.ok(batchResult.enqueuedRoutes > 0);
    assert.equal(catalogReadCompletedWhileBatchRunning, true, "Catalog read completed concurrently during batch");

    // Queue status after completion
    const finalStatus = service.getQueueStatus();
    assert.equal(finalStatus.isProcessing, false, "Queue should no longer be processing");
    assert.equal(finalStatus.activeCount, 0, "Active job count should return to 0");
    assert.ok(finalStatus.enqueuedRoutesCount > 0, "Metrics reflect total routes enqueued");

    // Check visible candidate states
    const state = service.getListingQueueState("listing-1");
    assert.ok(["QUEUED", "READY", "IDLE"].includes(state), `Visible state was ${state}`);

    // Check onRecalculate callback triggers
    let recalculateTriggered = false;
    const recalcService = new CandidateQueueService({
      initialCandidates: generateTestCandidates(2),
      onRecalculate: async () => {
        recalculateTriggered = true;
      }
    });
    await recalcService.enqueueTopCandidatesBatch({ limit: 2, exploreRatio: 0 });
    // Allow background recalculation promise to resolve
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(recalculateTriggered, true, "Recalculation should be triggered after enqueueing new candidates");
  }
}

