-- ===========================================================================
-- InvisiPhish - pattern repository, feedback loop and audit trail
--
-- The feedback loop lets a user confirm or correct a prediction. Corrections
-- are not applied to the pattern repository immediately: they enter a
-- candidate state and are only promoted once they have been confirmed by
-- several distinct users. This is the poisoning defence described in the
-- paper's limitations section.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Mined phishing templates
-- ---------------------------------------------------------------------------

create table if not exists public.phishing_patterns (
  id            uuid primary key default gen_random_uuid(),
  items         text[] not null,
  template      text not null,
  spam_support  integer not null default 0,
  ham_support   integer not null default 0,
  lift          double precision not null default 1,
  status        text not null default 'active'
    check (status in ('candidate', 'active', 'retired')),
  -- How many distinct users have confirmed this template.
  confirmations integer not null default 0,
  source        text not null default 'seed'
    check (source in ('seed', 'mining', 'feedback', 'genai')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create unique index if not exists phishing_patterns_items_idx
  on public.phishing_patterns (items);

create index if not exists phishing_patterns_status_idx
  on public.phishing_patterns (status);

-- ---------------------------------------------------------------------------
-- Feedback
-- ---------------------------------------------------------------------------

create table if not exists public.feedback (
  id          uuid primary key default gen_random_uuid(),
  analysis_id uuid references public.analysis_results (id) on delete cascade,
  user_id     text not null,
  verdict     text not null
    check (verdict in ('confirmed_phishing', 'confirmed_legitimate', 'incorrect')),
  note        text,
  -- Whether this feedback has already been folded into the pattern repository.
  applied     boolean not null default false,
  created_at  timestamptz not null default now()
);

create index if not exists feedback_analysis_idx on public.feedback (analysis_id);
create index if not exists feedback_user_idx on public.feedback (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Audit trail
--
-- Every state-changing operation is recorded, including the ones performed by
-- server-side jobs with the administrative connection.
-- ---------------------------------------------------------------------------

create table if not exists public.audit_log (
  id         bigserial primary key,
  user_id    text,
  action     text not null,
  entity     text,
  entity_id  text,
  metadata   jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists audit_log_created_idx on public.audit_log (created_at desc);
create index if not exists audit_log_user_idx on public.audit_log (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Domain intelligence cache (RDAP lookups)
-- ---------------------------------------------------------------------------

create table if not exists public.domain_intel (
  domain        text primary key,
  registered_at timestamptz,
  registrar     text,
  country       text,
  age_days      integer,
  risk_score    double precision not null default 0,
  raw           jsonb,
  fetched_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.phishing_patterns enable row level security;
alter table public.feedback enable row level security;
alter table public.audit_log enable row level security;
alter table public.domain_intel enable row level security;

-- Mined templates are shared reference data: every signed-in user can read
-- the active set, but only server-side jobs may write to it. The write policy
-- is therefore deliberately absent - the table is read-only from the client.
drop policy if exists "patterns_select_active" on public.phishing_patterns;
create policy "patterns_select_active"
  on public.phishing_patterns for select to authenticated
  using (status in ('active', 'candidate'));

-- Feedback is private to its author.
drop policy if exists "feedback_select_own" on public.feedback;
create policy "feedback_select_own"
  on public.feedback for select to authenticated
  using ((select app.current_user_id()) = user_id);

drop policy if exists "feedback_insert_own" on public.feedback;
create policy "feedback_insert_own"
  on public.feedback for insert to authenticated
  with check ((select app.current_user_id()) = user_id);

drop policy if exists "feedback_update_own" on public.feedback;
create policy "feedback_update_own"
  on public.feedback for update to authenticated
  using ((select app.current_user_id()) = user_id)
  with check ((select app.current_user_id()) = user_id);

-- Audit entries are readable only by their author.
drop policy if exists "audit_select_own" on public.audit_log;
create policy "audit_select_own"
  on public.audit_log for select to authenticated
  using ((select app.current_user_id()) = user_id);

-- Domain intelligence is shared reference data, read-only from the client.
drop policy if exists "domain_intel_select_authenticated" on public.domain_intel;
create policy "domain_intel_select_authenticated"
  on public.domain_intel for select to authenticated
  using (true);

-- ---------------------------------------------------------------------------
-- Audit helper
-- ---------------------------------------------------------------------------

-- The audit log is readable only by its author, and it has no insert policy:
-- a user may not write arbitrary rows into it. The application still has to
-- record what a user did, and it records it from inside the same transaction
-- that carries the caller's identity, so the helper runs as its owner - the
-- owner has BYPASSRLS - rather than as the caller.
--
-- SECURITY DEFINER is safe here because of what the function does and does
-- not take from the caller: the user_id comes from the session variable, so
-- the row can only ever be written for the signed-in user who caused it, and
-- the parameters are the action, the entity and the metadata. The search
-- path is pinned, so nothing on it can be shadowed by a table of the
-- caller's making.
create or replace function app.write_audit(
  p_action text,
  p_entity text default null,
  p_entity_id text default null,
  p_metadata jsonb default '{}'::jsonb
) returns void
language sql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  insert into public.audit_log (user_id, action, entity, entity_id, metadata)
  values (app.current_user_id(), p_action, p_entity, p_entity_id, p_metadata)
$$;
