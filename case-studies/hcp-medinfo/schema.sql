-- The HCP medical information pipeline's database. `bun run hcp seed` runs this file on every seed,
-- so it starts by dropping everything it owns. Each schema stands in for a zone or a layer of the
-- production design, and each module logs in as its own role. The grants at the end are the
-- firewall: a module can only touch what its role is granted, whatever its code tries.

set client_min_messages = warning;

drop schema if exists shared, medical, safety, knowledge, review, outbox, audit, langgraph cascade;

-- Roles are cluster-wide, so they survive a reseed. Create each one only if it is missing.
do $$
declare
  role_name text;
begin
  foreach role_name in array array['graph', 'safety_scan', 'gateway', 'reviewer_cli', 'checker']
  loop
    if not exists (select 1 from pg_roles where rolname = role_name) then
      execute format('create role %I login', role_name);
    end if;
  end loop;
end
$$;

-- Nobody but the owner may create objects in public. Each role gets only the schemas it needs.
revoke create on schema public from public;

create schema shared;
create schema medical;
create schema safety;
create schema knowledge;
create schema review;
create schema outbox;
create schema audit;
create schema langgraph;

-- Shared zone: who the doctors and reps are. No content about what they asked.
create table shared.doctors (
  id text primary key,
  name text not null,
  email text not null unique,
  country text,
  language text not null,
  verified boolean not null,
  kind text not null check (kind in ('doctor', 'rep'))
);

-- Medical zone: the questions, and markers saying a safety report was forwarded.
create table medical.questions (
  id text primary key,
  requester_id text not null references shared.doctors (id),
  channel text not null,
  received_at timestamptz not null,
  text text not null,
  status text not null default 'new'
);

-- Safety zone: packets with the reporter's exact words. Only the safety scan and PV may read it.
-- The question id is the idempotency key: a retried scan hits the unique key and writes nothing.
create table safety.packets (
  id text primary key,
  question_id text not null unique references medical.questions (id),
  verbatim_text text not null,
  received_at timestamptz not null,
  matched_terms text[] not null,
  created_at timestamptz not null default now()
);

create table medical.safety_markers (
  question_id text primary key references medical.questions (id),
  packet_id text not null references safety.packets (id),
  forwarded_at timestamptz not null default now()
);

-- Knowledge layer: every version of every approved document, and its sections for search.
create table knowledge.documents (
  doc_id text not null,
  version integer not null,
  kind text not null check (kind in ('prescribing_information', 'srd')),
  title text not null,
  product text not null,
  status text not null check (status in ('approved', 'withdrawn', 'superseded')),
  countries text[] not null,
  approved_use text not null check (approved_use in ('prescribing_information', 'srd')),
  language text not null,
  effective_date date not null,
  expiry_date date not null,
  approval_ref text not null,
  content_hash text not null,
  body text not null,
  primary key (doc_id, version)
);

create table knowledge.chunks (
  chunk_id text primary key,
  doc_id text not null,
  version integer not null,
  section text not null,
  start_char integer not null,
  end_char integer not null,
  text text not null,
  -- The heading weighs more than the body, so "Storage" ranks a storage section above a passing word.
  tsv tsvector generated always as (
    setweight(to_tsvector('english', section), 'A') || setweight(to_tsvector('english', text), 'B')
  ) stored,
  foreign key (doc_id, version) references knowledge.documents (doc_id, version)
);

create index chunks_tsv on knowledge.chunks using gin (tsv);

-- Review: who may review, what waits for them, and what they decided and signed.
create table review.reviewers (
  id text primary key,
  name text not null,
  role text not null check (role in ('specialist', 'senior_reviewer', 'writer', 'data_steward')),
  countries text[] not null,
  pin_hash text not null
);

-- One item per question, with id RV-<question id>. The review node may run again on resume, so it
-- inserts with on conflict do nothing.
create table review.items (
  id text primary key,
  thread_id text not null,
  question_id text not null references medical.questions (id),
  queue text not null,
  draft jsonb,
  citations jsonb not null default '[]',
  verifier jsonb,
  reasons text[] not null default '{}',
  status text not null default 'waiting',
  due_at timestamptz,
  created_at timestamptz not null default now()
);

