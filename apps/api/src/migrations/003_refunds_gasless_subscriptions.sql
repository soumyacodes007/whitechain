ALTER TABLE merchants ADD COLUMN gasless boolean NOT NULL DEFAULT true;
ALTER TABLE merchants ADD COLUMN relay_daily_limit integer NOT NULL DEFAULT 200;
ALTER TABLE merchants ADD COLUMN support_email text;

ALTER TABLE customers ADD COLUMN notes text;

ALTER TABLE refunds ADD COLUMN note text;
ALTER TABLE refunds ADD COLUMN issued_by text;
ALTER TABLE refunds ADD COLUMN merchant_id text REFERENCES merchants(id);

ALTER TABLE payments ADD COLUMN gas_paid_by text NOT NULL DEFAULT 'customer';

-- One relay per intent, which also lets the relayer count usage per merchant per day.
CREATE TABLE relayed_txs (
  intent_id text PRIMARY KEY REFERENCES payment_intents(id),
  merchant_id text NOT NULL REFERENCES merchants(id),
  tx_hash text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX relayed_txs_merchant ON relayed_txs (merchant_id, created_at);

ALTER TABLE checkout_sessions ALTER COLUMN intent_id DROP NOT NULL;
ALTER TABLE checkout_sessions ADD COLUMN amount bigint;
ALTER TABLE checkout_sessions ADD COLUMN currency text;
ALTER TABLE checkout_sessions ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}';
ALTER TABLE checkout_sessions ADD COLUMN interval_seconds integer;
ALTER TABLE checkout_sessions ADD COLUMN max_periods integer NOT NULL DEFAULT 0;
ALTER TABLE checkout_sessions ADD COLUMN subscribe_tx text;
ALTER TABLE checkout_sessions ADD COLUMN expires_at timestamptz;

ALTER TABLE subscriptions ADD COLUMN session_id text REFERENCES checkout_sessions(id);
ALTER TABLE subscriptions ADD COLUMN plan_name text;
ALTER TABLE subscriptions ADD COLUMN amount bigint NOT NULL DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN currency text NOT NULL DEFAULT 'usd';
ALTER TABLE subscriptions ADD COLUMN interval_seconds integer NOT NULL DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN max_periods integer NOT NULL DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN wallet text;
ALTER TABLE subscriptions ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}';
ALTER TABLE subscriptions ADD COLUMN failed_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN canceled_at timestamptz;
CREATE INDEX subscriptions_due ON subscriptions (next_charge_at) WHERE status IN ('active', 'past_due');

CREATE TABLE subscription_charges (
  id text PRIMARY KEY,
  subscription_id text NOT NULL REFERENCES subscriptions(id),
  period integer NOT NULL,
  amount bigint NOT NULL,
  status text NOT NULL CHECK (status IN ('succeeded', 'failed')),
  tx_hash text NOT NULL,
  log_index integer NOT NULL,
  block_number bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tx_hash, log_index)
);

-- Every USDT transfer into a merchant's payout wallet. Matching happens at report time, so a transfer
-- seen before its payment row exists still reconciles.
CREATE TABLE incoming_transfers (
  id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES merchants(id),
  tx_hash text NOT NULL,
  log_index integer NOT NULL,
  block_number bigint NOT NULL,
  from_address text NOT NULL,
  amount bigint NOT NULL,
  manual_reference text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tx_hash, log_index)
);
CREATE INDEX incoming_transfers_merchant ON incoming_transfers (merchant_id, created_at DESC);

ALTER TABLE webhook_endpoints ADD COLUMN description text;

CREATE TABLE webhook_attempts (
  id text PRIMARY KEY,
  delivery_id text NOT NULL REFERENCES webhook_deliveries(id),
  attempt integer NOT NULL,
  status_code integer,
  duration_ms integer NOT NULL,
  response_body text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_attempts_delivery ON webhook_attempts (delivery_id, attempt);
