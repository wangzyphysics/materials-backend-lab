-- Additive receipts. Both entry points use the existing Phase / condition / record tables.
-- Source keys are scoped to the authenticated owner, never supplied owner/role fields.
CREATE TABLE calypso_platform.ingestion_receipts (
 id uuid PRIMARY KEY,
 owner_id uuid NOT NULL REFERENCES calypso_platform.users(id),
 batch_id uuid NOT NULL UNIQUE REFERENCES calypso_platform.batches(id) ON DELETE CASCADE,
 source_namespace text NOT NULL CHECK(source_namespace ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$'),
 external_batch_id text NOT NULL CHECK(length(external_batch_id) BETWEEN 1 AND 200),
 package_hash text NOT NULL CHECK(package_hash ~ '^[a-f0-9]{64}$'),
 reason text NOT NULL CHECK(length(reason) BETWEEN 3 AND 2000),
 counts jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_id,source_namespace,external_batch_id)
);
CREATE INDEX ingestion_receipt_owner_created ON calypso_platform.ingestion_receipts(owner_id,created_at DESC);
