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

-- ═══════════════════════════════════════════════════════════════════════════
-- Mandantenfähigkeit + Bezahlmodell — Phase 1 (2026-09-20)
-- Löst das Forward-compat-Versprechen oben ein: organization_id + echte RLS-Trennung.
-- Firma/Team ist der Mandant (nicht die einzelne Person) — mehrere Logins teilen sich
-- eine Org und deren Projekt-Kontingent. Stripe-Anbindung (Phase 2/3) kommt separat,
-- dieser Block ist reine Schema-/Zugriffsgrundlage, noch ohne Zahlungsfluss.
-- ═══════════════════════════════════════════════════════════════════════════

create table public.organizations (
  id                      uuid primary key default gen_random_uuid(),
  name                    text not null default 'Neue Firma',
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  stripe_customer_id      text unique,
  stripe_subscription_id  text unique,
  subscription_status     text,               -- Stripes eigener Status-String, erst ab Phase 3 befüllt
  current_period_end      timestamptz,
  one_time_credits        integer not null default 0,  -- dauerhaft, verfällt nie (Einmalkäufe)
  subscription_credits    integer not null default 0,  -- bei jeder Verlängerung auf 10 zurückgesetzt
  project_credits         integer generated always as (one_time_credits + subscription_credits) stored
);
alter table public.organizations enable row level security;

-- v1: eine Org pro Nutzer (kein Org-Switcher), daher unique auf user_id.
create table public.organization_members (
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  user_id          uuid not null references auth.users(id) on delete cascade,
  role             text not null default 'member' check (role in ('owner','member')),
  created_at       timestamptz not null default now(),
  primary key (organization_id, user_id)
);
create unique index organization_members_user_id_key on public.organization_members (user_id);
alter table public.organization_members enable row level security;

-- Einziger Weg, wie ein zweites Teammitglied einer Org beitritt: ein owner trägt die
-- E-Mail-Adresse ein (reiner Client-Insert, per Policy unten abgesichert), die normale
-- Magic-Link-Anmeldung des Eingeladenen matcht dann automatisch über bootstrap_org().
-- Bewusst kein E-Mail-Domain-Auto-Join — private gmail/gmx-Adressen bei kleinen
-- Elektrobetrieben würden sonst fälschlich fremde Firmen zusammenlegen.
create table public.organization_invites (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  email            text not null,
  invited_by       uuid references auth.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  consumed_at      timestamptz,
  consumed_by      uuid references auth.users(id) on delete set null
);
create unique index organization_invites_pending_email_idx
  on public.organization_invites (organization_id, lower(email)) where consumed_at is null;
alter table public.organization_invites enable row level security;

-- Append-only Audit-Ledger UND Stripe-Idempotenz-Schlüssel (stripe_event_id unique) —
-- Stripe liefert Webhooks at-least-once, ohne diesen Guard würde ein Retry doppelt gutschreiben.
create table public.credit_events (
  id               bigint generated always as identity primary key,
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  delta            integer not null,
  reason           text not null,  -- one_time_purchase|subscription_activated|subscription_renewed|subscription_canceled|project_created|manual_adjustment
  stripe_event_id  text unique,
  project_id       uuid references public.projects(id) on delete set null,
  created_at       timestamptz not null default now()
);
create index credit_events_org_id_idx on public.credit_events (organization_id, created_at desc);
alter table public.credit_events enable row level security;

-- ── RLS: nur die eigene Org lesen. Kein Client-Schreibzugriff auf organizations/
-- credit_events überhaupt (geldrelevant) — nur der Trigger unten (security definer) und
-- später der Stripe-Webhook (service-role) dürfen dort schreiben.
create or replace function public.current_org_id()
returns uuid language sql security definer set search_path = public stable as $$
  select organization_id from public.organization_members where user_id = auth.uid() limit 1;
$$;
grant execute on function public.current_org_id() to authenticated;

create policy organizations_select_own
  on public.organizations for select to authenticated
  using (id = public.current_org_id());

create policy organization_members_select_own_org
  on public.organization_members for select to authenticated
  using (organization_id = public.current_org_id());

create policy organization_invites_select_own_org
  on public.organization_invites for select to authenticated
  using (organization_id = public.current_org_id());

create policy organization_invites_insert_owner
  on public.organization_invites for insert to authenticated
  with check (
    organization_id = public.current_org_id()
    and exists (
      select 1 from public.organization_members m
      where m.organization_id = public.current_org_id() and m.user_id = auth.uid() and m.role = 'owner'
    )
  );

