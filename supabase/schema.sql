-- TransitON 귀가안심 (Home Safe) — Supabase schema
-- Supabase SQL Editor에서 실행 후 Dashboard → Database → Replication 에서
-- safe_tracking, group_members 테이블 Realtime 활성화

create extension if not exists "pgcrypto";

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  name text not null default '나',
  invite_code text not null unique,
  share_consent boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists friends (
  user_id uuid not null references users(id) on delete cascade,
  friend_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, friend_id),
  check (user_id <> friend_id)
);

create table if not exists groups (
  id uuid primary key default gen_random_uuid(),
  group_name text not null,
  invite_code text not null unique,
  owner_id uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists group_members (
  group_id uuid not null references groups(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);

create table if not exists safe_tracking (
  user_id uuid primary key references users(id) on delete cascade,
  group_id uuid references groups(id) on delete set null,
  lat double precision,
  lng double precision,
  eta text,
  eta_minutes integer,
  status text not null default 'idle'
    check (status in ('walking', 'bus', 'subway', 'waiting', 'home', 'idle')),
  destination text,
  dest_lat double precision,
  dest_lng double precision,
  is_active boolean not null default false,
  updated_at timestamptz not null default now()
);

create index if not exists idx_friends_user on friends(user_id);
create index if not exists idx_group_members_group on group_members(group_id);
create index if not exists idx_group_members_user on group_members(user_id);
create index if not exists idx_safe_tracking_group on safe_tracking(group_id);
create index if not exists idx_users_invite on users(invite_code);
create index if not exists idx_groups_invite on groups(invite_code);

alter table users enable row level security;
alter table friends enable row level security;
alter table groups enable row level security;
alter table group_members enable row level security;
alter table safe_tracking enable row level security;

-- MVP: anon key + RLS open (프로덕션에서는 Supabase Auth 연동 권장)
-- 정책은 재실행 시 충돌하지 않도록 drop 후 create
drop policy if exists "users_all" on users;
drop policy if exists "friends_all" on friends;
drop policy if exists "groups_all" on groups;
drop policy if exists "group_members_all" on group_members;
drop policy if exists "safe_tracking_all" on safe_tracking;

create policy "users_all" on users for all using (true) with check (true);
create policy "friends_all" on friends for all using (true) with check (true);
create policy "groups_all" on groups for all using (true) with check (true);
create policy "group_members_all" on group_members for all using (true) with check (true);
create policy "safe_tracking_all" on safe_tracking for all using (true) with check (true);

alter table safe_tracking replica identity full;

-- anon/authenticated 역할에 테이블 접근 권한 (없으면 "permission denied for table users")
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on users to anon, authenticated;
grant select, insert, update, delete on friends to anon, authenticated;
grant select, insert, update, delete on groups to anon, authenticated;
grant select, insert, update, delete on group_members to anon, authenticated;
grant select, insert, update, delete on safe_tracking to anon, authenticated;
