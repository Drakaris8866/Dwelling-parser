# Local Apartment Catalog

## Runtime

The backend composition root is `src/index.ts`. It starts the loopback-only Fastify API and PostgreSQL-backed workers. React/Vite lives in `web/`; production assets are served by Fastify. GTFS generation and zipping remain independent CLIs.

No worker configuration, database URL or Telegram token is exposed by the API. There is one local preference profile and no public authentication endpoint.

## Collection

Collection covers the union of the Minsk city and Minsk district administrative boundaries, stored under `data/` with OpenStreetMap attribution. Provider search boundaries can be broader; object coordinates are checked against the real polygons. Missing coordinates require structured locality evidence or manual review.

Price, room count and area are display filters, not crawler restrictions. Zero-room studios are supported. Each provider validates the response envelope first and each item separately. Pagination uses Kufar cursors and source-reported page metadata, rejects repeated cursors and mismatched/empty intermediate pages, and checkpoints after each page.

Kufar/Onliner checks run every 10 minutes, Realt every 30 minutes. A nightly full pass runs at 03:00 Europe/Minsk. Incremental checks intentionally traverse available pages too: an undocumented API cannot be assumed to offer a stable chronological delta. Only complete full passes can mark missing listings. Pages are bounded per job, not silently dropped from the collection scope.

`SourceSyncRun` records progress, errors and counts. A 403 is a blocked run; malformed data and transport failures never become a successful empty inventory. Network requests are serialized per host, at least one second apart, with bounded exponential retries and Retry-After support. Browser fallback uses normal Playwright sessions; no CAPTCHA bypass is included.

Onliner search cards do not prove that an object is an apartment. They enter review until the detail description confirms the type. Explicit houses, fractional ownership and Minsk World are excluded. Renting parking or mentioning a residential building does not classify a sale as a rental or house.

Minsk World exclusion also uses its versioned OpenStreetMap polygon, so omitted complex names do not bypass the rule. A nearby subway mention alone is not exclusion evidence. Kufar's listing address can be inside `account_parameters`; real responses show different object addresses and coordinates for the same account, so it is treated as listing-specific data rather than a registered seller address. Relative RMS image paths use the official `v1/list_thumbs_2x` prefix.

Enrichment has a separate persistent queue for each provider. Routes, assessment and notifications have separate queues. Queue heartbeats recover interrupted jobs, while source checkpoints preserve the inventory position. Legacy enrichment jobs are transferred to the provider queues.

Startup explicitly updates existing queue settings, upgrades queued legacy jobs with 60-second heartbeats and reclaims abandoned heartbeat-less attempts only when no live instance has a worker for that queue. Maintenance runs every 30 seconds. Aggregate assessment requests coalesce via pg-boss upsert rather than accumulating full-market scans. Routes are queued independently of detail enrichment; a five-minute refresh also retries missing or failed routes independently of source availability. Routing outcomes (waiting, running, ready, no path, missing coordinates, OTP failure) and assessment limitations are exposed separately in the API and UI.

Search teasers are not complete ownership evidence. Listings without a full verified description stay in review until a detail request succeeds. Later search previews preserve the full description and gallery; changed source text invalidates description verification and triggers another detail request. Missing detail content is an enrichment failure, not a successful empty description.

## Data

`Listing` remains the source publication identified by platform and external ID. Existing IDs, first-seen dates, price history and alerts survive migration. An unchanged price still updates lastSeenAt on an actual search observation. Cached backfills and detail enrichment do not manufacture fresh search observations. Content hashes distinguish parameter changes from price changes and stale enrichment cannot overwrite a newer observation.

`Property` groups confirmed source duplicates and stores favorite/hidden state. Grouping requires address, floor, rooms, close area and two independently matching photo fingerprints. Ambiguous candidates stay separate and are linked as possible duplicates. The representative publication is the cheapest active eligible publication; market samples include one representative per confirmed property.

Both currencies use Decimal. JSON source payloads are retained. Normalized nullable columns support server-side filters; unknown is not the same as false or zero. JSON characteristics use a shared Zod schema and per-field provenance. Undocumented numeric material/repair codes are not guessed; readable detail fields provide the mapping instead.

Missing publications are marked inactive only after two distinct successful full passes at least 24 hours apart. Incomplete or invalid passes do not deactivate inventory. Old records can therefore remain visible while a source is unhealthy; lastSeenAt exposes that uncertainty. Market samples always have the independent 30-day freshness restriction.

## Assessments

