# WhatsApp automation: implementation plan

Status: catalog/manual seeding complete; the first WhatsApp transport slice is implemented. Shopping/checkout and the real Meta smoke test remain pending.
Prepared: 28 October 2026.

## 1. Objective and current position

Deliver the README's grocery ordering experience through WhatsApp first. A customer sends a shopping list, resolves ambiguities, reviews exact variants and totals, explicitly confirms, and receives an order reference and fulfillment updates. Staff can intervene safely.

The repository has a working TypeScript manual importer, versioned PostgreSQL catalog/inventory migration and seed tests. The database contains 33 product variants, 33 current prices and 792 demo sellable packs in `grocery_dev`. Express, verified webhook intake, the durable inbox/outbox, worker, basic greeting/help/opt-out replies, support pause and delivery-status handling are implemented; see the [setup and operating guide](whatsapp-setup.md). Real Meta account credentials and HTTPS callback configuration are not present, so real delivery is unverified. Catalog shopping, carts, orders and authenticated staff controls remain next. Seeding is finished and is not part of server startup.

**Current stage:** the manual seeding foundation is implemented; the WhatsApp application has not started. At the user's subsequent request, a researched [Indian household grocery starter dataset and manual importer](../data/seed/README.md) are available for development/staging in an isolated `grocery_dev` PostgreSQL schema, with internal source references, external media URLs and explicitly invented demo stock. The user's later sheet can replace it after mapping and review. Product seeding must be an explicit manual operation; it must never run during application startup, worker startup, deployment, or schema migration.

**Customer navigation rule:** retailer/source URLs are internal provenance only. Never send them as WhatsApp links, buttons or redirects. External image URLs are for media retrieval only; if an image fails, send text-only product details. Product selection, cart and order confirmation stay in this store's conversation.

## 2. Proposed first-release scope

| Include in the first usable release | Defer until this workflow works |
| --- | --- |
| Official Meta WhatsApp Cloud API, inbound text, structured choices, outbound replies and delivery statuses | WhatsApp Web/browser automation, campaigns, bulk outreach |
| One grocery store and stock location | Multiple stores, routing and warehouse allocation |
| Product-sheet import, exact sellable variants, prices, stock and adjustment history | Full catalog management website, promotions and loyalty |
| Shopping-list parsing, catalog matching, clarification, cart edits and explicit confirmation | Voice transcription, photo/OCR ordering and unrestricted chatbot conversations |
| Delivery address/serviceability, pickup, configured fees and order status | Live courier GPS and route optimization |
| Cash on delivery or pay at pickup for the first pilot, if supported by the store | Hosted online payment and automated invoice PDF until providers and invoicing requirements are settled |
| Small authenticated staff interface for orders, stock adjustments and support handoff | Full customer website, analytics and forecasting |
| Consent, opt-out, retries, audit history, monitoring and recovery | Additional infrastructure without measured need |

These are proposed defaults, not confirmed business facts. English text and fixed sellable packs are the initial supported inputs. Unresolved free-form requests go through clarification or staff. If Hindi/Hinglish, loose weighed goods, online payment or formal invoices are required for the pilot, bring the relevant work into scope before launch.

Existing aliases such as `atta`, `chawal`, `namak` and `doodh` can be recognized immediately. That does not imply general Hindi/Hinglish sentence understanding. Start with deterministic parsing and no language-model dependency; evaluate actual failed requests before adding one.

The first pilot is not the entire README delivered: automated payment links and PDF invoices remain a defined follow-on milestone. Never label an order summary as a tax invoice.

## 3. Architecture and technology decisions

Use one Node.js/Express application written in TypeScript, one worker process from the same codebase, and PostgreSQL. The implementation uses `pg` (node-postgres), versioned SQL migrations, the Node.js test runner and strict TypeScript checks. Node's built-in fetch sends Meta requests. Node.js 24.12+ executes the TypeScript directly; package versions are pinned in the lockfile. Python is not required for the backend or seeding; any future ML runtime is a separate decision.

Keep WhatsApp, catalog, inventory, orders and staff operations in separate modules. For this first deployment they share one application-owned schema and database transactions. This is an explicit initial-deployment simplification of the README's microservices proposal: there are no cross-service table writes because these modules are not independently deployed services. If extracted later, move ownership behind APIs/events and replace local transactions with compensation workflows.

```text
Customer WhatsApp
       |
Meta Cloud API --signed webhooks--> Express
                                      |
                              PostgreSQL inbox
                                      |
                              Durable worker
                         /            |            \
                    Catalog       Conversation     Checkout
                                      |            |
                               Message outbox   Stock + order
                                      |
                                Meta Cloud API

Authenticated staff interface --> same domain operations + audit trail
```

