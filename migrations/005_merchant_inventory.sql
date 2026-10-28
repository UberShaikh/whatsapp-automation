CREATE TABLE grocery_dev.merchant_access (
  user_id uuid NOT NULL,
  location_code text NOT NULL CHECK (location_code='DEMO-STORE'),
  is_active boolean NOT NULL DEFAULT true,
  granted_by text NOT NULL DEFAULT current_user,
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,location_code)
);
CREATE TABLE grocery_dev.merchant_stock_adjustments (
  request_id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  location_code text NOT NULL,
  movement_id uuid NOT NULL UNIQUE REFERENCES grocery_dev.stock_movements(id),
  action text NOT NULL CHECK (action IN ('receive','remove','recount')),
  quantity integer NOT NULL CHECK (quantity BETWEEN 0 AND 1000000),
  reason text NOT NULL CHECK (length(reason) BETWEEN 3 AND 200),
  before_qty integer NOT NULL CHECK (before_qty>=0),
  after_qty integer NOT NULL CHECK (after_qty>=0),
  reserved_qty integer NOT NULL CHECK (reserved_qty BETWEEN 0 AND after_qty),
  request_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(user_id,location_code) REFERENCES grocery_dev.merchant_access(user_id,location_code),
  FOREIGN KEY(variant_id,location_code) REFERENCES grocery_dev.stock_balances(variant_id,location_code)
);
CREATE INDEX merchant_adjustments_location_time ON grocery_dev.merchant_stock_adjustments(location_code,created_at DESC);
REVOKE ALL ON grocery_dev.merchant_access,grocery_dev.merchant_stock_adjustments FROM PUBLIC;