Price and comfort are independent, persisted and versioned. Source outages and insufficient comparables do not remove an apartment from the catalog.

Price comparisons require the same rooms and studio class, the same locality/market zone, area within 20%, and matching known renovation, material, readiness and layout. Known building years must be within 20 years. Radius expands through 500/1000/2000 metres, with at least five distinct properties. Shabany/Sokol are isolated by neighborhood metadata; distance is never expanded to a citywide fallback. The subject and its confirmed duplicates are excluded.

The median and interquartile range describe asking prices, not closed transactions. Discount is `(median - actual) / median * 100`; value score is `50 + 50 * discount / (15 + abs(discount)) * evidenceWeight`. Evidence weight combines sample size, known comparison features and interquartile spread. This preserves the observed discount while shrinking weak evidence toward 50. Fewer than five independent comparable properties yield no market score. Saved-search score thresholds can be reviewed after migration to this scale.

Comfort weights default to transport 35%, condition/house 35%, layout 30%. Each component reports known-feature coverage; missing features earn no points in the final score. Scores below 70% coverage are provisional and cannot satisfy a saved search's minimum-comfort threshold. Raw component evidence and reasons remain visible in the detail page.

Assessment version `catalog-1.2` persists the price inputs, applied comparable filters, raw price score, and every comfort criterion's observed value, rule, score and weight. The UI reads this snapshot rather than applying current preferences to old scores. Numeric scoring is unchanged. Older assessment JSON remains valid and gains the detailed breakdown on reassessment.

OTP plans the work commute to arrive by 08:30 of the nearest weekday in Europe/Minsk. The destination and arrival deadline are configurable. The planner requests all supported modes and surface modes separately, then requests rail modes if there is no timely tram option. Among timely routes the latest departure wins, with walking and transfers breaking ties. Travel duration excludes time left before the deadline. Metro access is a separate WALK query. Failures remain unknown, with a short negative cache and a circuit breaker.

The apartment map draws the encoded geometry returned by OTP, with distinct walking and transit segments and the saved destination marker. It offers the primary, fastest and surface itineraries without duplicates. Only the primary itinerary feeds comfort scoring. The map never substitutes a straight line for missing geometry. Existing routes remain readable and are refreshed by the route queue. The detail page can prioritize an individual calculation via `POST /api/listings/:propertyId/route`.

Optional local photo analysis runs in the `photo-repair` queue. `POST /api/listings/:propertyId/photo-repair` requests analysis of the representative gallery; `PATCH` records an explicit decision for that analysis ID. A gallery change invalidates the approval. Confirmed repair is used for the subject and comparable properties without changing source filters. `PATCH /api/listings/:propertyId/renovation-budget` accepts a USD amount or `null`; that budget only affects the all-in comparison against ready, well-renovated properties.

## API

- `GET /api/listings`: JSON-encoded `filters`, `page`, `pageSize`, `sort`.
- `GET /api/map`: the same filters and `zoom`; clusters preserve the result count.
- `GET /api/listings/:propertyId`: publications, features, assessment, routes and price history.
- `PATCH /api/listings/:propertyId/state`: favorite/hidden.
- `GET /api/facets`, `GET /api/health`.
- `GET/POST /api/searches`, `PATCH/DELETE /api/searches/:id`.
- `GET/PUT /api/settings`, `POST /api/sync`.

All request/response contracts and Russian option labels live in `src/contracts/`. Filtering, sorting and pagination run in PostgreSQL. Map and saved searches use the same filter builder as the list. Foreign web origins cannot mutate the local catalog.

## Notifications

Saving a search does not automatically enable Telegram. Enabling notifications first snapshots existing matches without sending them. Later new matches and price drops create unique durable outbox events. Updated filters and hidden/rejected objects supersede pending notifications. Repeated evaluation does not duplicate an event; transient failures retry delivery. Telegram delivery is at-least-once because its API has no transactional idempotency mechanism.

Photo delivery falls back to plain text with the image URL. Messages include both assessments, their limitations, the route and source IDs/links. Development restarts do not replay the entire catalog.

## Validation

`pnpm test` covers source fixtures, studios, numeric conversions, per-item validation, contextual exclusions, scoring independence, missing data, local comparisons, weekday routing and clustering. `pnpm test:integration` creates and removes a uniquely named temporary database, applies every migration and exercises the real repository/API, saved searches, retry delivery and listing lifecycle. It never sends Telegram messages. `pnpm test:browser` checks the running catalog at localhost:3000 and writes desktop/mobile/detail/map screenshots to ignored `artifacts/`.