Use PostgreSQL inbox/outbox tables for durable processing; no Redis, RabbitMQ, Kafka or Kubernetes initially. Inbox processing holds row locks through its state/outbox transaction, so a crash rolls back and permits reprocessing. Outbound API calls use committed ownership leases: an expired send is uncertain and is not blindly resent. Serialize conversation changes per sender; do not hold database transactions open during external API calls.

Planned implementation locations:

```text
app/whatsapp/       verification, payload normalization, sending, status updates
app/conversations/ commands, parsing, catalog resolution, state transitions
app/catalog/       products, variants, search, prices
app/inventory/     stock ledger, balances, reservations
app/orders/        quotes, checkout, immutable snapshots, status
app/staff/         authenticated operator pages and actions
app/worker.ts      inbox, outbox, expiration and retry processing
migrations/        schema changes only
scripts/           manually invoked product import
tests/             fixtures and checks; synthetic test data only
docs/              setup, import mapping and operating instructions
```

## 4. Meta setup and messaging rules

Start with the Meta test sender and approved test recipients. Prepare a Meta developer app, business portfolio, WhatsApp Business Account and phone-number ID, webhook HTTPS endpoint, app secret, verification token, and access token. Use a suitably scoped system-user token for production and monitor credential failures. Meta's official [Cloud API collection](https://www.postman.com/meta/whatsapp-business-platform/collection/wlk6lh4/whatsapp-cloud-api) describes the assets and token types.

Before activating a real number, check its current registration, onboarding/migration or coexistence eligibility, business/display-name requirements, billing and account limits. Do not delete or migrate the store's existing WhatsApp account as an assumed setup step. Record the chosen supported Graph API version and test its actual payloads before pinning it.

Implement these rules centrally in outbound sending:

- Free-form replies are allowed within the 24-hour window following the latest customer message. Outside it, use an approved template; sending a template alone does not create a new customer reply.
- Record permission for proactive order updates, including time, purpose, source and wording version. A shopping inquiry does not imply permission for future marketing.
- Honor opt-out requests, including those received by staff. Suppress queued proactive messages when permission is withdrawn.
- Offer clear human escalation. Staff replies must also satisfy messaging-window and template rules.
- Prepare utility templates for order acceptance, dispatch, cancellation and pickup/delivery updates. Recheck approval/availability at send time; failed approval must not block the underlying order workflow.