create table review.decisions (
  id bigserial primary key,
  item_id text not null references review.items (id),
  reviewer_id text not null references review.reviewers (id),
  action text not null check (action in ('approve', 'edit', 'send_back', 'reject', 'escalate')),
  reason_code text,
  final_text text,
  diff text,
  meaning text,
  override_reasons jsonb,
  -- What the signature covers besides the text: doc_id@version@content_hash of each cited source.
  signed_sources text[],
  signature_hash text,
  signed_at timestamptz not null default now()
);

-- Outbound gateway: one row per message sent. The unique key makes a second send write nothing.
create table outbox.messages (
  id text primary key,
  question_id text not null references medical.questions (id),
  kind text not null check (kind in ('acknowledgment', 'reply', 'rep_reply')),
  recipient_id text not null references shared.doctors (id),
  text text not null,
  signature_hash text,
  sent_at timestamptz not null default now(),
  -- Postgres fills this in, so the check can prove only the gateway role ever wrote a message.
  written_by text not null default current_user,
  unique (question_id, kind)
);

-- Audit: an append-only chain per question. Each entry holds the hash of the one before it.
create table audit.entries (
  id bigserial primary key,
  question_id text not null,
  seq integer not null,
  type text not null,
  payload jsonb not null,
  prev_hash text not null,
  hash text not null,
  created_at timestamptz not null default now(),
  unique (question_id, seq)
);

create function audit.refuse_change() returns trigger language plpgsql as $$
begin
  raise exception 'audit entries can only be added, never changed or removed';
end
$$;

create trigger entries_append_only
  before update or delete on audit.entries
  for each row execute function audit.refuse_change();

create trigger entries_no_truncate
  before truncate on audit.entries
  for each statement execute function audit.refuse_change();

-- The firewall. Each grant below is one thing a module is allowed to do.

-- graph: the Medical Question Helper. It reads the medical view and the approved library, writes
-- review items and audit entries, and keeps its checkpoints. It can't read safety packets or send.
grant usage on schema shared, medical, knowledge, review, audit to graph;
grant select on shared.doctors, medical.questions, medical.safety_markers to graph;
grant update (status) on medical.questions to graph;
grant select on knowledge.documents, knowledge.chunks to graph;
grant select on review.reviewers, review.decisions to graph;
grant select, insert, update on review.items to graph;
grant usage, create on schema langgraph to graph;

-- safety_scan: reads questions, writes packets and the medical marker. Nothing else.
grant usage on schema medical, safety, audit to safety_scan;
grant select on medical.questions to safety_scan;
grant select, insert on safety.packets to safety_scan;
grant insert on medical.safety_markers to safety_scan;

-- gateway: the only role that can write to the outbox.
grant usage on schema shared, medical, knowledge, review, outbox, audit to gateway;
grant select on shared.doctors, medical.questions to gateway;
grant select on knowledge.documents to gateway;
grant select on review.items, review.decisions to gateway;
grant select, insert on outbox.messages to gateway;

-- reviewer_cli: reads what waits for review and records decisions. It can't send.
grant usage on schema shared, medical, knowledge, review, audit to reviewer_cli;
grant select on shared.doctors, medical.questions to reviewer_cli;
grant select on knowledge.documents, knowledge.chunks to reviewer_cli;
grant select on review.reviewers, review.items to reviewer_cli;
grant select, insert on review.decisions to reviewer_cli;
grant usage on sequence review.decisions_id_seq to reviewer_cli;

-- Every module that does work adds audit entries and reads its chain to find the last hash.
grant select, insert on audit.entries to graph, safety_scan, gateway, reviewer_cli;
grant usage on sequence audit.entries_id_seq to graph, safety_scan, gateway, reviewer_cli;

-- checker: the check reads everything and writes nothing.
grant pg_read_all_data to checker;
