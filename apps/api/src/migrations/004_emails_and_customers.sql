ALTER TABLE merchants ADD COLUMN reminders_enabled boolean NOT NULL DEFAULT true;

ALTER TABLE invoices ADD COLUMN reminders boolean NOT NULL DEFAULT true;

ALTER TABLE payment_intents ADD COLUMN customer_email text;
ALTER TABLE payment_intents ADD COLUMN processing_at timestamptz;

ALTER TABLE checkout_sessions ADD COLUMN customer_email text;

-- Written in the same transaction as the change it reports, so a crash can't lose an email.
CREATE TABLE emails (
  id text PRIMARY KEY,
  merchant_id text REFERENCES merchants(id),
  to_address text NOT NULL,
  kind text NOT NULL,
  subject text NOT NULL,
  body text NOT NULL,
  invoice_id text REFERENCES invoices(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'logged', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX emails_due ON emails (next_attempt_at) WHERE status = 'pending';
CREATE INDEX emails_merchant ON emails (merchant_id, created_at DESC);

-- A scheduled reminder fires once. Manual reminders can repeat.
CREATE UNIQUE INDEX reminders_once ON reminders (invoice_id, kind) WHERE kind <> 'manual';