These requirements follow the [WhatsApp Business Messaging Policy](https://whatsappbusiness.com/policy/?faq=5). Template classification and approval are Meta decisions, not assumptions in our code.

Identity: store a local customer UUID and business-scoped provider identity. Treat provider identifiers as opaque strings and keep phone numbers optional. Do not merge accounts by display name or username. Meta's [usernames briefing](https://developers.meta.com/resources/videos/whatsapp-usernames/) explains the BSUID transition. Confirm exact inbound/outbound fields against the selected API version; test senders with and without phone numbers. Linking a future web account requires explicit verification, not a name match.

## 5. Product sheet and manual seeding

The user's sheet is the authority for actual store products when supplied. Until then, the researched starter dataset supports development/staging only; it is not production stock or approved live pricing. Inspect the sheet's actual structure when supplied; do not demand a new template before seeing it. Agree a column mapping and show any missing fields or duplicates before importing. Never merge the sheet and starter dataset by product name alone.

Expected business fields, whether supplied directly or mapped:

| Field | Import handling |
| --- | --- |
| Stable SKU/external product key | Required unique identifier; do not use row position or product name as the permanent key |
| Product name, category, brand | Preserve names; missing brand may be explicitly unbranded |
| Pack quantity and unit | Required to distinguish sellable variants; normalize only with an agreed mapping |
| Selling price and currency | Required for sale; decimal arithmetic, no binary floating point |
| Tax treatment | Confirm inclusive/exclusive and rounding before checkout goes live |
| Opening stock and location | Missing means unknown, not unlimited; block automatic sale until verified |
| Active/available flag | Explicit mapping; inactive variants excluded from checkout |
| Optional barcode and aliases | Validate duplicates; useful for search, not automatic identity matching |

Manual import contract:

1. A preview command validates the complete file and prints proposed inserts/updates and row-level errors. It makes no writes.
2. An explicit apply command imports the reviewed file and mapping. Record a file hash, import ID, actor, counts and timestamp; abort if the file changed after preview.
3. Fail the batch on invalid rows rather than silently creating a partial catalog. Validate required cells, duplicates, units, currencies, decimal precision, nonnegative prices/stock and unsupported formulas. Treat file contents as data; never execute macros or spreadsheet expressions.
4. Upsert catalog fields by stable SKU. Re-running the same successful import must not duplicate products or stock movements. Retrying an identical file should return the recorded result.
5. Opening stock is applied only once per SKU/location through an audited movement. Later catalog imports must not reset live stock. Stock corrections are a separate explicit adjustment operation; historical orders retain their snapshots.
6. A missing row does not delete a product. SKU renames, variant identity changes and bulk deactivation require a separately reviewed operation.
7. Keep the source sheet private and untracked. Use a transaction and unique constraints; never log the entire sheet unnecessarily. Serialize application of imports and coordinate imports affecting active checkout quotes.

Current manual JSON seed command interface (mapping a future sheet to this format is separate work):

```text
npm run seed -- --file <json-path> --preview
npm run seed -- --file <json-path> --apply --expected-sha256 <reviewed-file-hash>
```

**No automatic seeding:** startup checks database readiness only. Schema migrations create/alter structures only. Production startup must fail clearly on missing configuration/schema rather than silently importing data. Tests may create isolated synthetic fixtures; no test catalog is loaded into a real environment.

## 6. Conversation and customer experience

Example flow:

1. Customer: `2 milk 500 ml, 1 kg rice, 2 soaps`.
2. Bot identifies candidate variants. It asks which milk brand and what kind of soap; it never guesses an exact SKU when multiple matches are plausible.
3. Customer selects from short numbered choices or supported interactive controls, with a text fallback.
4. Bot shows requested quantity, exact pack size, brand, unit price and line total. Unavailable lines remain visible with explicit remove/replace choices.
5. Customer chooses pickup or supplies delivery details. The system checks service area, fees, minimum order and store hours.
6. Bot presents the full quote: items, tax treatment, fees, grand total, fulfillment method/address, payment method and expiry. It states that availability will be checked again at confirmation.
7. Customer selects `Confirm` for that quote. Stock and price are revalidated; order creation and reservation happen atomically. Any material change requires a fresh summary and confirmation.
8. Bot sends an order reference and clear acceptance/payment status. Staff picks and progresses the order. Status requests are authorized against the sender's own orders.

Supported commands: `help`, `cart`, `remove <line>`, `change <line> <quantity>`, `checkout`, `cancel`, `status <reference>`, `agent`, `stop`, and an explicit flow to resume permitted notifications. Canceling a cart differs from canceling an accepted order; after picking, cancellation becomes a staff request.

Persist states: `IDLE`, `BUILDING_CART`, `CLARIFYING_ITEM`, `COLLECTING_FULFILLMENT`, `AWAITING_CONFIRMATION`, and `HUMAN_HANDOFF`. Store cart/quote revisions and the active prompt. Creating an order closes the quote; fulfillment is tracked by the order state machine, not by keeping a conversation stuck at checkout.

Every interactive action identifies the conversation, quote/cart revision and allowed action. Bind it to the authenticated provider sender, validate expiry and current state, and reject stale or replayed actions. A bare `yes` is accepted only for one current, unambiguous confirmation prompt. Edits invalidate earlier quotes and buttons. Repeated confirmation returns the existing order.

Handle greetings, multiple lists, invalid quantities, unknown products, changed delivery details, abandoned carts and unsupported media with clear replies. Stop after a bounded number of failed clarifications and offer staff help. During handoff, pause automated shopping replies; staff explicitly resumes the bot. Opt-out suppresses proactive messaging without silently canceling existing orders.

## 7. Parsing and catalog resolution

Begin with deterministic quantity/unit parsing, catalog names and approved aliases. Support multi-line/comma-separated lists and explicit pack counts. Candidate search uses normalized catalog text and PostgreSQL search; ambiguous matches require customer selection. Do not interpret `1 kg rice` as one arbitrary pack or convert `2 x 500 ml` into an unconfirmed substitute pack.

For the first pilot, fixed packs only; quantities must resolve to purchasable pack counts. Loose goods need agreed weighing, pricing and final-total rules before enablement. Bound list length, item quantity, message length and processing time.

Evaluate representative shopping lists and misspellings against the actual sheet. If deterministic parsing does not cover the required language, add a constrained language-model extraction step before the pilot, after choosing provider, data handling and budget. Its output is only proposed item text, quantity and unit. Validate the schema and resolve every item against the catalog. It cannot set price, stock, customer identity or payment state, or execute orders/tools. Provider failure falls back to clarification or staff.

## 8. Data, transactions and contracts

Use UUID domain IDs, timezone-aware UTC timestamps, decimal prices, explicit currency/units, and immutable order-line snapshots. Display business dates using the store timezone, provisionally Asia/Kolkata. Confirm currency and tax rules with the sheet/store; do not infer them solely from timezone.

Minimum data groups:

| Owner/module | Records and important constraints |
| --- | --- |
| Catalog | Categories, brands, products, variants, prices, aliases, import batches/row results; unique SKU |
| Customer/conversation | Customers, scoped provider identities, contact permissions, conversations, carts, cart items and quotes; versioned state |
| WhatsApp/worker | Inbound events, processed message IDs, outbound jobs, provider message IDs and status history; unique scoped event keys |
| Inventory | Stock balances, append-only movements and reservations by SKU/location; nonnegative available stock |
| Order | Orders, item snapshots, fulfillment details, status history and confirmation idempotency key |
| Operations | Staff identities/roles, handoff ownership and audit events |

Internal operations: catalog search, availability lookup, cart mutation, quote creation, quote confirmation, reservation release/consumption, authorized order lookup, staff transition and notification scheduling. Keep domain operations independent of WhatsApp formatting so the later website reuses them.

Public ingress: `GET /webhooks/whatsapp` for verification, `POST /webhooks/whatsapp` for events. Staff routes require authentication and roles; readiness/liveness responses disclose no secrets. Generate OpenAPI for implemented routes. No publicly accessible stock adjustment or arbitrary message-send endpoint.

Checkout transaction:

1. Lock the active quote/cart, validate sender ownership, revision and expiry, and find an existing order by the unique quote-confirmation key.
2. Lock affected stock rows in consistent SKU order. Recheck active variants, authoritative prices, fees and available stock. Changed terms produce a new quote, never silent acceptance.
3. Create one order with snapshots and reserve all lines together. Write inventory movements/reservation metadata and the outbound notification job in the same transaction. A failed line rolls back the entire checkout.
4. Commit, then send the reply asynchronously. Failure to send does not undo or recreate an order.

Proposed quote validity: 10 minutes, to be confirmed with the store. Quotes do not hold stock. COD/pickup reservations remain tied to accepted orders until fulfillment or a policy-driven cancellation; they must not expire under staff who are already picking. Consume stock when handed over/dispatched, according to the agreed store procedure. Release once on cancellation. Serialize cancellation, picking and reservation expiry transitions.

Online-payment follow-on: short-lived prepayment reservations, hosted checkout, verified provider callbacks, unique payment-event processing and amount/currency/order validation. Never trust a customer screenshot or redirect as payment proof. Reconcile late success after reservation expiry before fulfillment; route unavailable paid orders into explicit refund/staff handling.

## 9. Reliable webhooks and outbound sending

- GET verification checks subscription mode/token and returns the challenge. POST verifies `X-Hub-Signature-256` against raw request bytes with the app secret and constant-time comparison before trusting the content. Verification token and app secret are different credentials. Meta's [official SDK webhook reference](https://whatsapp.github.io/WhatsApp-Nodejs-SDK/api-reference/webhooks/start/) documents signature failure handling; implementation will validate against current API payloads rather than adopting that older SDK.
- Validate the business account/sender number scope, payload size and schema. Walk all entries/changes/messages; distinguish incoming messages from status callbacks. Unknown authenticated event types are recorded safely and acknowledged without customer-facing side effects.
- Commit durable inbox work before acknowledging success. If storage fails, return a retryable failure. Do no catalog matching or external sends inside the webhook request.
- Deduplicate inbound messages using scoped provider message IDs. Delivery-status events need a separate event key: one outgoing message can legitimately have multiple statuses.
- Workers use bounded backoff, timeouts and leases. Failed jobs become visible to staff with a safe replay action. Preserve ordering of prompts within a conversation, and reject obsolete actions instead of trusting arrival order.
- Store outbound intent before sending and the returned provider ID afterward. Accepted API submission does not mean delivered/read. Keep status history and prevent older callbacks from regressing the displayed state.
- A send timeout can mean Meta accepted a message. Mark ambiguous outcomes for reconciliation or cautious operator retry; do not promise exactly-once external delivery. Order idempotency remains independent of message delivery.
- Recheck consent, service window, template status and quote freshness at actual send time. Expired summaries are regenerated or suppressed. Apply account-aware throttling and handle provider rate limits without retry storms.

Keep replay/deduplication records beyond the verified provider redelivery horizon and operational replay period. Confirm that duration against accessible current Meta documentation before implementation; do not reject legitimate delayed deliveries solely because a timestamp is old.

## 10. Staff operations, privacy and security

The pilot needs a small protected staff interface: open orders, stock adjustments, pick/dispatch/deliver/cancel actions, conversation handoff queue, assigned staff owner, message history and policy-compliant replies. Include support contact details and actual support hours; do not promise round-the-clock human availability unless staffed.

Use a proven authentication mechanism, individual accounts, privileged MFA, role checks, secure sessions and audit trails. Check object ownership for every customer order lookup; provider IDs and order references are not authorization by themselves. Do not expose another customer's address through search or confirmation.

Keep credentials in local ignored environment configuration and deployment secret storage. Do not inspect or print existing `.env` values. Mask phone numbers and addresses in ordinary logs; exclude access tokens, complete webhook bodies and customer message contents from routine logs. Restrict transcript access and exports. Encrypt transport, production storage and backups.

Before live use, agree a privacy notice, support contact, transcript/raw-event retention, backup retention and deletion workflow. Retain financial/audit records only as required by the agreed jurisdiction and obligations; do not invent a legal retention duration. Deleting a transcript must not erase the deduplication protection needed to prevent a replayed order. Redact stored content separately from minimal event tombstones.

Serviceability, opening hours, order cutoffs, fees, tax and cancellation policies must be explicit configuration. Unsupported or restricted product categories from the supplied sheet need business review against Meta's policies before activation.

## 11. Verification and release gates

Each implementation milestone leaves focused tests. A successful demo alone is insufficient for live orders.

| Scenario | Required result |
| --- | --- |
| Invalid/missing signature, wrong verification token or account scope | No business mutation |
| Duplicate webhook, duplicate button or worker restart after commit | One cart change/order/reservation per intended action |
| Multi-event webhook and message-status-only webhook | Every relevant event handled without generating spurious replies |
| Two shoppers confirm the final unit | Exactly one reservation succeeds; no negative availability |
| Price/stock changes, quote expiry, old confirmation after edit | Fresh summary and confirmation required |
| Unknown/ambiguous item, pack/unit mismatch, unsupported language/media | Clarification or handoff; no invented SKU/price |
| Forged or cross-customer action/order reference | No unauthorized data access or checkout |
| Restart during conversation or staff handoff | State and staff ownership survive; bot stays paused |
| Provider outage, rate limit, ambiguous send timeout, reordered status events | Bounded retries, visible failures, no duplicate order or status regression |
| Window closes while a reply is queued; permission withdrawn | Correct template or suppression, including staff sends |
| Import preview, invalid file, repeated apply, changed preview source | No preview writes, atomic failure, no duplicate stock or unreviewed changes |
| Server/worker restart, migration or deployment with sheet present | No seeding or catalog/stock mutation |
| Order cancellation races with picking/dispatch | Valid state transition and exactly one stock release/consumption |
| Database backup/restore and job replay | Recoverable state, no repeated checkout effects |

Use isolated PostgreSQL integration tests for transaction/concurrency behavior and synthetic payload fixtures for provider events. Add Meta test-number end-to-end checks for receipt, clarification, confirmation and delivery callbacks. Before pilot, run a provisional load scenario of 20 simultaneous conversations and a short burst of 10 webhook requests/second; measure rather than claim capacity. Revise these targets when expected store volume is known.

Target webhook acknowledgment p95 below one second under the agreed pilot load, with no lost durably acknowledged events. Track response latency, pending job age, retry/failure counts, signature failures, handoff backlog, stock mismatches and notification failures. Alert on sustained worker/database failures and orders requiring staff intervention.

## 12. Implementation sequence and completion criteria

The following is the active build order. Each stage must demonstrate its exit condition before the next stage is considered complete. This is a plan, not authorization to deploy or start sending real customer messages.

### Stage 1: Express foundation and webhook transport

Deliver:

- Express 5 with strict TypeScript, separate application construction and listening entry point, validated configuration, structured/redacted logs, request IDs, liveness and database-readiness endpoints.
- A runtime `pg` pool with a least-privileged application role; keep the migration owner separate. Set connection/query timeouts and size the pool to the database's connection allowance. Do not expose the database credential or source metadata to clients.
- Extend the migration runner to apply numbered automation migrations while preserving migration `001` and its recorded checksum. The existing seed command remains an independent manual operation; neither server nor worker runs migrations or seeding on boot.
- `GET /webhooks/whatsapp` verifies the subscription challenge. `POST /webhooks/whatsapp` captures the raw request buffer before JSON parsing, validates the signature and business/number scope, and commits normalized messages/status events into the durable inbox before returning success.
- A Meta sender module using built-in `fetch`, configured API version and timeout; credentials are injected through environment configuration. Use a fake sender in ordinary tests and the Meta test number for the real integration check.

Exit: valid test messages are persisted once; forged events produce no mutation; a database failure is not acknowledged as success. Health checks work and startup demonstrably never touches catalog/stock data.

### Stage 2: Durable processing and a real reply

Deliver:

- A separately started worker that claims inbox rows with `FOR UPDATE SKIP LOCKED` and holds the conversation lock until its state/outbox commit. Outbound sends use ownership tokens and a lease; expired sends become uncertain rather than being reclaimed for automatic resend. Stale ownership tokens cannot complete the job.
- One active processor per conversation. Persist the conversation transition, processed event and outbound intent in one transaction; external sends happen afterward. Keep outbound prompt order per conversation and suppress obsolete prompts after a cart/state change.
- Scoped message deduplication, normalized sender identities with optional phone numbers, delivery-status history and bounded retries. Status callbacks never trigger a conversational reply by themselves.
- A basic greeting/help reply, retry/failure visibility, safe shutdown and a pause switch. Explicitly distinguish accepted, delivered, read, failed and uncertain sends.

Exit: a customer sends `hi` to the Meta test sender and receives the store greeting. Redelivering that inbound message or restarting the worker does not enqueue a second business reply. Unknown outcomes after outbound timeouts are flagged rather than blindly resent.

### Stage 3: Catalog-backed shopping and cart

Deliver:

- Search the existing active variants, current prices, aliases and `on_hand_qty - reserved_qty`; never search the internet during an order.
- A small deterministic parser for comma/newline-separated lists, explicit pack counts, brands and quantities. Normalize spelling/case and compatible mass/volume units. Ask when names, counts or units are unresolved.
- Persist customers, conversations, carts, cart lines and outstanding choice prompts. Support `help`, `cart`, `remove`, `change`, `cancel`, `checkout`, `agent` and `stop` with state-aware responses.
- Short numbered choices and supported interactive controls with text fallback. Bind every selection to sender, cart revision and current prompt. After three failed clarification attempts, offer staff handoff.
- Build customer messages from an explicit allowlist: name, brand, SKU/variant label, pack count, availability, price and permitted actions. Never serialize `source_metadata`, `source_url` or `image_source_url` into replies or action URLs. Optional images use media URLs only; broken images fall back to text.

Exit: shopping lists resolve to exact seeded SKUs, cart edits survive restart, and unknown items never create invented products. Required catalog edge cases:

| Request | Expected behavior |
| --- | --- |
| `2 milk 1 l, 1 kg rice` | Offer the matching Amul 1 L and India Gate 1 kg variants, with exact brand/pack labels before confirmation |
| `1 kg atta` | Explain that the seeded Aashirvaad SKU is 5 kg; ask whether to choose it or remove the item |
| `1 litre sunflower oil` | Do not equate 870 g with 1 L; show the stocked pack and request acceptance |
| `2 Vim bars` | Explain the stocked sellable pack is 4 x 190 g; do not charge for a single bar or assume two multipacks |
| `banana` | Show that demo stock is zero; offer removal or a genuine catalog alternative only |
| `soap` | Clarify bathing versus dishwashing if both are candidates; never substitute across purposes silently |

### Stage 4: Checkout, reservations and order creation

Deliver:

- Collect pickup/delivery choice and required fulfillment details. Validate service area/hours and calculate configured fees. Use COD/pay-at-pickup for the first demo; do not mark these orders paid.
- Create an immutable quote revision with a proposed 10-minute lifetime. Show all line quantities, exact packs, prices, tax treatment, fees, total, fulfillment details and payment method. Until real store tax/fee rules are configured, label the flow as a demo and block live checkout.
- Store money as PostgreSQL `NUMERIC`; calculate TypeScript totals in integer paise using exact decimal-string conversion, with an explicit tax/rounding policy. Never use JavaScript floating-point prices for checkout.
- A sender-bound, single-use quote confirmation key. Lock the cart/quote and affected stock rows in SKU order; revalidate price, stock, ownership, quote revision and expiration. Create one order, item snapshots, reservations and notification intent in the same transaction.
- Apply the order transitions `PLACED -> ACCEPTED -> PICKING -> READY -> DISPATCHED -> DELIVERED` for delivery; pickup uses `READY -> COLLECTED`. Support explicit rejection/cancellation transitions and release stock once. A `PLACED` order has reserved stock but is awaiting store acceptance.
- Keep reservation status separate: `ACTIVE -> CONSUMED` on dispatch/collection, or `ACTIVE -> RELEASED` on rejection/cancellation. Reservation/release changes `reserved_qty`; actual dispatch/collection reduces both on-hand and reserved quantities and adds one `sale` movement. Do not subtract stock twice.
- Do not silently expire COD reservations under staff who are picking. Alert on unaccepted/stale orders and require the configured cancellation policy or staff decision. Post-dispatch returns are a separate recorded stock/payment workflow.

Exit: two customers confirming the seeded final tomato pack produce one successful reservation; repeated confirmation returns the same order reference. A changed price, expired quote or edited cart forces a new summary. No payment success is inferred from a customer message.

### Stage 5: Staff operations and customer updates

Deliver:

- A small authenticated staff surface for incoming orders, acceptance/rejection, picking, ready, dispatch/collection, delivery, cancellation and failed jobs. Use the project's hosted auth provider once its configuration is confirmed; verify identity/roles server-side and audit every mutation. Do not build a custom password system.
- A handoff queue with a staff owner, transcript, reply capability, support hours and explicit bot resume. Automated shopping replies remain paused while a person owns the conversation.
- Sender-authorized `status <order-reference>` and order status notifications. Subscribe to utility-template status changes where supported, and centralize permission/window/template checks for both staff and automated sends.
- Consent records, opt-out handling, a support contact, minimal transcript retention and customer-data access restrictions. A customer sending `stop` must suppress queued proactive updates without silently canceling an order.

Exit: staff fulfills or cancels a test order, stock follows the right transition exactly once, and the customer receives permitted updates. Cross-customer order access and stale/forged staff actions fail safely.

### Stage 6: End-to-end validation and controlled pilot

Deliver:

- Test the full journey with Meta's test sender: shopping list -> clarification -> cart -> fulfillment details -> quote -> confirmation -> store acceptance -> fulfillment -> customer update.
- Exercise duplicate and out-of-order events, lease expiry, restart, provider outage, slow database, stale buttons, opt-out, expired messaging window, invalid signatures, restricted staff access, final-unit contention and broken media. Assert that no outbound text/button contains retailer/source destinations.
- Separate fake-provider tests, database integration tests and manually invoked real-Meta smoke tests. Keep demo checkout visibly separate from any production deployment.
- Provision HTTPS, secrets, approved templates, alerting, backup/restore and an incident runbook. Pause new automated orders during an incident while preserving securely accepted events where possible.
- Staff trial first; then a small invited customer pilot only after prices, stock, fees, taxes, delivery rules, support ownership and privacy requirements are approved for that environment.

Exit: the acceptance matrix in section 11 passes, the store can operate the staff workflow, recovery has been exercised, and no critical messaging or inventory errors remain. Measure response time and queue age during the pilot before increasing volume.

### Database work after migration 001

| Proposed migration | Main additions | Important constraint |
| --- | --- | --- |
| `002_whatsapp_transport` | Scoped WhatsApp identities, inbox events, outbound jobs and delivery status history | Unique inbound event keys; unique business-effect/outbound-intent keys; job lease ownership |
| `003_conversations_cart` | Customers, conversations, cart lines and choice prompts | One active cart per conversation; positive integer pack counts; version-bound choices |
| `004_checkout_orders` | Quotes, quote lines, orders, immutable order lines, reservation records and status history | One order per confirmed quote; nonnegative stock; unique reserve/consume/release operations |
| `005_staff_consent_audit` | Staff authorization mappings, handoff ownership, communication permissions and audit events | Object/role authorization; explicit support ownership; permission checks at send time |

Names are planned until implementation. Add the migrations when their stage needs them rather than creating unused tables now. Extend the existing catalog tables; do not reseed, rename SKUs, or rewrite migration 001. Keep `grocery_dev` for this demo; production needs a separate reviewed schema/environment and real store data.

### Runtime/API contracts to implement

| Boundary | Contract |
| --- | --- |
| Public webhook | `GET /webhooks/whatsapp`, `POST /webhooks/whatsapp` |
| Operational health | `GET /health/live`, `GET /health/ready` with minimal responses |
| Catalog | Internal `searchCatalog(query)` returns a safe variant projection, current price and availability |
| Conversation | Internal `handleMessage(event)` persists a state transition and outbound intents atomically |
| Checkout | Internal `createQuote(cartRevision)` and `confirmQuote(sender, quote, actionToken)` |
| Staff | Protected order listing/transitions, handoff claim/reply/resume and failed-job review; no unrestricted public send endpoint |

Keep WhatsApp formatting outside catalog/order logic so a later website reuses checkout. Runtime commands `npm run dev`, `npm start` and `npm run worker` are implemented. The explicit `npm run db:migrate` command applies numbered migrations with checksums; migration 002 adds transport state. `npm run seed` remains a separate operator command. Fake-message, queue-status and definitive-failure retry commands are documented in the setup guide.

### External setup and outstanding business inputs

Local fixtures allow stages 1-4 to progress without live messaging credentials. A real Meta round trip in stages 1-2 needs a configured test sender/recipient, business-account and phone-number IDs, app secret, verify token, access token, supported API version and a reachable HTTPS callback. Do not paste credentials into chat; add them through environment configuration when implementing.

Before pilot: settle store name/contact, support owner/hours, language expectations, pickup address, delivery area, fee/minimum, tax policy, COD acceptance, staff acceptance/cancellation rules and expected volume. These do not block fixture-based development; they do block an honest live checkout.

The first concrete implementation slice is **stages 1 and 2: receive a verified message, persist it, and send one reliable test reply**. The fake-provider path is implemented; the real Meta smoke test and runtime credential provisioning remain exit checks. Catalog-backed shopping is the next feature slice. Online payment, invoice PDFs, voice/photo interpretation, marketing, customer website and predictive inventory follow after the ordering pilot.

## 13. Costs, rollout and recovery

Budget separately for application/worker hosting, PostgreSQL/backups, Meta billable messages, domain/HTTPS, optional model extraction, and later payment/object-storage fees. Meta's [pricing page](https://business.whatsapp.com/products/platform-pricing) currently describes delivered-message pricing dependent on market and message category, with applicable free-message cases. Do not use an old flat conversation-price estimate. Estimate monthly cost using the applicable published rates and expected billable delivered messages; add any provider markup if a BSP is selected.

Deploy separate staging/production configurations with HTTPS and a stable webhook URL. Review migrations and back up before changes. On startup check schema compatibility; run migrations as an explicit deployment step. Provide health checks, graceful worker shutdown, log redaction, failure alerts and a tested restore procedure. Agree recovery objectives and the staff response to an outage before launch.

Use a staff-controlled automation pause: continue securely accepting durable events where possible, stop new automated checkout, and display an honest support fallback. During recovery, replay only eligible unprocessed work; stale confirmations must not become new orders. Reconcile already accepted orders and stock before resuming. A code rollback must not blindly reverse stock movements or drop customer/order data.

## 14. Inputs needed before the affected implementation/launch step

The researched starter dataset is available for development/staging. A real store sheet remains necessary before production import; the following choices can be resolved alongside reviewing the data:

- Store currency, tax treatment, pack/loose-goods rules, stock accuracy and SKU conventions.
- Delivery zones, pickup address, hours, fees/minimum, cancellation policy and staff acceptance workflow.
- Required customer languages, expected daily/peak volume and support hours/owners.
- COD/pay-at-pickup acceptance; whether online payment or invoice PDF is mandatory for the pilot.
- Meta account/number readiness and whether the existing business number must be preserved.
- Hosting/budget, privacy/retention rules and backup/recovery expectations.

Defaults in this document allow planning to proceed, but customer-facing rules must be settled before live orders. Do not request credentials in chat; configure them through the local environment or deployment secret controls when needed.

## 15. Source verification limits

Checked official Meta policy/pricing pages, Meta's Cloud API collection, Meta's usernames briefing and its historical SDK reference on 28 October 2026. Some developer documentation pages returned HTTP 429 during planning. Exact current Graph API version, webhook schema, retry horizon, account-specific limits, number coexistence eligibility and template approvals remain implementation setup checks. This plan does not claim those account-specific checks have passed.

For the planning revision, rechecked the [Meta Cloud API setup collection](https://www.postman.com/meta/whatsapp-business-platform/collection/wlk6lh4/whatsapp-cloud-api), [current messaging policy](https://whatsappbusiness.com/policy/) and [Express 5 API reference](https://expressjs.com/en/5x/api/express/). During implementation, migration 002 was explicitly applied and fake-provider HTTP/database checks were run. Meta account access and a real test-message exchange have not been verified; no real customer messages have been sent.
