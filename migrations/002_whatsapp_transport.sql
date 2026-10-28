CREATE TABLE grocery_dev.wa_identities (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_account_id text NOT NULL,
    phone_number_id text NOT NULL,
    transport_mode text NOT NULL CHECK (transport_mode IN ('fake','meta')),
    sender_key text NOT NULL,
    address_type text NOT NULL CHECK (address_type IN ('phone','bsuid')),
    address_value text NOT NULL,
    phone_number text,
    last_customer_message_at timestamptz NOT NULL,
    revision bigint NOT NULL DEFAULT 0,
    opted_out boolean NOT NULL DEFAULT false,
    mode text NOT NULL DEFAULT 'IDLE' CHECK (mode IN ('IDLE','HUMAN_HANDOFF')),
    UNIQUE (business_account_id,phone_number_id,transport_mode,sender_key)
);

CREATE TABLE grocery_dev.wa_inbox (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    identity_id uuid NOT NULL REFERENCES grocery_dev.wa_identities(id) ON DELETE CASCADE,
    business_account_id text NOT NULL,
    phone_number_id text NOT NULL,
    transport_mode text NOT NULL CHECK (transport_mode IN ('fake','meta')),
    provider_message_id text NOT NULL,
    message_type text NOT NULL,
    body text NOT NULL,
    occurred_at timestamptz NOT NULL,
    received_at timestamptz NOT NULL DEFAULT now(),
    processed_at timestamptz,
    UNIQUE (business_account_id,phone_number_id,transport_mode,provider_message_id)
);
CREATE INDEX wa_inbox_pending_idx ON grocery_dev.wa_inbox(id) WHERE processed_at IS NULL;
CREATE INDEX wa_inbox_identity_idx ON grocery_dev.wa_inbox(identity_id,id);

CREATE TABLE grocery_dev.wa_outbox (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
    identity_id uuid NOT NULL REFERENCES grocery_dev.wa_identities(id) ON DELETE CASCADE,
    inbox_id bigint NOT NULL UNIQUE REFERENCES grocery_dev.wa_inbox(id) ON DELETE CASCADE,
    revision bigint NOT NULL,
    body text NOT NULL,
    state text NOT NULL DEFAULT 'pending' CHECK (state IN
        ('pending','sending','accepted','sent','delivered','read','failed','uncertain','suppressed')),
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    available_at timestamptz NOT NULL DEFAULT now(),
    lease_token uuid,
    callback_key uuid UNIQUE,
    lease_until timestamptz,
    provider_message_id text,
    last_error_code text,
    manual_retries integer NOT NULL DEFAULT 0,
    last_retried_by text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((state = 'sending') = (lease_token IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX wa_outbox_pending_idx ON grocery_dev.wa_outbox(available_at,sequence) WHERE state='pending';
CREATE INDEX wa_outbox_identity_idx ON grocery_dev.wa_outbox(identity_id,sequence);
CREATE UNIQUE INDEX wa_outbox_provider_idx ON grocery_dev.wa_outbox(identity_id,provider_message_id) WHERE provider_message_id IS NOT NULL;

CREATE TABLE grocery_dev.wa_status_events (
    event_key text PRIMARY KEY,
    business_account_id text NOT NULL,
    phone_number_id text NOT NULL,
    transport_mode text NOT NULL CHECK (transport_mode IN ('fake','meta')),
    provider_message_id text NOT NULL,
    status text NOT NULL CHECK (status IN ('sent','delivered','read','failed')),
    occurred_at timestamptz NOT NULL,
    callback_key uuid,
    error_code text,
    received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wa_status_provider_idx ON grocery_dev.wa_status_events(business_account_id,phone_number_id,provider_message_id);

REVOKE ALL ON grocery_dev.wa_identities,grocery_dev.wa_inbox,grocery_dev.wa_outbox,grocery_dev.wa_status_events FROM PUBLIC;
