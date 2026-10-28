# Grocery Store Omnichannel Commerce & Predictive Inventory Platform

A microservices-based grocery commerce platform that enables customers
to shop through a web application or WhatsApp, while store
administrators manage the catalog, inventory, orders, fulfillment, and
business analytics. The platform uses PostgreSQL for transactional data
and predictive analytics to estimate product demand and identify
stockout risk.

> **Project status:** Architecture / implementation in progress\
> **Architecture:** Domain-oriented microservices\
> **Primary database:** PostgreSQL\
> **Customer channels:** Web application and WhatsApp Business Platform\
> **Analytics:** Demand forecasting and stockout-risk estimation

> **Current implementation priority:** WhatsApp ordering first. See the
> [WhatsApp automation implementation plan](docs/whatsapp-automation-plan.md)
> for scope, architecture, milestones, and release gates. A researched
> [Indian household grocery seed dataset](data/seed/README.md) is available
> for development/staging; its manual PostgreSQL importer is implemented.
> The 33-product demo catalog is seeded in the isolated `grocery_dev` schema.
> The Express webhook receiver and durable worker are implemented for the
> first transport slice. Catalog-backed shopping, product clarification and
> persistent demo carts, confirmed demo pickup orders and atomic stock holds are implemented.
> Pickup lifecycle commands support acceptance, picking, readiness, collection and cancellation.
> See [WhatsApp setup](docs/whatsapp-setup.md) for
> fake-mode testing, manual migrations, runtime commands and Meta test setup.
> The real Meta round trip still needs account credentials and an HTTPS callback.
> Source product links are internal references and will never redirect customers
> from WhatsApp. Product seeding will be a separate manual preview/apply
> operation and will never run on server startup.

> **Merchant frontend:** Inventory, stock adjustments/history and account screens now use
> Next.js, Tailwind v4 and shadcn following [STYLE.md](STYLE.md). Supabase handles
> merchant signup/sign-in; approved store access is granted explicitly. See
> [merchant setup](docs/merchant-setup.md). Run `npm run web:preview` for the local
> UI preview; its stock changes stay in the browser.

------------------------------------------------------------------------

## Contents

