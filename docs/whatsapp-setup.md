# WhatsApp automation: run and verify

Implemented: Express receiver, signed webhook verification, durable PostgreSQL inbox/outbox, separate worker, catalog-backed shopping lists, persistent carts, scoped product choices, greeting/help replies, opt-out/support pause, delivery-status reconciliation, bounded rate-limit retry and scoped operator commands.

Demo pickup checkout, order snapshots, atomic stock reservations and operator pickup commands are implemented. Online payments and the authenticated staff inbox remain future stages. No production deployment or real Meta round trip has been completed.

## 1. Configure local fake mode

Use Node.js 24.12+ and run `npm ci`. Keep the existing private `.env` and database URL. Add the transport fields from `.env.example` to it; do not overwrite existing credentials. The environment file is ignored by Git. Never paste credentials into chat or logs.

For the first local run use:

```dotenv
APP_ENV=development
WHATSAPP_MODE=fake
WHATSAPP_APP_SECRET=<generate-a-long-random-secret>
WHATSAPP_VERIFY_TOKEN=<generate-a-different-random-token>
WHATSAPP_BUSINESS_ACCOUNT_ID=local-demo-account
WHATSAPP_PHONE_NUMBER_ID=local-demo-number
STORE_NAME=Grocery Store Demo
SUPPORT_CONTACT=Contact the store operator
HOST=127.0.0.1
PORT=3000
AUTOMATION_PAUSED=false
```

