# Merchant inventory frontend

The merchant app is in `web/`: Next.js App Router, Tailwind v4, shadcn/Radix, Public Sans, React Hook Form/Zod and TanStack Table. Express remains the inventory service. Both use the existing isolated `grocery_dev` database; production is not enabled. No migration or seed runs on server startup. The existing WhatsApp receiver/worker commands stay separate.

Implemented screens: sign-in, signup, email confirmation callback, password recovery/reset, inventory, stock history and account. Inventory has search by product/brand/SKU, stock/category filters, sorting, pagination and column visibility. Receive, remove and recount operate in sellable packs with a required reason, expected quantities, an idempotency key and an audit movement. A stock count cannot fall below its reserved quantity. Stock history includes opening balances, merchant adjustments and order-collection sales (latest 100 records). Low stock means 1–5 available packs. Prices and product details are read-only in this slice.

## Local UI preview

```powershell
npm ci
npm --prefix web ci
npm run web:preview
```

Open [the inventory preview](http://127.0.0.1:3100/preview). The preview server binds only to loopback. It reads a safe projection of the manual seed file, uses local browser state and never calls the inventory API or writes the database. A visible preview notice stays on screen. Adjustments update the table, totals and local history; reloading resets them. This is not a sign-in bypass for actual inventory. `/preview` is disabled unless explicitly enabled by this command, and always disabled in production builds. Retailer links and source metadata are excluded.

## Connect accounts

Keep the existing root `.env`. Add these fields from `.env.example` without replacing the database connection:

```dotenv
SUPABASE_URL=https://<your-project>.supabase.co
SUPABASE_PUBLISHABLE_KEY=<your-project-publishable-key>
MERCHANT_API_PORT=3001
MERCHANT_API_URL=http://127.0.0.1:3001
MERCHANT_WEB_URL=http://127.0.0.1:3100
```

Use the same Supabase project as `DATABASE_URL`. No service-role/secret key is needed. Auth calls run on the Next.js server; public configuration does not need a `NEXT_PUBLIC_` alias. Sessions use HTTP-only, SameSite=Lax cookies, Secure in production. Server-side user verification and an explicit active merchant-access record protect each inventory operation. User metadata never grants access. Anonymous and unconfirmed-email accounts cannot manage inventory.

In Supabase Auth, enable email/password and email confirmation, set the site URL to `http://127.0.0.1:3100`, and allow both callback URLs:

- `http://127.0.0.1:3100/auth/callback`
- `http://127.0.0.1:3100/auth/callback?next=/reset-password`

Configure your email delivery provider for confirmation/reset emails. Keep confirmation links in the same browser for the PKCE exchange. Use the registered web origin for real hosting; HTTPS and Secure cookies are required. The callback only accepts the inventory or password-reset destination. See [Supabase SSR setup](https://supabase.com/docs/guides/auth/server-side/creating-a-client?framework=nextjs) and [password authentication](https://supabase.com/docs/guides/auth/passwords).

Stop the preview server before starting the normal frontend on the same port. In separate terminals:

```powershell
# Explicit migration; does not import products or grant access.
npm run db:migrate

# Terminal 1: authenticated Express inventory service, loopback port 3001.
npm run merchant:dev

# Terminal 2: Next.js frontend, loopback port 3100.
npm run web:dev
```

Restart both after changing settings. Open [sign-in](http://127.0.0.1:3100/login), create your account and confirm its email. A new account waits for approval. No merchant accounts, passwords or grants are created by startup/migration.

## Grant the first merchant access

The database owner explicitly grants an existing confirmed Supabase user access to the demo store. Find that account's UUID in the project's Auth Users dashboard, then run:

```powershell
npm run merchant:access -- --user <confirmed-user-uuid>
# Revoke when needed; retains audit history:
npm run merchant:access -- --user <confirmed-user-uuid> --revoke
```

The command checks `auth.users` in this database. It never grants access based on an email typed into a form or client-supplied metadata. The runtime does not need permission to grant/revoke access. Current scope is one shared demo store; self-service store creation and multiple merchant stores are future work.

## Stock safety and recovery

Every adjustment locks the active membership and stock balance, verifies the displayed on-hand/reserved counts, updates on-hand only and inserts the movement plus merchant audit row in one transaction. A duplicate key with the same merchant/payload returns the original result; reusing a key for different content is rejected. A stale form returns a conflict and refreshes current quantities. Confirmed WhatsApp orders still own their holds; use the order workflow to cancel/release them. Recounts include reserved packs physically on hand.

If a save cannot be confirmed, refresh inventory and check stock history before creating another adjustment. Revocation takes effect on subsequent operations, including duplicate-save requests. Reasons are required (3–200 characters). Never delete audit/reservation records to change stock.

Before exposing this beyond local development, provision a separate runtime database login with only schema/migration reads, catalog reads, active membership reads/row locking, stock balance reads/updates, stock movement reads/inserts, merchant-audit reads/inserts and required sequence privileges. Keep membership writes and `auth.users` reads limited to the owner CLI. `FOR SHARE` membership locking needs PostgreSQL UPDATE privilege on at least one membership column: narrow this grant or use a reviewed database function before a pilot. Keep the merchant API private behind the frontend; only the same-origin frontend endpoint accepts browser saves and checks Origin. The API requires a verified bearer token for every merchant route. Hosted Auth rate limits protect provider calls; production ingress limits, MFA policy, production database isolation and real store onboarding remain rollout work.

## Checks

```powershell
npm run typecheck
npm run web:typecheck
npm test
npm run web:test
npm run web:build
$env:MERCHANT_INTEGRATION_TEST='1'
node --test tests/merchant.integration.test.ts
```

The merchant database test rolls back stock changes, fake access mappings and audit rows, then compares the original stock snapshot. It does not create Supabase accounts or send emails. Existing WhatsApp database tests retain their separate opt-in flags.

Verified on 28 October 2026: 35 local regression/unit/HTTP checks, two frontend form/stock checks and one merchant database scenario passed. Production compilation and strict types passed. The in-app browser checked desktop/mobile inventory, search, stock tabs, pagination, column visibility, an invalid reason, a two-pack receipt with local history, mobile drawer navigation, account appearance, and account-form validation. Database counts remained 33 variants / 792 on-hand / zero reserved; no committed merchant adjustments or access grants were left by tests. See the [design and fidelity notes](design/merchant-ui.md).

Not verified against a real account: signup, email delivery, confirmation, password recovery, session refresh and approved merchant login. These require the configured Supabase settings and user confirmation; the UI explicitly disables authentication while settings are missing. Development tooling currently reports three low-severity advisories in the shadcn CLI dependency tree; production dependency audit has zero known advisories. No forced downgrade was applied.
