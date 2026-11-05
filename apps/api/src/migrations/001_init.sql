CREATE TABLE merchants (
  id text PRIMARY KEY,
  name text NOT NULL,
  logo text,
  brand_color text,
  merchant_address text NOT NULL UNIQUE,
  payout_wallet text NOT NULL,
  refund_wallet text NOT NULL,
  timezone text NOT NULL DEFAULT 'UTC',
  confirmations integer NOT NULL DEFAULT 2 CHECK (confirmations BETWEEN 1 AND 20),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_keys (
  id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES merchants(id),
  type text NOT NULL CHECK (type IN ('publishable', 'secret')),
  hash text NOT NULL UNIQUE,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE customers (
  id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES merchants(id),
  name text,
  email text,
  wallets jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE products (
  id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES merchants(id),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE prices (
  id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES merchants(id),
  product_id text NOT NULL REFERENCES products(id),
  unit_amount bigint NOT NULL,
  interval text CHECK (interval IN ('week', 'month')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payment_intents (
  id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES merchants(id),
  onchain_id text NOT NULL UNIQUE,
  client_secret text NOT NULL UNIQUE,
  amount bigint NOT NULL CHECK (amount > 0),
  currency text NOT NULL,
  status text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  description text,
  source text NOT NULL DEFAULT 'api',
  customer_id text REFERENCES customers(id),
  expires_at timestamptz NOT NULL,
  deadline bigint NOT NULL,
  signature text NOT NULL,
  late_settlement boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payment_intents_merchant ON payment_intents (merchant_id, created_at DESC);

CREATE TABLE checkout_sessions (
  id text PRIMARY KEY,
  intent_id text NOT NULL REFERENCES payment_intents(id),
  line_items jsonb NOT NULL DEFAULT '[]',
  success_url text,
  cancel_url text,
  mode text NOT NULL DEFAULT 'payment',
  status text NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payment_links (
  id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES merchants(id),
  code text NOT NULL UNIQUE,
  price_id text NOT NULL REFERENCES prices(id),
  active boolean NOT NULL DEFAULT true,
  times_paid integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE invoices (
  id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES merchants(id),
  number text NOT NULL,
  customer_id text REFERENCES customers(id),
  line_items jsonb NOT NULL DEFAULT '[]',
  due_date timestamptz,
  late_fee jsonb,
  allow_partial boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'draft',
  amount_paid bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, number)
);

-- One row per onchain Paid log. The unique pair is what stops a rescan from recording a payment twice.
CREATE TABLE payments (
  id text PRIMARY KEY,
  intent_id text NOT NULL REFERENCES payment_intents(id),
  invoice_id text REFERENCES invoices(id),
  tx_hash text NOT NULL,
  log_index integer NOT NULL,
  block_number bigint NOT NULL,
  payer text NOT NULL,
  amount bigint NOT NULL,
  confirmed_at timestamptz NOT NULL,
  UNIQUE (tx_hash, log_index)
);

CREATE TABLE refunds (
  id text PRIMARY KEY,
  payment_id text NOT NULL REFERENCES payments(id),
  amount bigint NOT NULL,
  reason text,
  status text NOT NULL,
  tx_hash text,
  log_index integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tx_hash, log_index)
);

CREATE TABLE subscriptions (
  id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES merchants(id),
  onchain_sub_id bigint UNIQUE,
  customer_id text REFERENCES customers(id),
  price_id text REFERENCES prices(id),
  status text NOT NULL,
  next_charge_at timestamptz,
  periods_charged integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The primary key is derived from the source log, so one log can never produce two events of a type.
CREATE TABLE events (
  id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES merchants(id),
  type text NOT NULL,
  payload jsonb NOT NULL,
  source_tx text,
  source_log_index integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_merchant ON events (merchant_id, created_at DESC);

CREATE TABLE webhook_endpoints (
  id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES merchants(id),
  url text NOT NULL,
  secret text NOT NULL,
  events jsonb NOT NULL DEFAULT '["*"]',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_deliveries (
  id text PRIMARY KEY,
  event_id text NOT NULL REFERENCES events(id),
  endpoint_id text NOT NULL REFERENCES webhook_endpoints(id),
  attempt integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed')),
  status_code integer,
  next_retry_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  UNIQUE (event_id, endpoint_id)
);
CREATE INDEX webhook_deliveries_due ON webhook_deliveries (next_retry_at) WHERE status = 'pending';

CREATE TABLE idempotency_keys (
  key text NOT NULL,
  merchant_id text NOT NULL REFERENCES merchants(id),
  request_hash text NOT NULL,
  response jsonb,
  status_code integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id, key)
);

CREATE TABLE reminders (
  id text PRIMARY KEY,
  invoice_id text NOT NULL REFERENCES invoices(id),
  kind text NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE indexer_state (
  name text PRIMARY KEY,
  next_block bigint NOT NULL
);
