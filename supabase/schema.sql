-- The Fishery, v2 (all-day play). Run this whole file once in the Supabase SQL Editor.
--
-- Players can only: read the game state / past round totals, and submit ONE choice per round
-- through submit_choice(). They cannot read anyone's individual choice.
-- You (in the Supabase dashboard) can read everything and run resolve_round() to close a round.

-- ---------- Tables ----------

create table if not exists public.game_state (
  id            int primary key default 1 check (id = 1),
  start_fish    int not null default 20,
  replenish     int not null default 5,
  total_rounds  int not null default 15,
  current_round int not null default 1,
  fish_pool     int not null default 20,
  status        text not null default 'open' check (status in ('open', 'won', 'lost'))
);
insert into public.game_state default values on conflict (id) do nothing;

create table if not exists public.choices (
  id          bigint generated always as identity primary key,
  round       int not null,
  player_name text not null,
  player_key  text not null,
  choice      int not null check (choice in (0, 1)),
  received    int,
  created_at  timestamptz not null default now(),
  unique (round, player_key)
);

create table if not exists public.rounds (
  round       int primary key,
  pool_before int not null,
  requested   int not null,
  caught      int not null,
  pool_after  int not null,
  collapse    boolean not null,
  resolved_at timestamptz not null default now()
);

-- ---------- Access rules ----------

alter table public.game_state enable row level security;
alter table public.choices    enable row level security;
alter table public.rounds     enable row level security;

drop policy if exists "read game state" on public.game_state;
create policy "read game state" on public.game_state for select to anon, authenticated using (true);

drop policy if exists "read rounds" on public.rounds;
create policy "read rounds" on public.rounds for select to anon, authenticated using (true);

revoke all on public.game_state, public.choices, public.rounds from anon, authenticated;
grant select on public.game_state, public.rounds to anon, authenticated;

-- ---------- Player functions ----------

create or replace function public.submit_choice(p_name text, p_choice int)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  g game_state%rowtype;
  v_name text := btrim(coalesce(p_name, ''));
  n int;
begin
  if length(v_name) = 0 or length(v_name) > 40 then
    raise exception 'invalid_name';
  end if;
  if p_choice is null or p_choice not in (0, 1) then
    raise exception 'invalid_choice';
  end if;

  select * into g from game_state where id = 1 for share;
  if g.status <> 'open' then
    raise exception 'game_over';
  end if;

  insert into choices (round, player_name, player_key, choice)
  values (g.current_round, v_name, lower(v_name), p_choice)
  on conflict (round, player_key) do nothing;
  get diagnostics n = row_count;
  if n = 0 then
    raise exception 'already_submitted';
  end if;
end;
$$;

create or replace function public.has_submitted(p_name text)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from choices c
    join game_state g on g.id = 1
    where c.round = g.current_round
      and c.player_key = lower(btrim(coalesce(p_name, '')))
  );
$$;

grant execute on function public.submit_choice(text, int) to anon, authenticated;
grant execute on function public.has_submitted(text) to anon, authenticated;

-- ---------- Instructor functions (NOT callable by players) ----------

-- Closes the current round: hands out fish, updates the pool, moves to the next round (or ends the game).
create or replace function public.resolve_round()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  g game_state%rowtype;
  v_requested int;
  v_caught int;
  v_pool_after int;
  v_collapse boolean;
  v_status text;
begin
  select * into g from game_state where id = 1 for update;
  if g.status <> 'open' then
    raise exception 'Game is already over (%).', g.status;
  end if;

  select count(*) into v_requested from choices where round = g.current_round and choice = 1;
  v_caught := least(v_requested, g.fish_pool);

  update choices set received = 0 where round = g.current_round;
  -- If more people asked than there are fish, a random subset gets one.
  update choices set received = 1
  where id in (
    select id from choices
    where round = g.current_round and choice = 1
    order by random()
    limit v_caught
  );

  v_collapse := (g.fish_pool - v_caught) <= 0;
  v_pool_after := case when v_collapse then 0 else g.fish_pool - v_caught + g.replenish end;
  v_status := case
    when v_collapse then 'lost'
    when g.current_round >= g.total_rounds then 'won'
    else 'open'
  end;

  insert into rounds (round, pool_before, requested, caught, pool_after, collapse)
  values (g.current_round, g.fish_pool, v_requested, v_caught, v_pool_after, v_collapse);

  update game_state
  set fish_pool = v_pool_after,
      status = v_status,
      current_round = case when v_status = 'open' then g.current_round + 1 else g.current_round end
  where id = 1;

  return format('Round %s: %s asked, %s caught, pool %s -> %s. Status: %s.',
                g.current_round, v_requested, v_caught, g.fish_pool, v_pool_after, v_status);
end;
$$;

-- Wipes all choices and results and starts over using the settings in game_state.
create or replace function public.reset_game()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from choices where true;
  delete from rounds where true;
  update game_state
  set current_round = 1, fish_pool = start_fish, status = 'open'
  where id = 1;
end;
$$;

revoke all on function public.resolve_round() from public, anon, authenticated;
revoke all on function public.reset_game() from public, anon, authenticated;

-- ---------- Handy views for you (hidden from players) ----------

-- Who has chosen what so far in the open round.
create or replace view public.current_round_choices as
select c.player_name,
       case c.choice when 1 then 'take a fish' else 'take none' end as choice,
       c.created_at
from public.choices c
join public.game_state g on g.id = 1 and c.round = g.current_round
order by c.created_at;

-- Running totals per player. extra_credit counts only if the group won.
create or replace view public.extra_credit as
select min(c.player_name) as player_name,
       coalesce(sum(c.received), 0)::int as fish_caught,
       case when (select status from public.game_state where id = 1) = 'won'
            then coalesce(sum(c.received), 0)::int else 0 end as extra_credit
from public.choices c
group by c.player_key
order by fish_caught desc, player_name;

revoke all on public.current_round_choices, public.extra_credit from public, anon, authenticated;
