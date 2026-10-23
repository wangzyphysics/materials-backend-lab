ALTER TABLE calypso_platform.users ADD COLUMN password_change_required boolean NOT NULL DEFAULT false;
-- Fill the existing empty contact from the registered email; preserve supplied profile data.
UPDATE calypso_platform.users
SET profile=jsonb_set(profile,'{contactEmail}',to_jsonb(email)),version=version+1
WHERE coalesce(profile->>'contactEmail','')='';
CREATE TABLE calypso_platform.account_audit(
 id uuid PRIMARY KEY, actor_id uuid NOT NULL REFERENCES calypso_platform.users(id),
 target_id uuid NOT NULL REFERENCES calypso_platform.users(id),
 action text NOT NULL CHECK(action IN ('profile-updated','password-reset','password-changed')),
 reason text NOT NULL, changed_fields jsonb NOT NULL DEFAULT '[]', occurred_at timestamptz NOT NULL DEFAULT now()
);
