-- Blast radius for the passwordless auth change.
--
-- Paste into the Supabase SQL editor. Read-only: every statement is a SELECT.
-- Run this BEFORE the migration so the "after" numbers can be compared to it.

-- 1. Approval states across the two places they are recorded.
--    access_requests.status is the APPLICATION; users.approval_status is the
--    ACCOUNT. They can disagree: a rejection updates the request but never
--    creates or updates a users row.
select 'access_requests' as source, status, count(*) as n
from public.access_requests
group by status

union all

select 'users' as source, approval_status as status, count(*) as n
from public.users
group by approval_status

union all

select 'users (admins)' as source, role as status, count(*) as n
from public.users
group by role
order by source, status;

-- 2. Who can actually sign in today, and who would be stranded.
--
--    A non-admin approved user needs BOTH a usable secret and at least one
--    live activation to pass requireSupabaseAuth. Admins bypass both.
select
  count(*) filter (where u.role = 'admin') as admins_no_secret_needed,

  count(*) filter (
    where u.role <> 'admin' and u.approval_status = 'approved'
  ) as approved_regular_users,

  count(*) filter (
    where u.role <> 'admin' and u.approval_status = 'approved'
      and s.id is not null
  ) as approved_with_usable_secret,

  -- These people are approved but cannot use the app today; they need a
  -- secret issued regardless of this change.
  count(*) filter (
    where u.role <> 'admin' and u.approval_status = 'approved'
      and s.id is null
  ) as approved_without_secret,

  -- Have a secret AND have activated at least one browser: signing in today.
  count(*) filter (
    where u.role <> 'admin' and u.approval_status = 'approved'
      and s.id is not null and s.activation_count > 0
  ) as approved_with_active_device
from public.users u
left join public.user_access_secrets s
  on s.user_id = u.id and s.status in ('active', 'exhausted');

-- 3. Device slots in use — the population the trusted-device change touches.
select
  count(*) as usable_secrets,
  sum(s.activation_count) as total_activations,
  count(*) filter (where s.status = 'exhausted') as secrets_at_the_five_limit,
  count(*) filter (where s.activation_count = 0) as issued_but_never_activated
from public.user_access_secrets s
where s.status in ('active', 'exhausted');

-- 4. Live trusted devices (the rows a new-device email code would skip).
select count(*) as live_activations
from public.access_activations
where revoked_at is null;

-- 5. Confirm secrets are hashed, not plaintext. secret_hash should be 64 hex
--    characters (HMAC-SHA256) for every row, and no column should hold the
--    secret itself. Expect all_hashed = true and a 4-character suffix only.
select
  bool_and(secret_hash ~ '^[a-f0-9]{64}$') as all_hashed,
  bool_and(char_length(secret_suffix) = 4) as suffix_is_4_chars,
  count(*) as rows_checked
from public.user_access_secrets;
