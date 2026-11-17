// The audit rule: every question has a chain, no chain is broken, every step left its entry, and
// each chain ends in a final state that matches its review item. The check recomputes every hash
// from what it reads back, the same way audit.append() made it:
// sha256(previous hash + type + payload as Postgres prints it).
import { checkerQuery, line } from "./checking";
import type { Line } from "./firewall";
import { readQuestions, sha256 } from "./world";

type Entry = {
  question_id: string;
  seq: number;
  type: string;
  payload_text: string;
  prev_hash: string;
  hash: string;
};

const ENTRIES = `select question_id, seq, type, payload::text as payload_text, prev_hash, hash
  from audit.entries order by question_id, seq`;
const ITEMS = "select question_id, status from review.items";
// Every message and every decision must have its own entry in the chain.
const UNRECORDED = `select question_id, 'message ' || id as what from outbox.messages m
  where not exists (select 1 from audit.entries a where a.question_id = m.question_id
    and a.type = 'message_sent' and a.payload->>'message_id' = m.id)
  union all
  select i.question_id, 'decision ' || d.id from review.decisions d
  join review.items i on i.id = d.item_id
  where not exists (select 1 from audit.entries a where a.question_id = i.question_id
    and a.type = 'decision' and (a.payload->>'decision_id')::bigint = d.id)`;
// The steps every question goes through before it waits for review, in this order.
const STEPS = ["load_context", "retrieve", "draft", "route", "review_queued"];
const START = "0".repeat(64);

// The entry a chain may end with, and the item statuses each one goes with.
const FINAL_STATES: Record<string, string[]> = {
  review_queued: ["waiting"],
  send: ["sent", "send_refused"],
  close: ["rejected", "closed"],
};

function chainBreak(entries: Entry[]): string | undefined {
  let previous = START;
  for (const [index, entry] of entries.entries()) {
    if (entry.seq !== index + 1) return `entry ${index + 1} is missing`;
    if (entry.prev_hash !== previous) return `entry ${entry.seq} doesn't point to the one before`;
    const recomputed = sha256(entry.prev_hash + entry.type + entry.payload_text);
    if (recomputed !== entry.hash) return `entry ${entry.seq} doesn't match its hash`;
    previous = entry.hash;
  }
  return undefined;
}

// The safety scan comes first, before any graph step, then each step appears in order.
function missingStep(entries: Entry[]): string | undefined {
  if (entries[0].type !== "safety_scan") return `starts with ${entries[0].type}, not safety_scan`;
  let from = 0;
  for (const step of STEPS) {
    const found = entries.findIndex((entry, index) => index >= from && entry.type === step);
    if (found === -1) return `no ${step} entry`;
    from = found + 1;
  }
  return undefined;
}

function endProblem(entries: Entry[], status: string | undefined): string | undefined {
  const last = entries[entries.length - 1].type;
  const statuses = FINAL_STATES[last];
  if (!statuses) return `ends with ${last}`;
  if (!status || !statuses.includes(status)) return `ends with ${last}, but its item is ${status}`;
  return undefined;
}

type Problems = { broken: string[]; missing: string[]; unfinished: string[] };

const SAYS: Record<keyof Problems, string> = {
  broken: "every question has an audit chain, and none is broken",
  missing: "every chain starts with the safety scan and records every step",
  unfinished: "every chain ends in a final state that matches its review item",
};

const KEYS = Object.keys(SAYS) as (keyof Problems)[];

// One question's problems, at most one of each kind.
function chainProblems(entries: Entry[] | undefined, status: string | undefined) {
  if (!entries) return { broken: "no chain" } as Record<keyof Problems, string | undefined>;
  return {
    broken: chainBreak(entries),
    missing: missingStep(entries),
    unfinished: endProblem(entries, status),
  };
}

async function readChains(): Promise<Map<string, Entry[]>> {
  const chains = new Map<string, Entry[]>();
  for (const entry of await checkerQuery<Entry>(ENTRIES)) {
    chains.set(entry.question_id, [...(chains.get(entry.question_id) ?? []), entry]);
  }
  return chains;
}

async function findProblems(): Promise<Problems> {
  const chains = await readChains();
  const items = await checkerQuery<{ question_id: string; status: string }>(ITEMS);
  const statusOf = new Map(items.map((item) => [item.question_id, item.status]));
  const found: Problems = { broken: [], missing: [], unfinished: [] };
  for (const { id } of readQuestions()) {
    const problems = chainProblems(chains.get(id), statusOf.get(id));
    for (const key of KEYS) {
      if (problems[key]) found[key].push(`${id}: ${problems[key]}`);
    }
  }
  const unrecorded = await checkerQuery<{ question_id: string; what: string }>(UNRECORDED);
  found.missing.push(...unrecorded.map((row) => `${row.question_id}: no entry for ${row.what}`));
  return found;
}

export async function checkAudit(): Promise<Line[]> {
  const found = await findProblems();
  return KEYS.map((key) => line(SAYS[key], found[key].length === 0, found[key].join("; ")));
}
