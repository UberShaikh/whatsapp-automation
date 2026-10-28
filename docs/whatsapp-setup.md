# WhatsApp transport: run and verify

Implemented: Express receiver, signed webhook verification, durable PostgreSQL inbox/outbox, separate worker, greeting/help replies, opt-out/support pause, delivery-status reconciliation, bounded rate-limit retry and a scoped operator status/retry command.

Shopping-list resolution, carts, order creation, payments and the authenticated staff inbox are the next stages. Current replies explicitly say that ordering is not available yet. No production deployment or real Meta round trip has been completed.

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

This checks migration 001's existing checksum and adds migration 002. Repeat runs check checksums and skip applied migrations. Neither migration imports products. Keep product seeding as a separate manual operation. Server and worker startup only check the schema; they never migrate or seed automatically.

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

`accepted` means submission was accepted, not delivered or read. A fake reply is a database simulation, not a message visible in the WhatsApp app. Status output excludes phone numbers, message bodies and tokens. To inspect the exact demo reply, use a trusted database connection and restrict the query to the known test identity/job; never publish a transcript endpoint for convenience.

Try `--text help`, `--text stop` or `--text agent` with new message IDs. `agent` sends the configured support contact and pauses ordinary bot replies for that identity. It does not connect a staffed in-chat agent yet. `help`, `stop` and `resume` remain available; `resume` restores permission for future order updates, not marketing consent, and does not remove a human-support pause. Staff claim/reply/resume controls come in stage 5.

Set `AUTOMATION_PAUSED=true` and restart the worker to stop new automated processing/sending while the receiver continues durable intake. Monitor the pending backlog before resuming. Requests already in flight may finish; pausing does not retract a message.

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
SUPPORT_CONTACT=<real-support-phone-or-contact-details>
```

Use an HTTPS reverse proxy or an explicitly configured development tunnel pointing to the local receiver, then register `/webhooks/whatsapp` and subscribe the app/account to the needed message events. Expose only approved routes. No tunnel or external hosting has been started by this implementation. When listening behind a container/proxy, set `HOST` deliberately; the default is loopback. Put provider-appropriate request throttling and TLS at that ingress before any exposed pilot; the application enforces payload/time limits but is not an Internet-edge rate limiter.

Restart server/worker, send `hi` from the approved recipient and inspect the job/delivery callbacks. Only configured test-recipient IDs can enter the Meta shopping-reply path; outbound sending repeats this check. Changing fake mode to Meta does not send old fake jobs: transport mode is part of identity and message scope.

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

The demo runtime uses the configured `DATABASE_URL`; the project currently provides only that database connection. Do not expose a pilot using a database-owner credential. Have the database administrator provision a separate runtime login and grant only schema usage, read access to `schema_migrations`, and the required select/insert/update permissions on the four `wa_` tables plus usage/select on their identity sequences. Catalog tables need read access only when stage 3 is added. Use owner credentials only for explicitly invoked migrations. Runtime credential provisioning and production rollout remain outstanding.

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

Still unverified: real Meta round trip, approved templates, BSUID field compatibility on the selected account/API version, exposed-ingress throttling/load targets, dedicated runtime credentials, production retention and staff operations. These are explicit release gates rather than claimed capabilities of this first slice.