The placeholders above are instructions, not actual credentials. Generate each local secret separately, for example with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`. Fake mode performs no external message send. Synthetic recipient IDs are stored only in the development database.

Run the migration explicitly once after updating the code:

```powershell
npm run db:migrate
```

This checks existing migration checksums and applies missing numbered migrations: 002 adds transport state; 003 adds carts, cart lines and snapshotted product choices; 004 adds demo checkout quotes, orders, reservations and audit history. Repeat runs skip applied migrations. No migration imports products or changes opening stock. Keep product seeding as a separate manual operation. Server and worker startup only check the schema; they never migrate or seed automatically.

## 2. Start the server and worker

Use separate terminals from the project root:

```powershell
# Terminal 1
npm run dev
```

```powershell
# Terminal 2
npm run worker
```

`npm start` runs the server without file watching. Configuration is loaded on process startup; restart the processes after changing it. `GET /health/live` reports process liveness. `GET /health/ready` checks the required migration versions and reports whether automation is paused, without exposing credentials.

Send a signed local test message from a third terminal:

```powershell
npm run whatsapp:fake-message -- --text hi --message-id demo-message-1
npm run whatsapp:status
```

The receiver returns 200 after committing the inbox. The worker stores one greeting job and the fake sender marks it `accepted` with a `fake.` provider ID. Allow for worker polling/database latency before inspecting status. Re-running the same `--message-id` must not create another reply; use a new ID for a new intended message.

`accepted` means submission was accepted, not delivered or read. A fake reply is a database simulation, not a message visible in the WhatsApp app. Status output excludes phone numbers, message bodies and tokens. Add `--wait` to the local fake-message command to print its own synthetic recipient's saved reply; this is disabled in Meta mode and never exposes a transcript endpoint. Ordinary server/worker logs still omit message bodies.

Try `--text help`, `--text stop` or `--text agent` with new message IDs. `agent` sends the configured support contact and pauses ordinary bot replies for that identity. It does not connect a staffed in-chat agent yet. `help`, `stop` and `resume` remain available; `resume` restores permission for future order updates, not marketing consent, and does not remove a human-support pause. Staff claim/reply/resume controls come in stage 5.

Set `AUTOMATION_PAUSED=true` and restart the worker to stop new automated processing/sending while the receiver continues durable intake. Monitor the pending backlog before resuming. Requests already in flight may finish; pausing does not retract a message.

### Try phase 2: shopping lists and saved carts

With the server and worker running in fake mode:

```powershell
npm run whatsapp:fake-message -- --text "2 milk 1 l, 1 kg rice" --wait
npm run whatsapp:fake-message -- --text "cart" --wait
npm run whatsapp:fake-message -- --text "change 1 3" --wait
npm run whatsapp:fake-message -- --text "remove 2" --wait
npm run whatsapp:fake-message -- --text "cancel" --wait
```

All these local commands use the same synthetic customer identity. Each command generates a fresh message ID unless one is explicitly supplied. The first list has an INR 397.00 demo items subtotal from the current seed prices (two 1 L milk packs and one 1 kg rice pack); later live catalog changes can alter it. Cart views always re-read current prices/availability, and stock is never held or deducted by cart operations.

For a pack mismatch:

```powershell
npm run whatsapp:fake-message -- --text "2 Vim bars, 1 kg rice" --wait
# Copy the 16-character code from the reply:
npm run whatsapp:fake-message -- --text "choose <code> 1" --wait
```

Two Vim bars cannot be sold from the seeded four-bar multipack. The bot offers one clearly labeled pack of 4 x 190 g and adds it only after selection. It then continues with the remaining rice request. Similarly, 1 kg atta needs acceptance of the stocked 5 kg pack; litres are never silently treated as grams for the 870 g oil SKU.

Supported text controls:

- `CART`: all current cart lines, prices, availability warnings and an estimated items subtotal.
- `CHOICES`: fresh options and a new code for the pending item; previous codes stop working.
- `CHOOSE <code> <number>`: accept one exact displayed pack/quantity. Codes belong only to the current sender/cart and expire after ten minutes.
- `REPLACE <code> <one item>` or `SKIP <code>`: resolve an unknown/unavailable item and continue the stored remainder of the list.
- `CHANGE <line> <packs>` and `REMOVE <line>`: edit by stable line number. Edits refresh pending choice codes; deleted line numbers are not reused.
- `CANCEL`: clear the cart and all pending choices. It never cancels an order because order creation is not implemented yet.

Input limits are ten comma/newline/semicolon/`and`-separated items per message, twenty distinct cart lines and 1-99 whole sellable packs per item. Quantities may be expressed as compatible weights/volumes; loose fractional sellable packs are not supported. Unknown brands do not fall back to an arbitrary brand. Search uses active database variants and aliases, not an Internet search or a language model. Full Hindi/Hinglish sentences, misspelling correction and voice/photo interpretation remain unsupported; known aliases such as doodh/chawal/namak work.

Only up to three available product options are displayed; refine the brand or product with `REPLACE` when needed. If no options are available, use `REPLACE`, `SKIP` or remove an existing cart line if the cart is full. Resolve a pending item before sending another list. Three invalid replies to the current choice pause shopping for human help, preserving the cart and unfinished request. `AGENT` also preserves that state.

Selections re-read active status, stock, price and pack details. Changed terms cause a fresh choice instead of a silent addition. Stale codes, copied codes from another sender and repeated webhook deliveries do not add items again. Delayed cart mutations older than the most recently applied action are ignored. Two different customers may both place the final unit in their carts: carts do not reserve stock. Confirmation locks shared inventory and checks every line before creating any hold.

Customer messages are built from a safe catalog projection; retailer/source URLs and `source_metadata` never enter replies. This phase uses text choices, not native interactive buttons or product-image sends. Images remain internal catalog assets for a later media step.

### Demo pickup checkout and stock

Send `CHECKOUT` to review every exact pack, quantity, unit price and line total. The quote lasts 10 minutes and does not reserve stock. It explicitly labels pickup, unpaid/pay-at-pickup, demo fees/taxes of zero and the lack of a real pickup location or purchase. Unresolved item choices must be completed first.

Send `CONFIRM <checkout code>` from the same conversation to recheck the cart revision, store name, expiry, active variants, physical packs, prices and stock. Changed terms require a fresh `CHECKOUT`. Confirmation creates one order, holds every stock line, clears the cart and queues the response together in one transaction. Repeating the code returns the same order; it cannot place a second order. Failed lines roll back the whole transaction.

Send `STATUS` or `STATUS D-<reference>` for your own orders. `CANCEL` only clears the cart. `CANCEL ORDER D-<reference>` releases all held packs while PLACED or ACCEPTED; after picking, ask the operator. Status and explicit order cancellation remain available during a support pause.

Use trusted local operator commands, scoped to the configured account, sender number and transport mode:

```powershell
npm run orders
npm run orders -- --order D-012345ABCDEF --action accept
npm run orders -- --order D-012345ABCDEF --action pick
npm run orders -- --order D-012345ABCDEF --action ready
npm run orders -- --order D-012345ABCDEF --action collect --cash-received
# Alternatives before collection:
npm run orders -- --order D-012345ABCDEF --action cancel
npm run orders -- --order D-012345ABCDEF --action reject
```

Replace the example reference with the actual reference from confirmation. The lifecycle is PLACED → ACCEPTED → PICKING → READY → COLLECTED. Rejection is allowed before acceptance; operators may cancel any uncollected order. Release and consumption are atomic and idempotent. Collection alone reduces on-hand stock and writes a sale movement; it requires explicit demo cash acknowledgement and records DEMO_CASH_RECORDED. This does not process real cash or online payment. Operator commands audit the database role; they do not send proactive WhatsApp notifications. Customers request `STATUS`.

Pending quotes expire automatically by timestamp. Confirmed pay-at-pickup holds remain until cancellation, rejection or collection; they are not automatically abandoned during picking. `npm run orders` flags PLACED orders older than 30 minutes for review. Review these regularly and cancel/reject abandoned demo orders. Confirmed order/history references intentionally prevent deleting a customer or quote without reconciling stock first. Do not delete reservation records to release stock.

## 3. Connect a Meta test number

Prepare the assets described in Meta's [official Cloud API collection](https://www.postman.com/meta/whatsapp-business-platform/collection/wlk6lh4/whatsapp-cloud-api): app, business account, test sender number and approved test recipient. Configure the app secret, webhook verify token, access token, actual business-account/phone-number IDs and an explicitly selected supported API version. Do not migrate/delete an existing business number as a setup assumption.

Then configure:

```dotenv
WHATSAPP_MODE=meta
WHATSAPP_BUSINESS_ACCOUNT_ID=<actual-business-account-id>
WHATSAPP_PHONE_NUMBER_ID=<actual-sender-phone-number-id>
WHATSAPP_APP_SECRET=<actual-meta-app-secret>
WHATSAPP_VERIFY_TOKEN=<your-webhook-verification-token>
WHATSAPP_ACCESS_TOKEN=<your-meta-token>
WHATSAPP_API_VERSION=<supported-version-in-vNN.0-format>
WHATSAPP_TEST_RECIPIENTS=<exact-test-recipient-provider-id>
PUBLIC_BASE_URL=https://<your-public-receiver-host>
SUPPORT_CONTACT=<real-support-phone-or-contact-details>
```

Use an HTTPS reverse proxy or an explicitly configured development tunnel pointing to the local receiver, then register `/webhooks/whatsapp` and subscribe the app/account to the needed message events. Expose only approved routes. No tunnel or external hosting has been started by this implementation. When listening behind a container/proxy, set `HOST` deliberately; the default is loopback. Put provider-appropriate request throttling and TLS at that ingress before any exposed pilot; the application enforces payload/time limits but is not an Internet-edge rate limiter.

Restart server/worker, send `hi` from the approved recipient and inspect the job/delivery callbacks. Only configured test-recipient IDs can enter the Meta shopping-reply path; outbound sending repeats this check. Changing fake mode to Meta does not send old fake jobs: transport mode is part of identity and message scope.

For a recorded end-to-end check, run `npm run whatsapp:verify -- --wait`. If several recipients are allowlisted, add `--recipient <exact-provider-id>`. It checks the public HTTPS readiness endpoint and webhook challenge, then prints a unique `VERIFY <nonce>` to send from the approved WhatsApp recipient. Keep server and worker running. The command only reads evidence; the ordinary worker replies to that genuine customer message. Repeat with `--nonce <printed-code> --wait` if the two-minute wait expires. Verification passes only when a recent Meta inbound, its correlated `wamid.` outbound and a signed delivered/read callback are stored in the configured Meta scope. API acceptance and fake/sent statuses cannot pass. Do not post fabricated Meta inbound events or change timestamps to simulate the service window.

The normalizer supports legacy numeric `from` and BSUID `from_user_id` identities without requiring a phone number. The sender uses `to` for legacy phone recipients and `recipient` for BSUID recipients. Meta's current developer pages returned HTTP 429 during research; verify these fields with the selected API version's real test payloads before claiming compatibility. No existing identities are automatically merged by display name or username.

## 4. Delivery/retry and recovery rules

- Message receipts are deduplicated by business account, sender number, transport mode and provider message ID. No successful acknowledgment is sent before durable storage commits.
- Inbox state changes and outbound intents commit together under database row locks. A crash rolls back unfinished processing. Different workers skip locked rows; one conversation is processed in receipt order.
- Outgoing sends claim a 60-second lease with a unique ownership token and per-attempt callback key. External API calls run outside database transactions and time out after 15 seconds. Status callbacks can reconcile a send even when its HTTP response was lost.
- A definite HTTP 429 rejection is retried up to five attempts with 5/30/120/600-second waits. Each attempt rechecks current reply revision, exact recipient allowlist and the 24-hour customer-service window.
- Network failures, timeouts, 5xx responses, malformed successful responses and expired send leases are `uncertain`. They are never blindly resent. A later signed delivery callback can resolve them; otherwise inspect Meta/provider records manually. An uncertain job does not prevent replying to a genuinely new customer message.
- Definite client/API rejections become `failed`. After fixing the cause, an operator may request an explicit retry:

```powershell
npm run whatsapp:status -- --retry <failed-job-uuid>
```

This command is scoped to the configured account/number/mode, records the database operator and retry count, and only queues `failed` jobs. It refuses `uncertain` jobs. Each retry uses a new callback key, so old attempt callbacks cannot overwrite it. It cannot override window, allowlist or obsolete-reply suppression.

- Delivery statuses are recorded once and applied monotonically; old `sent` callbacks cannot regress `read`. Status-only events never generate customer replies.
- The first slice sends only customer-requested service replies. Expired windows suppress the reply; approved template sending is not implemented yet. Later order notifications must follow the [WhatsApp messaging policy](https://whatsappbusiness.com/policy/).
- Only a newer generated reply supersedes an unsent greeting/help prompt. Already accepted messages cannot be withdrawn. No catalog/source URL is inserted in these text replies, and link previews are disabled.

## 5. Database permissions and development limits

The demo runtime uses the configured `DATABASE_URL`; the project currently provides only that database connection. Do not expose a pilot using a database-owner credential. Have the database administrator provision a separate runtime login with schema usage, catalog/schema read access, transport/cart/prompt permissions, quote/order/reservation/event select/insert/update permissions, stock balance select/update, stock movement select/insert, and usage/select on identity sequences. Checkout locks product/brand/current-price rows, so PostgreSQL also requires UPDATE privilege on at least one column of those tables for `SELECT FOR UPDATE`; narrow column grants or a reviewed database function should constrain that before a pilot. Runtime code does not modify catalog/price rows. Owner credentials are for explicit migrations. Runtime credential provisioning and production rollout remain outstanding.

The application currently rejects production environment settings because it targets `grocery_dev` and demo inventory. It stores minimal message text needed for processing; raw webhook bodies, tokens, phone numbers and message contents are excluded from routine logs. Keep access to stored conversations restricted. Agree and implement retention/deletion and a real staff operations surface before a live pilot.

## 6. Verification

```powershell
npm run typecheck
npm test

