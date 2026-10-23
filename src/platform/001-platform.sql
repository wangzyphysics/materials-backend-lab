CREATE SCHEMA IF NOT EXISTS calypso_platform;
CREATE TABLE calypso_platform.migrations(version integer PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE calypso_platform.users(
 id uuid PRIMARY KEY, username text NOT NULL UNIQUE, email text NOT NULL UNIQUE,
 email_verified boolean NOT NULL DEFAULT false, role text NOT NULL DEFAULT 'member' CHECK(role IN ('member','admin')),
 profile jsonb NOT NULL, version bigint NOT NULL DEFAULT 1, test_account boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(), CHECK(username=lower(username)), CHECK(email=lower(email))
);
CREATE TABLE calypso_platform.password_credentials(user_id uuid PRIMARY KEY REFERENCES calypso_platform.users(id), password_hash jsonb NOT NULL);
CREATE TABLE calypso_platform.sessions(
 token_hash text PRIMARY KEY, user_id uuid REFERENCES calypso_platform.users(id), csrf_token text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL
);
CREATE INDEX platform_session_expiry ON calypso_platform.sessions(expires_at);
CREATE TABLE calypso_platform.role_audit(id uuid PRIMARY KEY, actor_id uuid NOT NULL REFERENCES calypso_platform.users(id), target_id uuid NOT NULL REFERENCES calypso_platform.users(id), previous_role text NOT NULL, role text NOT NULL, reason text NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE calypso_platform.rate_limits(key text PRIMARY KEY, window_start timestamptz NOT NULL, attempts integer NOT NULL);
CREATE TABLE calypso_platform.batches(
 id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES calypso_platform.users(id), draft_json jsonb NOT NULL,
 review_status text NOT NULL DEFAULT 'not-submitted' CHECK(review_status IN ('not-submitted','pending','needs-information','approved','rejected')),
 review_notes text NOT NULL DEFAULT '', reviewer_id uuid REFERENCES calypso_platform.users(id),
 submitted_at timestamptz, deleted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX platform_batch_owner ON calypso_platform.batches(owner_id,updated_at DESC);
CREATE TABLE calypso_platform.files(
 batch_id uuid NOT NULL REFERENCES calypso_platform.batches(id), client_id text NOT NULL, path text NOT NULL,
 sha256 text NOT NULL, size integer NOT NULL, media_type text NOT NULL, bytes bytea NOT NULL,
 PRIMARY KEY(batch_id,client_id), UNIQUE(batch_id,path), CHECK(octet_length(bytes)=size), CHECK(size>0 AND size<=10485760)
);
CREATE TABLE calypso_platform.records(
 id uuid PRIMARY KEY, batch_id uuid NOT NULL REFERENCES calypso_platform.batches(id), client_id text NOT NULL,
 input_json jsonb NOT NULL, UNIQUE(batch_id,client_id)
);
CREATE TABLE calypso_platform.batch_events(
 sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, batch_id uuid NOT NULL REFERENCES calypso_platform.batches(id),
 actor_id uuid REFERENCES calypso_platform.users(id), type text NOT NULL, detail jsonb NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now()
);