-- Phase 4: owner kann eine noch offene (nicht eingelöste) Einladung zurückziehen -
-- gleiche owner-Bedingung wie beim Anlegen, kein separates "consumed_at is null" nötig
-- (der eindeutige Index auf pending-Einladungen sorgt ohnehin dafür, dass eine bereits
-- eingelöste Zeile für einen erneuten Einladungsversuch nicht im Weg steht).
create policy organization_invites_delete_owner
  on public.organization_invites for delete to authenticated
  using (
    organization_id = public.current_org_id()
    and exists (
      select 1 from public.organization_members m
      where m.organization_id = public.current_org_id() and m.user_id = auth.uid() and m.role = 'owner'
    )
  );

create policy credit_events_select_own_org
  on public.credit_events for select to authenticated
  using (organization_id = public.current_org_id());

-- ── bootstrap_org(): einmal pro Login aus dem Client aufgerufen (index.html,
-- handleSession()). Idempotent: bestehende Mitgliedschaft -> zurückgeben; sonst passende
-- offene Einladung einlösen; sonst neue Org anlegen (Nutzer wird owner).
create or replace function public.bootstrap_org()
returns uuid language plpgsql security definer set search_path = public as $$
declare
  existing_org  uuid;
  matched_invite record;
  new_org       uuid;
  caller_email  text;
begin
  select organization_id into existing_org from public.organization_members where user_id = auth.uid();
  if existing_org is not null then
    return existing_org;
  end if;

  select email into caller_email from auth.users where id = auth.uid();

  select * into matched_invite from public.organization_invites
    where lower(email) = lower(caller_email) and consumed_at is null
    limit 1;
  if found then
    insert into public.organization_members (organization_id, user_id, role)
      values (matched_invite.organization_id, auth.uid(), 'member');
    update public.organization_invites set consumed_at = now(), consumed_by = auth.uid()
      where id = matched_invite.id;
    return matched_invite.organization_id;
  end if;

  insert into public.organizations (name)
    values (coalesce(nullif(split_part(caller_email, '@', 2), ''), 'Neue Firma'))
    returning id into new_org;
  insert into public.organization_members (organization_id, user_id, role) values (new_org, auth.uid(), 'owner');
  return new_org;
exception
  when unique_violation then
    -- Race: zwei gleichzeitige erste Aufrufe desselben Nutzers (z.B. zwei Tabs) - der
    -- Verlierer der organization_members-unique-Kollision liest einfach den Gewinner.
    select organization_id into existing_org from public.organization_members where user_id = auth.uid();
    return existing_org;
end;
$$;
grant execute on function public.bootstrap_org() to authenticated;

-- ── projects: organization_id-Spalte + Bestands-Backfill + Kontingent-Trigger ───────
alter table public.projects add column organization_id uuid references public.organizations(id) on delete cascade;

-- Backfill: EIN gemeinsamer Bestands-Mandant für den bisherigen geteilten Pool (alle
-- existierenden Nutzer + Projekte). 10 Start-Credits (= ein Jahresplan), reicht zum
-- Weiterarbeiten/Testen. Bei Bedarf danach manuell per SQL anpassen (Name, Credits,
-- ggf. auf mehrere Orgs aufteilen) — Stefan hat das für Phase 1 so bestätigt.
do $$
declare legacy_org uuid;
begin
  insert into public.organizations (name, subscription_credits)
    values ('Bestand (vor Bezahlmodell)', 10)
    returning id into legacy_org;
  insert into public.organization_members (organization_id, user_id, role)
    select legacy_org, id, 'owner' from auth.users
    on conflict (user_id) do nothing;
  update public.projects set organization_id = legacy_org where organization_id is null;
end $$;

alter table public.projects alter column organization_id set not null;

drop policy projects_select_authenticated on public.projects;
drop policy projects_insert_authenticated on public.projects;
drop policy projects_update_authenticated on public.projects;
drop policy projects_delete_authenticated on public.projects;

create policy projects_select_own_org on public.projects for select to authenticated
  using (organization_id = public.current_org_id());
create policy projects_insert_own_org on public.projects for insert to authenticated
  with check (organization_id = public.current_org_id());
create policy projects_update_own_org on public.projects for update to authenticated
  using (organization_id = public.current_org_id())
  with check (organization_id = public.current_org_id());
create policy projects_delete_own_org on public.projects for delete to authenticated
  using (organization_id = public.current_org_id());

