CREATE TABLE grocery_dev.wa_carts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    identity_id uuid NOT NULL UNIQUE REFERENCES grocery_dev.wa_identities(id) ON DELETE CASCADE,
    revision bigint NOT NULL DEFAULT 0,
    next_line_no integer NOT NULL DEFAULT 1 CHECK (next_line_no > 0),
    last_action_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE grocery_dev.wa_cart_items (
    cart_id uuid NOT NULL REFERENCES grocery_dev.wa_carts(id) ON DELETE CASCADE,
    variant_id uuid NOT NULL REFERENCES grocery_dev.product_variants(id),
    line_no integer NOT NULL CHECK (line_no > 0),
    packs integer NOT NULL CHECK (packs BETWEEN 1 AND 99),
    PRIMARY KEY (cart_id,variant_id),
    UNIQUE (cart_id,line_no)
);
CREATE INDEX wa_cart_items_variant_idx ON grocery_dev.wa_cart_items(variant_id);

CREATE TABLE grocery_dev.wa_shopping_prompts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    cart_id uuid NOT NULL UNIQUE REFERENCES grocery_dev.wa_carts(id) ON DELETE CASCADE,
    token text NOT NULL UNIQUE CHECK (token ~ '^[a-f0-9]{16}$'),
    cart_revision bigint NOT NULL,
    request_text text NOT NULL CHECK (length(request_text) BETWEEN 1 AND 200),
    remaining_requests text[] NOT NULL DEFAULT '{}' CHECK (cardinality(remaining_requests) <= 10),
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL DEFAULT (now()+interval '10 minutes')
);

CREATE TABLE grocery_dev.wa_shopping_choices (
    prompt_id uuid NOT NULL REFERENCES grocery_dev.wa_shopping_prompts(id) ON DELETE CASCADE,
    position integer NOT NULL CHECK (position BETWEEN 1 AND 3),
    variant_id uuid NOT NULL REFERENCES grocery_dev.product_variants(id),
    packs integer NOT NULL CHECK (packs BETWEEN 1 AND 99),
    unit_price numeric(12,2) NOT NULL CHECK (unit_price > 0),
    pack_quantity numeric(12,3) NOT NULL,
    pack_unit text NOT NULL,
    pack_count integer NOT NULL,
    display_name text NOT NULL,
    reason text NOT NULL,
    PRIMARY KEY (prompt_id,position)
);
CREATE INDEX wa_choices_variant_idx ON grocery_dev.wa_shopping_choices(variant_id);

REVOKE ALL ON grocery_dev.wa_carts,grocery_dev.wa_cart_items,grocery_dev.wa_shopping_prompts,grocery_dev.wa_shopping_choices FROM PUBLIC;
