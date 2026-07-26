-- Primary admin protection: adds is_primary_admin flag to the users table.
-- Exactly ONE account should ever have this set to true.
-- Set it manually via SQL: UPDATE users SET is_primary_admin = true WHERE email = 'your@email.com';
-- There is no UI to set or unset this flag — it is a deliberate out-of-band operation.

alter table users
  add column if not exists is_primary_admin boolean not null default false;

-- Ensure at most one primary admin can exist at any time.
create unique index if not exists users_primary_admin_unique
  on users (is_primary_admin)
  where (is_primary_admin = true);