# Explicit database tests; synthetic identities are deleted afterwards.
$env:WHATSAPP_INTEGRATION_TEST='1'
$env:SEED_INTEGRATION_TEST='1'
npm test
```

The HTTP tests open temporary loopback listeners. Database tests use unique synthetic account scopes and clean up their transport rows; seed tests roll back temporary stock/price changes. No test calls the real Meta sender. Do not run these tests against production. Verify the catalog still contains 33 variants and 792 demo packs after the checks.

Verification on 28 October 2026: strict type checks passed; 9 seed tests, 15 HTTP/configuration/sender unit tests, 10 transport database scenarios and 1 actual server/worker/CLI smoke test passed across suite and focused reruns. Initial database checks exposed and corrected an inbox parameter-count error; a repeated-status fixture was corrected to retain the same timestamp. A temporary database/DNS interruption required a rerun with a shared test pool. Final read-only verification matched every seeded price, stock quantity and image URL, confirmed 33 variants/792 packs/one seed import, and found no remaining synthetic transport identities or status rows. This is not a load-test result or a real Meta delivery claim.

Phase 2 verification on 28 October 2026: 9 parser/catalog tests, 9 PostgreSQL shopping scenarios (including the cart-size check), all 15 HTTP/configuration/sender tests, all 10 existing transport database scenarios, and the extended actual server/worker/CLI smoke test passed across focused runs: 44 checks. Tests covered quantity/pack conversion, unknown brands, ambiguous soap, out-of-stock and partial-stock choices, cross-customer codes, repeated/stale/expired selections, changed offered prices, cart persistence/edits/cancel, stable line numbers, limits and delayed mutations. The CLI smoke test built and re-read the INR 397.00 sample cart using `--wait`. Manual migration reruns remained a no-op. Catalog and inventory checks are read-only; no stock is reserved or deducted by cart operations.

Demo checkout verification on 28 October 2026: type checks, 32 local unit/HTTP checks, 3 checkout database scenarios and the extended running server/worker/CLI scenario passed across focused runs (36 checks). Three opt-in seed database cases were skipped in this run; no reseeding was performed. Checks covered sender ownership, expired/changed quotes, price/cart/stock revalidation, a 20-line review within WhatsApp limits, all-or-nothing holds, competing customers, repeated confirmation, operator transitions, explicit demo cash acknowledgement, exactly one collection sale, customer cancellation and one-time release. The running fake transport placed the INR 397.00 order, reserved three packs, accepted it through the operator command, read status and cancelled it. Test collection changes rolled back; committed test holds were released and test records removed. The final catalog snapshot retained every price, image, stock quantity, seed-import count and movement count. The Meta verifier rejects API acceptance or fake IDs as delivery proof; no real Meta messages were sent.

Still unverified: real Meta round trip, approved templates, BSUID field compatibility on the selected account/API version, exposed-ingress throttling/load targets, dedicated runtime credentials, production retention and staff operations. These are explicit release gates rather than claimed capabilities of this first slice.
