-- Buffy Reader schema (PostgreSQL 13+)
-- Apply with: bun run db:migrate   (or paste into your provider's SQL editor)

create table if not exists users (
  id           bigserial primary key,
  username     text not null unique,
  created_at   timestamptz not null default now(),
  last_login_at timestamptz
);

create table if not exists feeds (
  id             bigserial primary key,
  url            text not null unique,
  site_url       text,
  title          text,
  description    text,
  icon_url       text,
  etag           text,
  last_modified  text,
  last_fetch_at  timestamptz,
  next_fetch_at  timestamptz not null default now(),
  last_status    integer,
  error_count    integer not null default 0,
  last_error     text,
  created_at     timestamptz not null default now()
);
create index if not exists feeds_due_idx on feeds (next_fetch_at);

create table if not exists subscriptions (
  id         bigserial primary key,
  user_id    bigint not null references users(id) on delete cascade,
  feed_id    bigint not null references feeds(id) on delete cascade,
  title      text,
  folder     text,
  created_at timestamptz not null default now(),
  unique (user_id, feed_id)
);
create index if not exists subscriptions_user_idx on subscriptions (user_id, folder);

create table if not exists entries (
  id             bigserial primary key,
  feed_id        bigint not null references feeds(id) on delete cascade,
  guid           text not null,
  item_id        text not null unique,
  url            text,
  title          text,
  author         text,
  summary        text,
  content        text,
  enclosure_url  text,
  enclosure_type text,
  published_at   timestamptz not null default now(),
  fetched_at     timestamptz not null default now(),
  unique (feed_id, guid)
);
create index if not exists entries_feed_pub_idx on entries (feed_id, published_at desc, id desc);
create index if not exists entries_pub_idx on entries (published_at desc, id desc);

-- Keep lightweight identities after article cleanup so repeat fetches cannot
-- resurrect deleted articles as unread. Identities expire only with the feed.
create table if not exists entry_seen (
  feed_id bigint not null references feeds(id) on delete cascade,
  guid    text not null,
  primary key (feed_id, guid)
);
insert into entry_seen (feed_id, guid)
  select feed_id, guid from entries
  on conflict (feed_id, guid) do nothing;

create table if not exists entry_states (
  user_id    bigint not null references users(id) on delete cascade,
  entry_id   bigint not null references entries(id) on delete cascade,
  read       boolean not null default false,
  starred    boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, entry_id)
);
create index if not exists entry_states_unread_idx on entry_states (user_id) where read = false;
create index if not exists entry_states_starred_idx on entry_states (user_id) where starred;
