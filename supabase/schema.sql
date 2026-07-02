-- Jetplan KNX Konverter — Supabase schema
-- Project: qmbmskthgxdmybvqyoax (https://qmbmskthgxdmybvqyoax.supabase.co)
--
-- No CLI/service-role/MCP access is available in the dev environment this was
-- written in — apply this manually: Supabase Dashboard → SQL Editor → paste → Run.
-- Keep this file in sync with whatever you actually run, by hand.

create extension if not exists pgcrypto; -- gen_random_uuid()

create table if not exists public.projects (
  id          uuid primary key default gen_random_uuid(),
  name        text,
  unit_code   text,
  data        jsonb not null,               -- {meta, data:{projects, units, outletItems}} — same shape as file export/import
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists projects_updated_at_idx on public.projects (updated_at desc);

alter table public.projects enable row level security;

-- v1: single shared pool. ANY authenticated user can see/edit/delete ANY project.
-- No per-user or per-org isolation yet — deliberate, see forward-compat note below.
-- Policy names use plain identifiers (no quotes/spaces) so they survive
-- copy-paste through chat/markdown clients that mangle "smart quotes".
create policy projects_select_authenticated
  on public.projects for select
  to authenticated
  using (true);

create policy projects_insert_authenticated
  on public.projects for insert
  to authenticated
  with check (true);

create policy projects_update_authenticated
  on public.projects for update
  to authenticated
  using (true)
  with check (true);

create policy projects_delete_authenticated
  on public.projects for delete
  to authenticated
  using (true);

-- updated_at is maintained server-side via trigger, not trusted from the client.
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_projects_set_updated_at on public.projects;
create trigger trg_projects_set_updated_at
  before update on public.projects
  for each row
  execute function public.set_updated_at();

-- ── Forward-compat note (NOT implemented in v1) ──────────────────────────────
-- When/if this opens to other companies, add:
--   alter table public.projects add column organization_id uuid;
-- and rewrite the 4 policies above to scope on organization_id instead of `true`.
-- Cheap 1-line migration later, not worth doing today.
