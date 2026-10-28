CREATE SCHEMA grocery_dev;
REVOKE ALL ON SCHEMA grocery_dev FROM PUBLIC;

CREATE TABLE grocery_dev.schema_migrations (
    version text PRIMARY KEY,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE grocery_dev.seed_imports (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    file_sha256 text NOT NULL UNIQUE,
    dataset_id text NOT NULL,
    imported_by text NOT NULL DEFAULT current_user,
    imported_at timestamptz NOT NULL DEFAULT now(),
    product_count integer NOT NULL CHECK (product_count > 0)
);

CREATE TABLE grocery_dev.categories (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    path text[] NOT NULL UNIQUE,
    parent_id uuid REFERENCES grocery_dev.categories(id)
);
CREATE INDEX categories_parent_idx ON grocery_dev.categories(parent_id);

CREATE TABLE grocery_dev.brands (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL UNIQUE
);

CREATE TABLE grocery_dev.products (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    brand_id uuid NOT NULL REFERENCES grocery_dev.brands(id),
    category_id uuid NOT NULL REFERENCES grocery_dev.categories(id),
    UNIQUE (name, brand_id, category_id)
);
CREATE INDEX products_brand_idx ON grocery_dev.products(brand_id);
CREATE INDEX products_category_idx ON grocery_dev.products(category_id);

CREATE TABLE grocery_dev.product_variants (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id uuid NOT NULL REFERENCES grocery_dev.products(id),
    sku text NOT NULL UNIQUE,
    pack_quantity numeric(12,3) NOT NULL CHECK (pack_quantity > 0),
    pack_unit text NOT NULL CHECK (pack_unit IN ('g','kg','ml','l')),
    pack_count integer NOT NULL CHECK (pack_count > 0),
    sell_unit text NOT NULL CHECK (sell_unit = 'pack'),
    aliases text[] NOT NULL,
    image_url text NOT NULL CHECK (image_url LIKE 'https://%'),
    source_metadata jsonb NOT NULL,
    is_active boolean NOT NULL DEFAULT true,
    last_import_id uuid NOT NULL REFERENCES grocery_dev.seed_imports(id),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX variants_product_idx ON grocery_dev.product_variants(product_id);
CREATE INDEX variants_import_idx ON grocery_dev.product_variants(last_import_id);

CREATE TABLE grocery_dev.prices (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    variant_id uuid NOT NULL REFERENCES grocery_dev.product_variants(id),
    amount numeric(12,2) NOT NULL CHECK (amount > 0),
    currency text NOT NULL CHECK (currency = 'INR'),
    valid_from timestamptz NOT NULL DEFAULT now(),
    valid_to timestamptz,
    import_id uuid NOT NULL REFERENCES grocery_dev.seed_imports(id),
    CHECK (valid_to IS NULL OR valid_to >= valid_from)
);
CREATE UNIQUE INDEX prices_current_idx ON grocery_dev.prices(variant_id) WHERE valid_to IS NULL;
CREATE INDEX prices_import_idx ON grocery_dev.prices(import_id);

CREATE TABLE grocery_dev.stock_balances (
    variant_id uuid NOT NULL REFERENCES grocery_dev.product_variants(id),
    location_code text NOT NULL,
    on_hand_qty integer NOT NULL CHECK (on_hand_qty >= 0),
    reserved_qty integer NOT NULL DEFAULT 0 CHECK (reserved_qty >= 0),
    PRIMARY KEY (variant_id, location_code),
    CHECK (reserved_qty <= on_hand_qty)
);

CREATE TABLE grocery_dev.stock_movements (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    variant_id uuid NOT NULL,
    location_code text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('opening_stock','adjustment','sale','return')),
    quantity integer NOT NULL,
    import_id uuid REFERENCES grocery_dev.seed_imports(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (variant_id, location_code)
        REFERENCES grocery_dev.stock_balances(variant_id, location_code),
    CHECK (kind <> 'opening_stock' OR (quantity >= 0 AND import_id IS NOT NULL))
);
CREATE UNIQUE INDEX stock_opening_once_idx
    ON grocery_dev.stock_movements(variant_id, location_code) WHERE kind = 'opening_stock';
CREATE INDEX movements_balance_idx ON grocery_dev.stock_movements(variant_id, location_code);
CREATE INDEX movements_import_idx ON grocery_dev.stock_movements(import_id);

REVOKE ALL ON ALL TABLES IN SCHEMA grocery_dev FROM PUBLIC;
