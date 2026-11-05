ALTER TABLE merchants ADD COLUMN invoice_prefix text NOT NULL DEFAULT 'INV';
ALTER TABLE merchants ADD COLUMN invoice_seq integer NOT NULL DEFAULT 0;

ALTER TABLE checkout_sessions ADD COLUMN merchant_id text REFERENCES merchants(id);
ALTER TABLE checkout_sessions ADD COLUMN payment_link_id text REFERENCES payment_links(id);
ALTER TABLE checkout_sessions ADD COLUMN client_reference_id text;
CREATE INDEX checkout_sessions_intent ON checkout_sessions (intent_id);

ALTER TABLE payment_links ADD COLUMN description text;
ALTER TABLE payment_links ADD COLUMN image text;
ALTER TABLE payment_links ADD COLUMN adjustable_quantity boolean NOT NULL DEFAULT false;
ALTER TABLE payment_links ADD COLUMN expires_at timestamptz;
ALTER TABLE payment_links ADD COLUMN success_url text;

ALTER TABLE invoices ADD COLUMN total bigint NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN currency text NOT NULL DEFAULT 'usd';
ALTER TABLE invoices ADD COLUMN notes text;
ALTER TABLE invoices ADD COLUMN issued_at timestamptz;

ALTER TABLE payment_intents ADD COLUMN invoice_id text REFERENCES invoices(id);
