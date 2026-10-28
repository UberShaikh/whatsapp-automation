CREATE TABLE grocery_dev.wa_checkout_quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cart_id uuid NOT NULL REFERENCES grocery_dev.wa_carts(id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE CHECK (token ~ '^[a-f0-9]{16}$'),
  cart_revision bigint NOT NULL,
  store_name text NOT NULL,
  items jsonb NOT NULL CHECK (jsonb_typeof(items)='array' AND jsonb_array_length(items) BETWEEN 1 AND 20),
  total numeric(16,2) NOT NULL CHECK (total>0 AND total<>'NaN'::numeric),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','confirmed','invalidated')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '10 minutes'
);
CREATE UNIQUE INDEX wa_checkout_one_pending ON grocery_dev.wa_checkout_quotes(cart_id) WHERE state='pending';

CREATE TABLE grocery_dev.wa_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference text NOT NULL UNIQUE CHECK (reference ~ '^D-[A-F0-9]{12}$'),
  quote_id uuid NOT NULL UNIQUE REFERENCES grocery_dev.wa_checkout_quotes(id),
  identity_id uuid NOT NULL REFERENCES grocery_dev.wa_identities(id),
  items jsonb NOT NULL CHECK (jsonb_typeof(items)='array' AND jsonb_array_length(items) BETWEEN 1 AND 20),
  store_name text NOT NULL,
  total numeric(16,2) NOT NULL CHECK (total>0 AND total<>'NaN'::numeric),
  state text NOT NULL DEFAULT 'PLACED' CHECK (state IN ('PLACED','ACCEPTED','PICKING','READY','COLLECTED','CANCELLED','REJECTED')),
  payment_status text NOT NULL DEFAULT 'UNPAID' CHECK (payment_status IN ('UNPAID','DEMO_CASH_RECORDED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((state='COLLECTED')=(payment_status='DEMO_CASH_RECORDED'))
);
CREATE INDEX wa_orders_customer ON grocery_dev.wa_orders(identity_id,created_at DESC);
CREATE TABLE grocery_dev.wa_inventory_reservations (
  order_id uuid NOT NULL REFERENCES grocery_dev.wa_orders(id),
  variant_id uuid NOT NULL,
  location_code text NOT NULL DEFAULT 'DEMO-STORE' CHECK (location_code='DEMO-STORE'),
  packs integer NOT NULL CHECK (packs BETWEEN 1 AND 99),
  state text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE','RELEASED','CONSUMED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  PRIMARY KEY(order_id,variant_id,location_code),
  FOREIGN KEY(variant_id,location_code) REFERENCES grocery_dev.stock_balances(variant_id,location_code),
  CHECK ((state='ACTIVE')=(resolved_at IS NULL))
);
CREATE TABLE grocery_dev.wa_order_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES grocery_dev.wa_orders(id),
  from_state text,
  to_state text NOT NULL,
  actor text NOT NULL CHECK (actor IN ('customer','operator')),
  database_role text NOT NULL DEFAULT current_user,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE grocery_dev.stock_movements ADD COLUMN order_id uuid REFERENCES grocery_dev.wa_orders(id);
CREATE UNIQUE INDEX stock_sale_once_per_order ON grocery_dev.stock_movements(order_id,variant_id,location_code)
  WHERE kind='sale' AND order_id IS NOT NULL;
REVOKE ALL ON grocery_dev.wa_checkout_quotes,grocery_dev.wa_orders,grocery_dev.wa_inventory_reservations,grocery_dev.wa_order_events FROM PUBLIC;
