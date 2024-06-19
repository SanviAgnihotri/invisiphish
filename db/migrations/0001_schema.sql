-- ===========================================================================
-- InvisiPhish - core schema (Neon / PostgreSQL)
--
-- Apply with:
--   npx tsx db/apply.ts
-- or
--   psql "$DATABASE_ADMIN_URL" -f db/migrations/0001_schema.sql
--
-- Authentication is provided by Neon Auth (Managed Better Auth), which stores
-- users and sessions in the `neon_auth` schema. Application tables reference
-- the auth user id as text.
--
-- Row Level Security
-- ------------------
-- Policies read the authenticated user from the `request.jwt.claims` session
-- variable. Neon sets that variable automatically for the Data API, and the
-- Neon Authorize endpoint sets it when the serverless driver is used with an
-- `authToken`. Using the session variable (rather than `auth.user_id()`) keeps
-- the policies portable across both access paths.
-- ===========================================================================

create schema if not exists app;

-- The authenticated user's id, taken from the verified JWT claims.
create or replace function app.current_user_id() returns text
language sql stable
as $$
  select nullif(
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'),
    ''
  )
$$;

create or replace function app.current_user_email() returns text
language sql stable
as $$
  select nullif(
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email'),
    ''
  )
$$;

-- ---------------------------------------------------------------------------
-- Organisations
-- ---------------------------------------------------------------------------

create table if not exists public.organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        text not null unique,
  created_at  timestamptz not null default now()
);

create table if not exists public.organization_members (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id         text not null,
  role            text not null default 'member'
    check (role in ('owner', 'admin', 'member', 'viewer')),
  created_at      timestamptz not null default now(),
  primary key (organization_id, user_id)
);

-- ---------------------------------------------------------------------------
-- Profile
--
-- Mirrors the Neon Auth user and carries the application metadata that the
-- registration form collects. Created lazily by the API on first sign-in so
-- that no trigger on the auth schema is required.
-- ---------------------------------------------------------------------------

create table if not exists public.profiles (
  id            uuid primary key default gen_random_uuid(),
  user_id       text not null unique,
  email         text not null,
  full_name     text,
  organization  text,
  created_at    timestamptz not null default now(),
  last_login_at timestamptz
);

-- ---------------------------------------------------------------------------
-- Analysis results
--
-- `module_results`, `evidence`, `contributions`, `explanation` and
-- `groundedness` store the full trace of a decision so that any verdict can be
-- reconstructed and audited after the fact.
-- ---------------------------------------------------------------------------

create table if not exists public.analysis_results (
  id               uuid primary key default gen_random_uuid(),
  user_id          text not null,
  organization_id  uuid references public.organizations (id) on delete set null,
  original_text    text not null,
  normalized_text  text not null,
  final_score      double precision not null,
  verdict          text not null
    check (verdict in ('legitimate', 'suspicious', 'phishing')),
  confidence       double precision not null,
  module_results   jsonb not null default '[]'::jsonb,
  evidence         jsonb not null default '[]'::jsonb,
  contributions    jsonb not null default '[]'::jsonb,
  explanation      jsonb,
  groundedness     jsonb,
  model_version    text,
  latency_ms       integer,
  created_at       timestamptz not null default now()
);

create index if not exists analysis_results_user_created_idx
  on public.analysis_results (user_id, created_at desc);

create index if not exists analysis_results_org_created_idx
  on public.analysis_results (organization_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
alter table public.analysis_results enable row level security;

-- Profiles: a user can read and update only their own row.
drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
  on public.profiles for select to authenticated
  using ((select app.current_user_id()) = user_id);

drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own"
  on public.profiles for insert to authenticated
  with check ((select app.current_user_id()) = user_id);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
  on public.profiles for update to authenticated
  using ((select app.current_user_id()) = user_id)
  with check ((select app.current_user_id()) = user_id);

-- Organisations: visible to their members.
drop policy if exists "organizations_select_member" on public.organizations;
create policy "organizations_select_member"
  on public.organizations for select to authenticated
  using (
    exists (
      select 1 from public.organization_members m
      where m.organization_id = organizations.id
        and m.user_id = (select app.current_user_id())
    )
  );

drop policy if exists "organizations_insert_authenticated" on public.organizations;
create policy "organizations_insert_authenticated"
  on public.organizations for insert to authenticated
  with check ((select app.current_user_id()) is not null);

drop policy if exists "organizations_update_owner" on public.organizations;
create policy "organizations_update_owner"
  on public.organizations for update to authenticated
  using (
    exists (
      select 1 from public.organization_members m
      where m.organization_id = organizations.id
        and m.user_id = (select app.current_user_id())
        and m.role in ('owner', 'admin')
    )
  );

-- Membership: a member can see their own memberships; owners manage them.
drop policy if exists "members_select_own" on public.organization_members;
create policy "members_select_own"
  on public.organization_members for select to authenticated
  using ((select app.current_user_id()) = user_id);

drop policy if exists "members_insert_owner" on public.organization_members;
create policy "members_insert_owner"
  on public.organization_members for insert to authenticated
  with check (
    exists (
      select 1 from public.organization_members m
      where m.organization_id = organization_members.organization_id
        and m.user_id = (select app.current_user_id())
        and m.role in ('owner', 'admin')
    )
  );

drop policy if exists "members_delete_owner" on public.organization_members;
create policy "members_delete_owner"
  on public.organization_members for delete to authenticated
  using (
    exists (
      select 1 from public.organization_members m
      where m.organization_id = organization_members.organization_id
        and m.user_id = (select app.current_user_id())
        and m.role in ('owner', 'admin')
    )
  );

-- Analysis results: strictly per user. There is deliberately no policy that
-- lets one user read another user's analyses, even inside one organisation.
drop policy if exists "analysis_select_own" on public.analysis_results;
create policy "analysis_select_own"
  on public.analysis_results for select to authenticated
  using ((select app.current_user_id()) = user_id);

drop policy if exists "analysis_insert_own" on public.analysis_results;
create policy "analysis_insert_own"
  on public.analysis_results for insert to authenticated
  with check ((select app.current_user_id()) = user_id);

drop policy if exists "analysis_update_own" on public.analysis_results;
create policy "analysis_update_own"
  on public.analysis_results for update to authenticated
  using ((select app.current_user_id()) = user_id)
  with check ((select app.current_user_id()) = user_id);

drop policy if exists "analysis_delete_own" on public.analysis_results;
create policy "analysis_delete_own"
  on public.analysis_results for delete to authenticated
  using ((select app.current_user_id()) = user_id);