-   [Overview](#overview)
-   [Core Features](#core-features)
-   [Product Catalog and Database
    Model](#product-catalog-and-database-model)
-   [WhatsApp Ordering Flow](#whatsapp-ordering-flow)
-   [Architecture](#architecture)
-   [Microservices](#microservices)
-   [Technology Stack](#technology-stack)
-   [Repository Structure](#repository-structure)
-   [Local Development](#local-development)
-   [Environment Configuration](#environment-configuration)
-   [Database and Migrations](#database-and-migrations)
-   [API Overview](#api-overview)
-   [Security](#security)
-   [Predictive Analytics](#predictive-analytics)
-   [Testing](#testing)
-   [Deployment and Operations](#deployment-and-operations)
-   [Implementation Roadmap](#implementation-roadmap)
-   [Architecture Notes](#architecture-notes)

------------------------------------------------------------------------

## Overview

The application is designed for a grocery store that needs a unified
online and messaging-based shopping experience.

Customers can:

-   Register and sign in.
-   Search products by name, category, brand, keyword, or pack size.
-   Add exact product variants to a cart and place orders.
-   Order through WhatsApp by sending a natural-language shopping list.
-   Review availability and suggested alternatives before confirming.
-   Pay through an integrated payment provider, receive an invoice PDF,
    and track delivery.

Store administrators can:

-   Create and update categories, products, brands, variants, SKUs, and
    prices.
-   Manage stock receipts, adjustments, reservations, and inventory
    history.
-   Verify and fulfill orders, manage delivery status, and handle
    exceptions.
-   Review sales analytics, demand forecasts, low-stock alerts, and
    predicted stockout risk.

The system treats the store's catalog, prices, inventory, orders, and
payment state as authoritative. ML output is decision support; it does
not directly confirm inventory or payment.

## Core Features

### Customer commerce

-   Secure customer authentication and profile management.
-   Product discovery, category navigation, and search.
-   Cart and checkout with server-side price and stock validation.
-   Order history, status tracking, and invoice access.

### Store administration

-   Product, category, brand, and variant management.
-   Stock intake, adjustment, and movement ledger.
-   Order verification, picking, packing, dispatch, and delivery
    management.
-   Role-based access for administrators, pickers, and delivery
    operators.

### WhatsApp commerce

-   WhatsApp Business Platform webhook integration.
-   Customer/account matching and conversation state.
-   Catalog-grounded item and variant resolution.
-   Availability summary and alternative suggestions.
-   Explicit customer confirmation before order creation.
-   Payment link, invoice, and order-status notifications.

### Predictive analytics

-   SKU/location demand forecast over configurable horizons.
-   Stockout-risk estimate using stock, reservations, lead time, and
    forecasted demand.
-   Reorder suggestions and low-stock alerts.
-   Model version, generation time, and data-quality/freshness
    indicators.

------------------------------------------------------------------------

## Product Catalog and Database Model

Products are modeled using a flexible hierarchy. Categories describe the
type of item, brands identify the brand, and variants represent the
exact sellable package.

### Example: search for `soap`

``` text
Search: "soap"
|
+-- Personal Care
|   +-- Bathing Soap
|       +-- Product: Bathing Bar
|           +-- Brand: Brand A
|               +-- Variant: 100 g (SKU: SOAP-A-100G)
|               +-- Variant: 125 g (SKU: SOAP-A-125G)
|
+-- Home Care
    +-- Utensil Soap
    |   +-- Product: Dishwashing Bar
    |       +-- Brand: Brand B
    |           +-- Variant: 200 g (SKU: DISH-B-200G)
    |
    +-- Cloth Soap
        +-- Product: Laundry Bar
            +-- Brand: Brand C
                +-- Variant: 250 g (SKU: LAUN-C-250G)
```

The category tree is stored using a self-referencing
`categories.parent_id` relationship. Bathing soap, utensil soap, and
cloth soap are category branches---not separate database tables.

### Core entities

  -----------------------------------------------------------------------
  Entity                              Purpose
  ----------------------------------- -----------------------------------
  `categories`                        Hierarchical product classification

  `brands`                            Brand information

  `products`                          Product-level description and
                                      category association

  `product_variants`                  Sellable SKU, pack quantity, unit,
                                      and barcode

  `prices`                            Effective-dated price records

  `stock_balances`                    Current on-hand and reserved stock
                                      by variant/location

  `stock_movements`                   Append-only inventory movement
                                      history

  `inventory_reservations`            Temporary stock holds for checkout

  `carts`, `cart_items`               Customer shopping cart

  `orders`, `order_items`             Order and immutable item snapshots

  `payments`, `refunds`               Payment provider references and
                                      payment lifecycle

  `fulfillments`, `shipments`,        Picking, delivery, and tracking
  `tracking_events`                   lifecycle

  `invoices`                          Invoice metadata and private PDF
                                      object-storage reference

  `whatsapp_conversations`,           Conversation state and webhook
  `webhook_receipts`                  deduplication

  `forecast_values`, `stockout_risks` Model output and forecast metadata

  `audit_events`                      Security-sensitive and
                                      administrative audit trail
  -----------------------------------------------------------------------

### Database design principles

-   PostgreSQL is the transactional source of truth.
-   Each service owns its data and writes only to its own
    database/schema.
-   Do not create cross-service foreign keys; use stable IDs and
    API/event contracts.
-   Use UUID identifiers consistently and `NUMERIC` for monetary values.
-   Store core quantities with explicit units of measure.
-   Snapshot product name, SKU, brand, variant, price, and tax on order
    items so catalog updates do not change past orders.
-   Keep inventory movement history; update balance projections
    transactionally.
-   Calculate available stock as `on_hand_qty - reserved_qty`.
-   Use database constraints, indexes, and versioned migrations.
-   Use JSONB for genuinely flexible metadata, not for core relational
    fields.

------------------------------------------------------------------------

## WhatsApp Ordering Flow

``` text
Customer sends shopping list
          |
          v
WhatsApp webhook receives message
          |
          v
Validate provider signature + deduplicate message
          |
          v
Match WhatsApp identity to customer account
          |
          v
Parse item names, quantities, brands, and units
          |
          v
Resolve items against active catalog
          |
          v
Check price and inventory availability
          |
          +---- Items unavailable / insufficient?
          |                |
          |                v
          |       Suggest alternate brand,
          |       pack size, or similar item
          |                |
          +----------------+
          |
          v
Send order summary and request confirmation
          |
          v
Customer confirms
          |
          v
Create idempotent order + reserve inventory
          |
          v
Payment / invoice / fulfillment
          |
          v
Send status and tracking updates
```

Important implementation rules:

1.  Use the official WhatsApp Business Platform or an approved provider.
2.  Verify webhook authenticity and deduplicate inbound message IDs.
3.  Persist conversation state; do not depend on process memory.
4.  Use catalog-grounded matching. Ask clarification when the item or
    variant is ambiguous.
5.  Display substitutions, quantity, and price changes explicitly.
6.  Create an order only after customer confirmation.
7.  Use idempotency keys so retries do not create duplicate orders.
8.  Use hosted payment pages; do not collect card details in WhatsApp
    messages.
9.  Follow WhatsApp opt-in, template, and customer-service-window rules.
10. Provide a human support handoff and a customer opt-out path.

------------------------------------------------------------------------

## Architecture

The system uses independently deployable domain services with API-based
synchronous communication and asynchronous domain events.

``` text
 Web App       Admin Console       WhatsApp
    \               |                /
             API Gateway / BFF
                    |
   +----------------+------------------+
   |        |        |        |         |
 Identity  Catalog  Cart/Order Inventory Payment
   |        |        |        |         |
   +--------+--------+--------+---------+
                    |
             Event Broker
                    |
   +---------------+------------------+
   |               |                  |
Notifications   Invoice Service   Analytics / ML
   |               |                  |
WhatsApp/Email  Private PDF store  Forecasts & risks

PostgreSQL: service-owned transactional data
Redis: optional cache / rate limiting / ephemeral state
Object storage: product images and invoice PDFs
Observability: logs, metrics, traces, alerts
```

### Communication

-   **REST/JSON:** customer and admin API requests.
-   **Domain events:** asynchronous cross-service updates.
-   **Transactional outbox:** reliable publication of events after
    database commits.
-   **Idempotent consumers:** safe handling of duplicate delivery.
-   **Saga workflow:** coordinated order, inventory, and payment
    operations with compensating actions.

A single PostgreSQL cluster can be used initially, but service ownership
must remain clear. Avoid a shared database schema where all services
write to the same tables.

## Microservices

  -----------------------------------------------------------------------
  Service                             Responsibilities
  ----------------------------------- -----------------------------------
  Identity & Access                   Authentication, users, roles,
                                      sessions, verification

  Catalog                             Categories, products, brands,
                                      variants, SKUs, search

  Pricing & Promotions                Prices, discounts, tax calculations
                                      (can initially be part of Catalog)

  Cart                                Cart and cart-item persistence

  Order                               Checkout, order state machine,
                                      order snapshots

  Inventory                           Stock balances, movement ledger,
                                      reservations, stock adjustments

  Payment                             Payment intents, verified
                                      callbacks, reconciliation, refunds

  Fulfillment & Delivery              Picking, packing, shipment
                                      assignment, delivery tracking

  WhatsApp Adapter                    Webhooks, identity mapping, message
                                      parsing, conversation state

  Notification                        WhatsApp/email messages, templates,
                                      retries

  Invoice                             Invoice numbering, PDF generation,
                                      secure storage

  Analytics & ML                      Data preparation, forecasting,
                                      stockout risk, model metadata

  Audit                               Append-only administrative and
                                      security events
  -----------------------------------------------------------------------

Services may be combined for an initial deployment if necessary, but the
ownership and API boundaries should be maintained.

## Technology Stack

The selected backend stack is Node.js, Express, and TypeScript, with
PostgreSQL. Package versions are pinned as components are implemented.
Frontend and analytics choices remain proposals.

  -----------------------------------------------------------------------
  Layer                               Proposed technology
  ----------------------------------- -----------------------------------
  Frontend                            React / Next.js with TypeScript

  Backend services                    Node.js + Express + TypeScript

  Primary database                    PostgreSQL

  Cache / rate limiting               Redis

  Messaging                           RabbitMQ for workflow/task
                                      messaging, or Kafka if event-stream
                                      scale requires it

  ML                                  Deferred; runtime and libraries
                                      selected after evaluation

  WhatsApp                            WhatsApp Business Platform Cloud
                                      API or approved BSP

  Payments                            Payment gateway with hosted
                                      checkout and signed webhooks

  Invoice and images                  Private object storage with
                                      expiring/signed access URLs

  Containers                          Docker

  CI/CD                               GitHub Actions or equivalent

  Observability                       OpenTelemetry-compatible tracing,
                                      metrics, and centralized structured
                                      logs
  -----------------------------------------------------------------------

> Avoid adding Kubernetes, a dedicated search cluster, or multiple
> databases before the workload and operational requirements justify
> them.

## Repository Structure

One possible repository layout is:

``` text
grocery-platform/
├── apps/
│   ├── customer-web/
│   └── admin-web/
├── services/
│   ├── identity-service/
│   ├── catalog-service/
│   ├── cart-service/
│   ├── order-service/
│   ├── inventory-service/
│   ├── payment-service/
│   ├── fulfillment-service/
│   ├── whatsapp-service/
│   ├── notification-service/
│   ├── invoice-service/
│   └── analytics-service/
├── shared/
│   ├── contracts/
│   ├── observability/
│   └── testing/
├── ml/
│   ├── data-pipelines/
│   ├── training/
│   ├── evaluation/
│   └── artifacts/
├── infrastructure/
│   ├── docker/
│   ├── deployment/
│   └── monitoring/
├── docs/
│   ├── architecture/
│   ├── api/
│   └── decisions/
├── scripts/
├── .env.example
├── docker-compose.yml
└── README.md
```

This is a proposed structure, not a statement that these directories or
services have already been implemented.

------------------------------------------------------------------------

## Local Development

### Prerequisites

Install the tools required by the selected implementation:

-   Git
-   Docker and Docker Compose
-   Node.js 24.12+ and npm (TypeScript backend and manual database commands)
-   PostgreSQL client tools (optional if PostgreSQL runs in Docker)

### Setup

The exact commands depend on the frameworks and service implementations.
A typical workflow is:

``` bash
# 1. Clone the repository
git clone <repository-url>
cd grocery-platform

# 2. Create local environment configuration
cp .env.example .env

# 3. Start infrastructure dependencies
docker compose up -d postgres redis rabbitmq

# 4. Apply database migrations for each service
# Run the migration command documented by that service.

# 5. Start backend services and frontend apps
# Use each service's documented development command.
```

Do not commit `.env` or real provider credentials. Keep `.env.example`
limited to variable names and safe placeholder values.

## Environment Configuration

Create a local `.env` file from `.env.example`. The following are
representative configuration names; the exact variables depend on
selected frameworks and providers.

``` dotenv
# Runtime
APP_ENV=local
LOG_LEVEL=INFO

# PostgreSQL
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_DB=grocery
POSTGRES_USER=grocery_app
POSTGRES_PASSWORD=change_me

# Redis
REDIS_URL=redis://localhost:6379/0

# Message broker
RABBITMQ_URL=amqp://guest:guest@localhost:5672/

# Identity / token settings
JWT_ISSUER=grocery-platform
JWT_AUDIENCE=grocery-api
JWT_SECRET=replace_with_a_secure_local_secret

# WhatsApp provider
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_VERIFY_TOKEN=
WHATSAPP_APP_SECRET=

# Payment provider
PAYMENT_PROVIDER=
PAYMENT_API_KEY=
PAYMENT_WEBHOOK_SECRET=

# Object storage / invoice PDF
OBJECT_STORAGE_ENDPOINT=
OBJECT_STORAGE_BUCKET=
OBJECT_STORAGE_ACCESS_KEY=
OBJECT_STORAGE_SECRET_KEY=
```

Production secrets should be injected through a secret manager or
deployment platform---not stored in source control or container images.

## Database and Migrations

Use version-controlled migrations for every schema change.

Recommended practices:

-   Keep migrations owned by the relevant service.
-   Review migrations before applying them to production.
-   Use constraints for uniqueness, valid quantities, and state
    integrity.
-   Create indexes based on actual query patterns.
-   Seed development data separately from production data.
-   Back up PostgreSQL and test point-in-time recovery.
-   Never use production customer data in development without approved
    anonymization.

The core product relationship is:

``` text
categories 1 ─── N products
brands     1 ─── N products
products   1 ─── N product_variants
variants   1 ─── N stock_balances (by location)
variants   1 ─── N stock_movements
orders     1 ─── N order_items
```

Inventory reservations and order items should reference stable variant
IDs. Order item descriptions and prices should be snapshots.

## API Overview

Representative API routes (actual routes and schemas should be
documented in OpenAPI per service):

  --------------------------------------------------------------------------
  Area                                Example routes
  ----------------------------------- --------------------------------------
  Authentication                      `POST /auth/register`,
                                      `POST /auth/login`,
                                      `POST /auth/refresh`,
                                      `POST /auth/logout`

  Catalog                             `GET /catalog/search?q=soap`,
                                      `GET /categories`,
                                      `GET /products/{id}`

  Cart                                `GET /cart`, `POST /cart/items`,
                                      `PATCH /cart/items/{id}`

  Orders                              `POST /orders`, `GET /orders/{id}`,
                                      `GET /customers/me/orders`

  Inventory                           `GET /inventory/availability`,
                                      `POST /inventory/reservations`,
                                      `POST /inventory/adjustments`

  Payment                             `POST /payments/intents`,
                                      `GET /payments/{id}`,
                                      `POST /webhooks/payment-provider`

  Fulfillment                         `POST /fulfillments/{id}/pick`,
                                      `POST /fulfillments/{id}/pack`,
                                      `GET /orders/{id}/tracking`

  WhatsApp                            `POST /webhooks/whatsapp`

  Analytics                           `GET /analytics/forecast`,
                                      `GET /analytics/stockout-risk`,
                                      `GET /analytics/reorder-suggestions`
  --------------------------------------------------------------------------

API requirements:

-   Version contracts where breaking changes are introduced.
-   Validate inputs and enforce authorization at the service boundary.
-   Use pagination for collection endpoints.
-   Include correlation IDs in logs and responses where appropriate.
-   Use idempotency keys for order creation and other retryable
    mutations.
-   Never trust frontend-supplied price, payment state, or stock
    availability.

## Security

Security controls should be implemented as part of the system, not
deferred until the end.

-   Secure password hashing using a modern password hashing algorithm.
-   MFA for privileged administrative accounts.
-   Role-based access control and object-level authorization.
-   Short-lived access tokens and secure session/refresh-token handling.
-   TLS for all external and internal traffic where applicable.
-   Webhook signature verification and replay/deduplication protection.
-   Rate limits for authentication, search, checkout, and webhook
    endpoints.
-   Parameterized database queries and input validation.
-   CSRF protection when cookie-based authentication is used.
-   Secure CORS policy and output encoding.
-   Secret management and credential rotation.
-   Encryption for backups, databases, and private object storage.
-   Audit logging for product/price changes, stock adjustments, refunds,
    role changes, and exports.
-   Dependency, container, SAST, and secret scanning in CI/CD.
-   Avoid logging passwords, OTPs, tokens, payment secrets, or
    unnecessary personal data.
-   Use hosted payment checkout; do not store raw card data.
-   Test authorization against cross-customer order, address, invoice,
    and tracking access.

## Predictive Analytics

### Demand forecasting

Forecast demand for each product variant and store location over
selected horizons.

Potential input features:

-   Historical units sold.
-   Calendar and day-of-week patterns.
-   Price and promotion history.
-   Returns and inventory movements.
-   Stock availability and stockout intervals.
-   Supplier lead time and incoming replenishment.
-   Seasonal or local event features where data is available.

### Stockout risk

A practical first implementation can compare forecasted cumulative
demand during replenishment lead time against available stock and
scheduled receipts.

``` text
Projected stock at time t
    = current available stock
    + confirmed incoming stock
    - forecast cumulative demand
```

Alert when projected stock crosses zero or the configured safety-stock
threshold.

### ML workflow

1.  Validate and aggregate order and inventory history.
2.  Build a time-series dataset by SKU/location/time interval.
3.  Handle missing dates, promotions, returns, and stockout-censored
    demand.
4.  Establish a baseline model before evaluating more complex models.
5.  Split data chronologically to prevent future-data leakage.
6.  Evaluate by product group and forecast horizon using suitable
    metrics (for example, MAE or WAPE).
7.  Version the model, feature definitions, training window, and
    evaluation metrics.
8.  Persist forecast output with model version and generation time.
9.  Monitor drift, stale data, and forecast error.
10. Provide a fallback for products with insufficient history.

The platform should not claim forecast accuracy until it has been
evaluated against historical holdout data.

## Testing

Recommended test layers:

-   **Unit tests:** domain logic, pricing, product resolution, state
    transitions, and forecasting features.
-   **Integration tests:** PostgreSQL constraints/migrations, broker,
    payment adapter, and WhatsApp adapter.
-   **Contract tests:** REST schemas and event payload compatibility.
-   **End-to-end tests:** customer purchase, WhatsApp order
    confirmation, invoice delivery, and order tracking.
-   **Security tests:** authorization, injection, CSRF, webhook
    validation, rate limiting, and secret leakage.
-   **Concurrency tests:** inventory reservation and checkout race
    conditions.
-   **Resilience tests:** provider outage, duplicate messages, delayed
    callbacks, queue retries, and dead-letter handling.
-   **ML evaluation:** chronological backtesting, baseline comparison,
    data leakage checks, and performance by SKU/category.

Critical scenarios include:

-   Two customers attempt to reserve the final unit; no overselling
    occurs.
-   Repeated WhatsApp webhook deliveries do not create duplicate orders.
-   A forged payment callback cannot mark an order paid.
-   A customer cannot access another customer's order or invoice.
-   An unavailable product leads to transparent alternatives and
    explicit customer confirmation.

## Deployment and Operations

-   Containerize services and use repeatable builds.
-   Separate local, test, staging, and production environments.
-   Use CI/CD with tests, security scanning, and migration checks.
-   Keep services on private networks; expose only the gateway and
    approved webhook endpoints.
-   Use structured logs, metrics, distributed traces, and alerting.
-   Monitor API latency/errors, database capacity, queue depth, webhook
    processing delay, payment failures, and stale forecasts.
-   Use timeouts, bounded retries with backoff/jitter, circuit breakers,
    and dead-letter queues.
-   Back up PostgreSQL and test restore procedures regularly.
-   Define Recovery Point Objective (RPO) and Recovery Time Objective
    (RTO) with the business.
-   Document runbooks for payment-provider outages, WhatsApp outages,
    stock reconciliation, queue replay, and database recovery.

## Implementation Roadmap

The sequence below describes the broader platform dependencies. The active
delivery sequence is WhatsApp first, supported by the minimum catalog,
inventory, order, and staff functionality it needs; follow the
[WhatsApp automation plan](docs/whatsapp-automation-plan.md) for that sequence.

1.  **Architecture and foundation:** agree on service boundaries,
    contracts, repo setup, migrations, CI/CD, and observability.
2.  **Identity and catalog:** customer/admin auth, roles, category tree,
    product/brand/variant management, and search.
3.  **Inventory:** stock ledger, balance projection, adjustments,
    reservations, and low-stock alerts.
4.  **Cart and orders:** checkout, immutable order snapshots, order
    state machine, and idempotency.
5.  **Payment and invoice:** provider integration, callback
    verification, reconciliation, PDF generation, and secure storage.
6.  **Fulfillment and delivery:** picking, packing, dispatch, tracking,
    and role-specific operations.
7.  **WhatsApp:** webhook processing, account linking, product
    resolution, alternatives, confirmation, and notifications.
8.  **Analytics and ML:** reliable data pipeline, baseline forecast,
    risk estimates, evaluation, and dashboard.
9.  **Production hardening:** security review, load testing, restore
    exercise, alerting, and operational runbooks.

## Architecture Notes

-   Microservices create operational and distributed-systems complexity.
    Keep the initial service count manageable.
-   PostgreSQL is the source of truth; Redis and search indexes are
    derived/auxiliary systems.
-   Inventory reservations must be concurrency-safe and expire or be
    released on failed/abandoned checkout.
-   Payment state and order state are separate state machines.
-   Use a saga for cross-service order workflows; avoid distributed
    database transactions.
-   Use the transactional outbox pattern for reliable event publication.
-   Analytics and forecasts are eventually consistent; show when they
    were generated.
-   The system must use customer confirmation for substitutions and
    WhatsApp orders.
-   The final technology versions, provider configurations, deployment
    commands, and service URLs should be updated to match the
    implemented repository.

------------------------------------------------------------------------

## License

Add the project license here before public distribution.
