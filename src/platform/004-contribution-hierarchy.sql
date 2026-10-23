-- Additive identities for contribution graphs. Original batches/files/records and source scientific tables are preserved.
CREATE TABLE calypso_platform.contribution_phases (
 id text PRIMARY KEY,
 batch_id uuid NOT NULL REFERENCES calypso_platform.batches(id),
 metadata jsonb NOT NULL,
 UNIQUE(batch_id,id)
);
CREATE TABLE calypso_platform.contribution_conditions (
 id text PRIMARY KEY,
 batch_id uuid NOT NULL REFERENCES calypso_platform.batches(id),
 phase_id text NOT NULL,
 metadata jsonb NOT NULL,
 FOREIGN KEY(batch_id,phase_id) REFERENCES calypso_platform.contribution_phases(batch_id,id),
 UNIQUE(batch_id,id)
);
CREATE INDEX platform_contribution_condition_phase ON calypso_platform.contribution_conditions(batch_id,phase_id);
