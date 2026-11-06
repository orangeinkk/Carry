-- Carry schema. Run once in the Supabase SQL editor.
-- Also enable: Authentication > Providers > Anonymous sign-ins.
create table users (id uuid primary key references auth.users on delete cascade, display_name text not null, created_at timestamptz default now());
create table events (id uuid primary key default gen_random_uuid(), title text not null, starts_at timestamptz, place text, invite_code text unique not null, created_by uuid references users(id), created_at timestamptz default now());
create table event_members (event_id uuid references events on delete cascade, user_id uuid references users on delete cascade, joined_at timestamptz default now(), primary key (event_id, user_id));
create table tasks (id uuid primary key default gen_random_uuid(), event_id uuid not null references events on delete cascade, title text not null,
  effort_size text not null default 'medium' check (effort_size in ('small','medium','big')),
  status text not null default 'open' check (status in ('open','in_progress','done')),
  created_by uuid references users(id), created_at timestamptz default now());
create table task_assignees (task_id uuid references tasks on delete cascade, user_id uuid references users on delete cascade, primary key (task_id, user_id));
create table effort_ratings (task_id uuid references tasks on delete cascade, user_id uuid references users on delete cascade,
  rating text not null check (rating in ('less','expected','more')), created_at timestamptz default now(), primary key (task_id, user_id));
create table task_flags (id uuid primary key default gen_random_uuid(), task_id uuid references tasks on delete cascade, user_id uuid references users on delete cascade,
  action text not null check (action in ('ask_for_hand','split','just_flag')), asked_user_id uuid references users, note text,
  response text check (response in ('yes','no')), created_at timestamptz default now());
create table interaction_events (id bigint generated always as identity primary key, user_id uuid, event_name text not null, screen text, payload jsonb default '{}', created_at timestamptz default now());

create function is_member(eid uuid) returns boolean language sql security definer stable set search_path = public as
$$ select exists (select 1 from event_members where event_id = eid and user_id = auth.uid()) $$;
create function task_event(tid uuid) returns uuid language sql security definer stable set search_path = public as
$$ select event_id from tasks where id = tid $$;

alter table users enable row level security; alter table events enable row level security; alter table event_members enable row level security;
alter table tasks enable row level security; alter table task_assignees enable row level security; alter table effort_ratings enable row level security;
alter table task_flags enable row level security; alter table interaction_events enable row level security;

create policy users_read on users for select using (id = auth.uid() or exists (select 1 from event_members a join event_members b on a.event_id = b.event_id where a.user_id = auth.uid() and b.user_id = users.id));
create policy events_read on events for select using (is_member(id));
create policy members_read on event_members for select using (is_member(event_id));
create policy tasks_all on tasks for all using (is_member(event_id)) with check (is_member(event_id));
create policy assignees_all on task_assignees for all using (is_member(task_event(task_id))) with check (is_member(task_event(task_id)));
create policy ratings_read on effort_ratings for select using (is_member(task_event(task_id)));
create policy ratings_write on effort_ratings for insert with check (user_id = auth.uid() and is_member(task_event(task_id)));
create policy ratings_update on effort_ratings for update using (user_id = auth.uid());
-- Private asks: only sender and the person asked can read.
create policy flags_read on task_flags for select using (user_id = auth.uid() or asked_user_id = auth.uid());
create policy flags_write on task_flags for insert with check (user_id = auth.uid() and is_member(task_event(task_id)));
create policy flags_respond on task_flags for update using (asked_user_id = auth.uid());
-- Study log: write-only from the app; read it in the Supabase dashboard.
create policy log_write on interaction_events for insert with check (user_id = auth.uid());

create function create_event(p_name text, p_title text, p_place text, p_starts_at timestamptz) returns events
language plpgsql security definer set search_path = public as $$
declare e events; begin
  insert into users (id, display_name) values (auth.uid(), p_name) on conflict (id) do update set display_name = excluded.display_name;
  insert into events (title, place, starts_at, invite_code, created_by)
    values (p_title, p_place, p_starts_at, upper(substr(md5(random()::text || clock_timestamp()::text), 1, 8)), auth.uid()) returning * into e;
  insert into event_members (event_id, user_id) values (e.id, auth.uid());
  return e; end $$;

create function join_event(p_code text, p_name text) returns events
language plpgsql security definer set search_path = public as $$
declare e events; begin
  insert into users (id, display_name) values (auth.uid(), p_name) on conflict (id) do update set display_name = excluded.display_name;
  select * into e from events where invite_code = upper(trim(p_code));
  if not found then raise exception 'No event has that code'; end if;
  insert into event_members (event_id, user_id) values (e.id, auth.uid()) on conflict do nothing;
  return e; end $$;

alter publication supabase_realtime add table tasks, task_assignees;
