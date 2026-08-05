-- Passwordless sign-in for regular users.
--
-- WHAT CHANGES. Regular users sign in with email -> access secret -> a one-time
-- emailed code on a device that is not already trusted. Administrators keep
-- email + password, which is what they use today; that path is deliberately
-- untouched, so the account that issues access secrets can never be locked out
-- by a change to the access-secret flow.
--
-- WHAT DOES NOT CHANGE. Access secrets are already per-person, already hashed
-- (HMAC-SHA256 with ACCESS_SECRET_PEPPER), and already limited to five trusted
-- browsers by user_access_secrets.max_activations. None of that is rebuilt here.
-- The emailed code is a gate placed BEFORE activate_access_secret runs for an
-- unrecognised device; a device that passes the code then activates through the
-- existing RPC and becomes one of the same five. Sixth-device behaviour
-- ('exhausted', recoverable only by an admin reset) is preserved exactly.

-- ── Trusted-device expiry ───────────────────────────────────────────────────
--
-- Activations had no expiry: once trusted, a browser stayed trusted until an
-- admin reset it. A trust window bounds the damage from a stolen laptop without
-- making anyone re-verify weekly. NULL means "no expiry", which is what every
-- row written before this migration means — see the backfill below.
alter table public.access_activations
  add column if not exists trusted_until timestamptz;

comment on column public.access_activations.trusted_until is
  'When this browser stops being trusted and must pass a fresh emailed code. NULL means it never expires (rows written before trusted-device expiry existed).';

-- Existing trusted browsers get the standard window from now rather than being
-- expired retroactively. Nobody who can sign in today is asked to re-verify
-- because of this migration.
update public.access_activations
set trusted_until = now() + interval '60 days'
where revoked_at is null
  and trusted_until is null;

create index if not exists access_activations_trusted_idx
  on public.access_activations (user_id, client_token_hash)
  where revoked_at is null;

-- ── One-time email codes ────────────────────────────────────────────────────
--
-- Holds the POLICY around a login code, not necessarily the code itself.
--
-- With Supabase's built-in email service the code is Supabase's own OTP —
-- the built-in service can only send Auth's templated emails, so there is no way
-- to deliver a code we generated. Supabase hashes and expires that code; this
-- table still enforces the parts Supabase does not: how often a code may be
-- REQUESTED, how many times it may be attempted, and that requesting a new one
-- invalidates the old.
--
-- code_hash is nullable for exactly that reason. When delivery moves to a real
-- transactional provider the code becomes ours, and it is stored here hashed —
-- the column is already the right shape.
create table if not exists public.auth_login_codes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  email_normalized text not null,
  -- HMAC-SHA256 hex of the code, when we own it. Never the code itself.
  code_hash text check (code_hash is null or char_length(code_hash) = 64),
  -- Which browser asked. The code is only good for that browser, so a code
  -- phished out of someone's inbox cannot be used from somewhere else.
  client_token_hash text not null check (char_length(client_token_hash) = 64),
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 5 check (max_attempts > 0),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  -- Set when a newer request supersedes this one.
  invalidated_at timestamptz,
  created_at timestamptz not null default now()
);

-- One live code per user per browser: the partial unique index is what makes
-- "a new request invalidates the previous one" enforceable rather than hoped for.
create unique index if not exists auth_login_codes_live_unique
  on public.auth_login_codes (user_id, client_token_hash)
  where consumed_at is null and invalidated_at is null;

create index if not exists auth_login_codes_email_created_idx
  on public.auth_login_codes (email_normalized, created_at desc);

alter table public.auth_login_codes enable row level security;
revoke all on public.auth_login_codes from public, anon, authenticated;
grant all on public.auth_login_codes to service_role;

comment on table public.auth_login_codes is
  'One-time sign-in codes for devices that are not yet trusted. Rows record request rate limiting, attempt ceilings and single use. code_hash is null while Supabase''s built-in OTP owns the code itself.';

