-- Run in the existing project's Supabase SQL Editor. No supplier data is replaced.
-- If your existing table is public."user", replace public.users below and set
-- SUPABASE_USERS_TABLE=user. Its id must match the Supabase Auth user UUID.
begin;

create table if not exists public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  email_verified boolean not null default false,
  first_name text,
  last_name text,
  password_hash text,
  role text not null default 'user',
  store_admin boolean not null default false,
  is_active boolean not null default true,
  disabled boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.users add column if not exists role text not null default 'user';
alter table public.users add column if not exists store_admin boolean not null default false;
alter table public.users add column if not exists is_active boolean not null default true;
alter table public.users add column if not exists disabled boolean not null default false;

create table if not exists public.product (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null check (length(name) between 1 and 200),
  price numeric(14,2) not null check (price >= 0 and price <= 100000000),
  category text not null,
  description text not null default '',
  brand text not null default '',
  availability text not null default '',
  variants jsonb not null default '[]'::jsonb,
  specs jsonb not null default '[]'::jsonb,
  images jsonb not null default '[]'::jsonb,
  published boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (jsonb_typeof(images) = 'array' and jsonb_array_length(images) <= 10),
  check (jsonb_typeof(variants) = 'array'),
  check (jsonb_typeof(specs) = 'array')
);
create index if not exists product_public_created_idx on public.product(published, created_at, id);

create table if not exists public.analytic (
  id uuid primary key,
  session_id uuid not null,
  path text not null,
  referrer text not null default '',
  ip inet,
  country text not null default '',
  region text not null default '',
  city text not null default '',
  location_accuracy text not null default 'Unavailable',
  device text not null default '',
  device_model text not null default '',
  browser text not null default '',
  browser_version text not null default '',
  os text not null default '',
  os_version text not null default '',
  user_agent text not null default '',
  language text not null default '',
  timezone text not null default '',
  screen text not null default '',
  notes text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists analytic_created_idx on public.analytic(created_at desc, id);

-- Dedicated product/analytic tables are only accessed by this backend.
alter table public.product enable row level security;
alter table public.analytic enable row level security;
revoke all on public.product, public.analytic from anon, authenticated;
grant all on public.product, public.analytic to service_role;

-- Preserve existing user policies and block client-side privilege escalation.
alter table public.users enable row level security;
create or replace function public.store_protect_admin_role() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'INSERT' then
      if new.store_admin or new.disabled then raise exception 'Store administrator fields are server managed'; end if;
    elsif new.store_admin is distinct from old.store_admin or new.disabled is distinct from old.disabled
      or (old.store_admin and new.id is distinct from old.id) then
      raise exception 'Administrator fields are server managed';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists store_protect_admin_role on public.users;
create trigger store_protect_admin_role before insert or update on public.users
  for each row execute function public.store_protect_admin_role();
grant all on public.users to service_role;

-- Existing bucket and objects are retained. Public reads require no login.
insert into storage.buckets (id, name, public)
values ('product', 'product', true)
on conflict (id) do update set public = true;

-- The backend writes with the service role. Other buckets keep their policies.
-- Protect the admin/ prefix against existing broad storage policies.
drop policy if exists store_product_protect_admin_objects on storage.objects;
create policy store_product_protect_admin_objects on storage.objects as restrictive
  for all to anon, authenticated
  using (bucket_id <> 'product' or name not like 'admin/%')
  with check (bucket_id <> 'product' or name not like 'admin/%');

commit;
