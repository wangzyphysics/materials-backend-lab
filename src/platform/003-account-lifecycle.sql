ALTER TABLE calypso_platform.users ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended','deleted'));
ALTER TABLE calypso_platform.users ADD COLUMN status_reason text NOT NULL DEFAULT '';
ALTER TABLE calypso_platform.users ADD COLUMN status_changed_at timestamptz;
ALTER TABLE calypso_platform.users ADD COLUMN demo_account boolean NOT NULL DEFAULT false;
ALTER TABLE calypso_platform.account_audit DROP CONSTRAINT account_audit_action_check;
ALTER TABLE calypso_platform.account_audit ADD CONSTRAINT account_audit_action_check CHECK(action IN ('profile-updated','password-reset','password-changed','account-suspended','account-reactivated','account-deleted','account-restored','sessions-revoked'));
CREATE INDEX platform_account_status ON calypso_platform.users(status,demo_account);