-- ── Failed sign-in attempts ─────────────────────────────────────────────────
--
-- The access-secret screen is now UNAUTHENTICATED — it has to be, because the
-- secret is checked before any session exists. That makes it the one endpoint
-- worth guessing at, so every failure is recorded and counted per email and per
-- IP independently. Recorded here rather than in access_security_events so the
-- rate-limit read is a narrow indexed count rather than a scan of an audit log
-- that grows without bound.
create table if not exists public.auth_login_failures (
  id bigint generated always as identity primary key,
  email_normalized text,
  ip_address text,
  -- 'secret' | 'code' — which screen the failure happened on.
  stage text not null,
  created_at timestamptz not null default now()
);

create index if not exists auth_login_failures_email_idx
  on public.auth_login_failures (email_normalized, created_at desc);
create index if not exists auth_login_failures_ip_idx
  on public.auth_login_failures (ip_address, created_at desc);

alter table public.auth_login_failures enable row level security;
revoke all on public.auth_login_failures from public, anon, authenticated;
grant all on public.auth_login_failures to service_role;

comment on table public.auth_login_failures is
  'Failed sign-in attempts, for per-email and per-IP rate limiting. Records the email and IP only — never the secret or code that was tried.';

-- ── Revocation must also kill trusted devices ───────────────────────────────
--
-- Revoking a secret already revoked its activations in application code. Doing
-- it in the database as well means it holds even when revocation happens by
-- some other route, which is the property that matters for a credential that
-- has just replaced passwords.
create or replace function public.revoke_activations_with_secret()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'revoked' and coalesce(old.status, '') <> 'revoked' then
    update public.access_activations
    set revoked_at = coalesce(revoked_at, now())
    where secret_id = new.id and revoked_at is null;

    update public.auth_login_codes
    set invalidated_at = coalesce(invalidated_at, now())
    where user_id = new.user_id and consumed_at is null and invalidated_at is null;
  end if;
  return new;
end;
$$;

drop trigger if exists revoke_activations_with_secret_trigger on public.user_access_secrets;
create trigger revoke_activations_with_secret_trigger
after update on public.user_access_secrets
for each row execute function public.revoke_activations_with_secret();

revoke all on function public.revoke_activations_with_secret() from public, anon, authenticated;
grant execute on function public.revoke_activations_with_secret() to service_role;

-- ── Trusted-device check, now expiry-aware ──────────────────────────────────
--
-- Same signature and same semantics as before, plus the trust window. A NULL
-- trusted_until still counts as trusted, so pre-migration rows behave exactly
-- as they did.
create or replace function public.check_access_activation(
  p_user_id uuid,
  p_client_token_hash text
)
returns boolean
language sql
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.users u
    join public.user_access_secrets s on s.user_id = u.id
    join public.access_activations a on a.secret_id = s.id and a.user_id = u.id
    where u.id = p_user_id
      and u.approval_status = 'approved'
      and s.status in ('active', 'exhausted')
      and a.client_token_hash = p_client_token_hash
      and a.revoked_at is null
      and (a.trusted_until is null or a.trusted_until > now())
  );
$$;

revoke all on function public.check_access_activation(uuid, text) from public, anon, authenticated;
grant execute on function public.check_access_activation(uuid, text) to service_role;