-- Kontingent-Durchsetzung als before-insert-Trigger statt reinem Client-Check: fängt
-- JEDEN Schreibweg ab (auch einen modifizierten Client oder rohen REST-Call mit gültigem
-- JWT), da PostgREST keinen Pfad an Triggern vorbei anbietet. organization_id wird vom
-- Trigger fest gesetzt, ein vom Client mitgeschickter Wert wird ignoriert/überschrieben.
-- "for update" sperrt die Org-Zeile, damit zwei gleichzeitige Projekt-Anlagen (letztes
-- Kontingent, zwei Teammitglieder) sich nicht gegenseitig überbuchen. Abo-Kontingent wird
-- vor Einmalkauf-Kontingent verbraucht (verfällt eher). Kein Kontingent-Rückerstattung
-- bei Löschen eines Projekts — verhindert Anlegen/Löschen/Anlegen-Missbrauch.
create or replace function public.assign_org_and_enforce_quota()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  org uuid;
  sub_left int;
  one_time_left int;
begin
  org := public.current_org_id();
  if org is null then
    raise exception 'QUOTA_EXCEEDED: Kein Team zugeordnet.';
  end if;
  new.organization_id := org;

  select subscription_credits, one_time_credits into sub_left, one_time_left
    from public.organizations where id = org for update;

  if sub_left > 0 then
    update public.organizations set subscription_credits = subscription_credits - 1, updated_at = now() where id = org;
  elsif one_time_left > 0 then
    update public.organizations set one_time_credits = one_time_credits - 1, updated_at = now() where id = org;
  else
    raise exception 'QUOTA_EXCEEDED: Kein Projekt-Kontingent mehr verfügbar.';
  end if;

  return new;
end;
$$;

-- Ledger-Eintrag bewusst in einem SEPARATEN after-insert-Trigger, nicht im obigen
-- before-insert-Trigger: new.id hat als Spalten-Default zwar schon einen Wert, wenn der
-- before-Trigger läuft, aber die projects-Zeile selbst existiert noch nicht in der
-- Tabelle - ein insert in credit_events mit project_id = new.id verletzt daher IMMER den
-- FK credit_events_project_id_fkey (produktiv aufgefallen: jedes Projekt-Anlegen schlug
-- fehl, nicht nur bei aufgebrauchtem Kontingent). Im after-Trigger existiert die Zeile
-- bereits, new.organization_id trägt schon den vom Trigger oben gesetzten Wert.
create or replace function public.log_project_credit_event()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.credit_events (organization_id, delta, reason, project_id)
    values (new.organization_id, -1, 'project_created', new.id);
  return new;
end;
$$;

drop trigger if exists trg_projects_assign_org_and_enforce_quota on public.projects;
create trigger trg_projects_assign_org_and_enforce_quota before insert on public.projects
  for each row execute function public.assign_org_and_enforce_quota();

drop trigger if exists trg_projects_log_credit_event on public.projects;
create trigger trg_projects_log_credit_event after insert on public.projects
  for each row execute function public.log_project_credit_event();

-- ═══════════════════════════════════════════════════════════════════════════
-- Rate-Limit für ask-ai (Kosten-Kontrolle, aus dem Sicherheitsaudit vom 2026-09-21)
-- ═══════════════════════════════════════════════════════════════════════════

-- Jeder ask-ai-Aufruf kostet echtes Anthropic-API-Guthaben auf Stefans Konto, ohne
-- Deckel könnte ein Bug im Client oder absichtlicher Missbrauch unkontrolliert Kosten
-- verursachen (siehe Audit, A04). Append-only, gleiches Prinzip wie credit_events -
-- bewusst KEIN Reset-Zähler mit Cronjob, stattdessen zählt die Edge Function einfach die
-- Zeilen der letzten 24h (rollierendes Fenster) vor jedem Aufruf.
create table public.ai_analysis_events (
  id               bigint generated always as identity primary key,
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  created_at       timestamptz not null default now()
);
create index ai_analysis_events_org_created_idx on public.ai_analysis_events (organization_id, created_at desc);
alter table public.ai_analysis_events enable row level security;

-- Nur select für authenticated (z.B. für eine künftige "12/20 heute genutzt"-Anzeige) -
-- geschrieben wird ausschließlich von der Edge Function über den Service-Role-Client,
-- genau wie bei credit_events.
create policy ai_analysis_events_select_own_org
  on public.ai_analysis_events for select to authenticated
  using (organization_id = public.current_org_id());

-- ═══════════════════════════════════════════════════════════════════════════
-- Stripe-Anbindung — Phase 2 (Einmalkauf)
-- ═══════════════════════════════════════════════════════════════════════════

-- Atomares Increment für den stripe-webhook (service-role, umgeht RLS ohnehin) — kein
-- Read-Modify-Write in JS, damit zwei fast gleichzeitige Webhook-Zustellungen für dieselbe
-- Org sich nicht gegenseitig überschreiben statt zu addieren.
create or replace function public.increment_one_time_credits(p_org_id uuid, p_delta int)
returns void language sql as $$
  update public.organizations set one_time_credits = one_time_credits + p_delta, updated_at = now() where id = p_org_id;
$$;