-- ── Constant-time secret comparison ─────────────────────────────────────────
--
-- The comparison is between HMAC digests rather than secrets, so a timing leak
-- reveals nothing invertible without the pepper. It is still replaced: `<>` on
-- text short-circuits at the first differing byte, and a credential check that
-- has just replaced passwords should not be the place we accept that.
--
-- Same signature and same outcomes as before; only the comparison changes.
create or replace function public.activate_access_secret(
  p_user_id uuid,
  p_secret_hash text,
  p_client_token_hash text
)
returns table (outcome text, activation_count integer, max_activations integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_secret public.user_access_secrets%rowtype;
  v_now timestamptz := clock_timestamp();
  v_trust_days integer := 60;
begin
  select uas.* into v_secret
  from public.user_access_secrets as uas
  where uas.user_id = p_user_id and uas.status in ('active', 'exhausted')
  for update;

  if not found then
    return query select 'denied'::text, 0, 5;
    return;
  end if;

  if exists (
    select 1
    from public.access_activations as aa
    where aa.secret_id = v_secret.id
      and aa.client_token_hash = p_client_token_hash
      and aa.revoked_at is null
  ) then
    update public.access_activations as aa
      set last_seen_at = v_now,
          trusted_until = v_now + make_interval(days => v_trust_days)
      where aa.secret_id = v_secret.id and aa.client_token_hash = p_client_token_hash;
    update public.user_access_secrets as uas
      set last_used_at = v_now
      where uas.id = v_secret.id;
    return query select 'trusted'::text, v_secret.activation_count, v_secret.max_activations;
    return;
  end if;

  if v_secret.failed_window_started_at is not null
     and v_secret.failed_window_started_at > v_now - interval '15 minutes'
     and v_secret.failed_attempt_count >= 10 then
    return query select 'rate_limited'::text, v_secret.activation_count, v_secret.max_activations;
    return;
  end if;

  -- Constant-time: compares every byte regardless of where the first difference
  -- is. Both operands are fixed-length hex digests, so lengths always match.
  if not (
    select coalesce(bit_or(
      get_byte(convert_to(v_secret.secret_hash, 'UTF8'), i)
      # get_byte(convert_to(p_secret_hash, 'UTF8'), i)
    ), 1) = 0
    from generate_series(0, 63) as i
    where char_length(v_secret.secret_hash) = 64 and char_length(p_secret_hash) = 64
  ) then
    update public.user_access_secrets as uas set
      failed_window_started_at = case
        when uas.failed_window_started_at is null
          or uas.failed_window_started_at <= v_now - interval '15 minutes'
          then v_now else uas.failed_window_started_at end,
      failed_attempt_count = case
        when uas.failed_window_started_at is null
          or uas.failed_window_started_at <= v_now - interval '15 minutes'
          then 1 else uas.failed_attempt_count + 1 end
    where uas.id = v_secret.id;
    insert into public.access_security_events(event_type, user_id, secret_id)
      values ('secret_verification_failed', p_user_id, v_secret.id);
    return query select 'denied'::text, v_secret.activation_count, v_secret.max_activations;
    return;
  end if;

  if v_secret.status = 'exhausted' or v_secret.activation_count >= v_secret.max_activations then
    update public.user_access_secrets as uas
      set status = 'exhausted'
      where uas.id = v_secret.id;
    return query select 'exhausted'::text, v_secret.activation_count, v_secret.max_activations;
    return;
  end if;

  insert into public.access_activations(secret_id, user_id, client_token_hash, trusted_until)
    values (v_secret.id, p_user_id, p_client_token_hash, v_now + make_interval(days => v_trust_days));
  update public.user_access_secrets as uas set
    activation_count = uas.activation_count + 1,
    status = case
      when uas.activation_count + 1 >= uas.max_activations then 'exhausted'
      else 'active'
    end,
    failed_attempt_count = 0,
    failed_window_started_at = null,
    last_used_at = v_now
  where uas.id = v_secret.id
  returning uas.* into v_secret;
  insert into public.access_security_events(event_type, user_id, secret_id, metadata)
    values ('client_activated', p_user_id, v_secret.id,
      jsonb_build_object('activation_count', v_secret.activation_count));
  if v_secret.status = 'exhausted' then
    insert into public.access_security_events(event_type, user_id, secret_id, metadata)
      values ('secret_exhausted', p_user_id, v_secret.id,
        jsonb_build_object('activation_count', v_secret.activation_count));
  end if;
  return query select 'activated'::text, v_secret.activation_count, v_secret.max_activations;
end;
$$;

revoke all on function public.activate_access_secret(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.activate_access_secret(uuid, text, text) to service_role;

-- ── Administrators may now hold an access secret ────────────────────────────
--
-- Not required by the sign-in flow — administrators keep email + password — but
-- the old application-level refusal is no longer a schema-level assumption
-- anywhere, and an admin who also uses the app as a normal user needs one.
-- Nothing here forces it.
