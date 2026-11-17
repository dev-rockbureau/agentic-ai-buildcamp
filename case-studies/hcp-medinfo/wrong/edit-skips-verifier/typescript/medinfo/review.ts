// The reviewer CLI's side: show what waits, and record a signed decision. It runs as the
// reviewer_cli role, which can record decisions but can't send anything. The data steward's two
// actions run as steward_cli, the only role that may set a doctor's country.
//
// The PIN is checked here and never enters the graph's state, so it is never written to a
// checkpoint. The graph is resumed with the decision's id only.
//
// Signing covers the exact final words. An edit is verified again before it can be signed, and
// every flag on the final words, from the draft or from the edit, needs an override reason.
import { timingSafeEqual } from "node:crypto";
import { record } from "./audit";
import { type Client, firstRow, inTransaction } from "./database";
import { currentVersion, whyNotAllowed } from "./knowledge";
import { loadPolicy } from "./policy";
import { medicalView, type Requester } from "./profile";
import { draftText, MEANING, pinHash, type Sentence, signatureHash, sourceKey } from "./signature";
import { type Verification, verify } from "./verifier";

const ITEM = `select i.id, i.question_id, i.queue, i.draft, i.citations, i.verifier, i.reasons,
  i.status, i.due_at, q.requester_id, q.text as question
  from review.items i join medical.questions q on q.id = i.question_id where i.id = $1`;
const WAITING = `select id, queue, due_at from review.items where status = 'waiting'
  order by due_at nulls last, id`;
const REVIEWER = "select id, role, countries, pin_hash from review.reviewers where id = $1";
const DECIDED = `select 1 from review.decisions
  where item_id = $1 and action in ('approve', 'edit', 'reject', 'close')`;
const SET_COUNTRY = "update shared.doctors set country = $1 where id = $2 and country is null";
const LATEST = "select id from review.decisions where item_id = $1 order by id desc limit 1";
const CHUNKS = "select chunk_id, text from knowledge.chunks where chunk_id = any($1)";
const FIELDS = [
  "reason_code",
  "final_text",
  "diff",
  "meaning",
  "override_reasons",
  "final_sentences",
  "verification",
  "signed_sources",
  "signature_hash",
];
const JSON_FIELDS = new Set(["override_reasons", "final_sentences", "verification"]);
const placeholders = FIELDS.map(
  (field, index) => `$${index + 4}${JSON_FIELDS.has(field) ? "::jsonb" : ""}`,
);
const INSERT = `insert into review.decisions (item_id, reviewer_id, action, ${FIELDS.join(", ")})
  values ($1, $2, $3, ${placeholders.join(", ")}) returning id`;

// A decision this reviewer may not record. Nothing was written.
export class RefusedError extends Error {}

// A cited source was withdrawn or changed before signing. Nothing was signed. An invalidate
// decision was recorded, so the question is searched again and redrafted.
export class InvalidatedError extends Error {}

export type Signer = { reviewerId: string; pin: string };
// Sentence edits (sentence number to new words) and override reasons for flags.
export type Signing = { edits: Map<number, string>; overrides: Map<number, string> };

type Citation = { chunk_id: string; doc_id: string; version: number; content_hash: string };
type Item = {
  id: string;
  question_id: string;
  queue: string;
  draft: Sentence[] | null;
  citations: Citation[];
  verifier: Verification | null;
  reasons: string[];
  status: string;
  due_at: Date | null;
  requester_id: string;
  question: string;
};
type Decision = Record<string, unknown> & { reviewer_id: string; action: string };

async function openItem(client: Client, itemId: string): Promise<Item> {
  const item = await firstRow<Item>(client, ITEM, [itemId]);
  if (!item) throw new RefusedError(`No review item ${itemId}.`);
  if (item.status !== "waiting" || (await firstRow(client, DECIDED, [itemId]))) {
    throw new RefusedError(`${itemId} has already been decided.`);
  }
  return item;
}

const samePin = (stored: string, given: string) =>
  stored.length === given.length && timingSafeEqual(Buffer.from(stored), Buffer.from(given));

// Only a reviewer with the queue's role, for the requester's country, with the right PIN.
async function checkReviewer(client: Client, item: Item, signer: Signer): Promise<void> {
  type Reviewer = { role: string; countries: string[]; pin_hash: string };
  const reviewer = await firstRow<Reviewer>(client, REVIEWER, [signer.reviewerId]);
  if (!reviewer || !samePin(reviewer.pin_hash, pinHash(signer.reviewerId, signer.pin))) {
    throw new RefusedError("Unknown reviewer or wrong PIN.");
  }
  const needed = loadPolicy().queues[item.queue].role;
  if (reviewer.role !== needed) {
    throw new RefusedError(
      `The ${item.queue} queue needs a ${needed}. ${signer.reviewerId} isn't.`,
    );
  }
  const country = (await medicalView(client, item.requester_id)).country;
  if (needed !== "data_steward" && !reviewer.countries.includes(country ?? "")) {
    throw new RefusedError(`${signer.reviewerId} doesn't review for ${country}.`);
  }
}

// The item, once the reviewer is allowed to decide it. Identity items are the data steward's,
// through the steward_cli role. Every other queue is a reviewer's.
async function open(client: Client, itemId: string, signer: Signer, stewardTool: boolean) {
  const item = await openItem(client, itemId);
  await checkReviewer(client, item, signer);
  if ((item.queue === "identity_resolution") !== stewardTool) {
    const tool = stewardTool ? "approve or reject" : "review set-country or review close";
    throw new RefusedError(`${itemId} is in the ${item.queue} queue. Use ${tool}.`);
  }
  return item;
}

// Record the decision and its audit entry in one transaction. Returns the decision's id.
async function decide(client: Client, item: Item, decision: Decision): Promise<number> {
  const value = (field: string) => {
    const given = decision[field] ?? null;
    return JSON_FIELDS.has(field) && given !== null ? JSON.stringify(given) : given;
  };
  const values = [item.id, decision.reviewer_id, decision.action, ...FIELDS.map(value)];
  const row = (await client.query(INSERT, values)).rows[0] as { id: number };
  const entry: Record<string, unknown> = {
    reviewer_id: decision.reviewer_id,
    action: decision.action,
    reason_code: decision.reason_code ?? null,
    decision_id: row.id,
    signature_hash: decision.signature_hash ?? null,
  };
  if (decision.override_reasons) entry.override_reasons = decision.override_reasons;
  await record(client, item.question_id, "decision", entry);
  return row.id;
}

// Why a cited version can't be signed now, or undefined when every one still can.
async function sourceProblem(client: Client, item: Item, requester: Requester) {
  const policy = loadPolicy();
  for (const citation of item.citations) {
    const document = await currentVersion(client, citation.doc_id, citation.version);
    const key = `${citation.doc_id}@${citation.version}`;
    if (!document) return `${key} is missing`;
    const problem = whyNotAllowed(document, requester, policy);
    if (problem) return problem;
    if (document.content_hash !== citation.content_hash)
      return `${key} changed after the draft was written`;
  }
  return undefined;
}

function signedSources(item: Item): string[] {
  const keys = item.citations.map((citation) =>
    sourceKey(citation.doc_id, citation.version, citation.content_hash),
  );
  return [...new Set(keys)].sort();
}

function finalSentences(item: Item, edits: Map<number, string>): Sentence[] {
  const sentences = (item.draft ?? []).map((sentence) => ({ ...sentence }));
  for (const [number, words] of edits) {
    if (number < 1 || number > sentences.length) {
      throw new RefusedError(`The draft has no sentence ${number}.`);
    }
    sentences[number - 1].text = words;
  }
  return sentences;
}

// The draft's own verification when nothing was edited. An edit is verified again, on the exact
// words that will be signed.
async function verification(client: Client, item: Item, sentences: Sentence[]) {
  // The draft was verified already, so the edit needs no second look.
  if (item.verifier) return item.verifier;
  const cited = [...new Set(sentences.flatMap((sentence) => sentence.cites))].sort();
  const rows = (await client.query(CHUNKS, [cited])).rows as { chunk_id: string; text: string }[];
  const passages = new Map(rows.map((row) => [row.chunk_id, row.text]));
  return verify(item.question_id, "verify_edit", sentences, passages);
}

// Every flag needs a reason. Returns the reasons for the flagged sentences.
function requireOverrides(
  checked: { flags: Verification["flags"] },
  overrides: Map<number, string>,
) {
  const missing = checked.flags.filter((flag) => !overrides.get(flag.sentence)?.trim());
  if (missing.length > 0) {
    const lines = missing.map((flag) => `  sentence ${flag.sentence}: ${flag.reasons.join("; ")}`);
    const hint = "Give a reason for each with --override <sentence>:<reason>.";
    throw new RefusedError(`Can't sign while these are flagged:\n${lines.join("\n")}\n${hint}`);
  }
  return Object.fromEntries(
    checked.flags.map((flag) => [String(flag.sentence), overrides.get(flag.sentence)]),
  );
}

function difference(item: Item, sentences: Sentence[]): string | null {
  const before = (item.draft ?? []).map((sentence) => sentence.text);
  const changed = sentences.filter((sentence, index) => sentence.text !== before[index]);
  if (changed.length === 0) return null;
  const lines = sentences.flatMap((sentence, index) =>
    sentence.text === before[index] ? [] : [`-${before[index]}`, `+${sentence.text}`],
  );
  return ["--- draft", "+++ signed", ...lines].join("\n");
}

// The decision to record: the exact sentences, their verification, the overrides and the hash
// over the final words and the cited versions.
async function signature(client: Client, item: Item, signer: Signer, signing: Signing) {
  const sentences = finalSentences(item, signing.edits);
  const checked = await verification(client, item, sentences);
  const overrides = requireOverrides(checked, signing.overrides);
  const text = draftText(sentences);
  const sources = signedSources(item);
  return {
    reviewer_id: signer.reviewerId,
    action: signing.edits.size > 0 ? "edit" : "approve",
    final_text: text,
    diff: difference(item, sentences),
    meaning: MEANING,
    override_reasons: Object.keys(overrides).length > 0 ? overrides : null,
    final_sentences: sentences,
    verification: checked,
    signed_sources: sources,
    signature_hash: signatureHash(text, sources),
  };
}

// Approve the draft, or edit and sign it. Returns the decision's id. If a cited source was
// withdrawn or changed, nothing is signed: the draft is invalidated and redone.
export async function sign(itemId: string, signer: Signer, signing: Signing): Promise<number> {
  const outcome = await inTransaction("reviewer_cli", async (client) => {
    const item = await open(client, itemId, signer, false);
    if (!item.draft?.length) throw new RefusedError(`${itemId} has no draft to sign.`);
    const requester = await medicalView(client, item.requester_id);
    const gone = await sourceProblem(client, item, requester);
    if (gone) return { gone };
    return {
      decisionId: await decide(client, item, await signature(client, item, signer, signing)),
    };
  });
  if ("decisionId" in outcome) return outcome.decisionId as number;
  await inTransaction("reviewer_cli", async (client) => {
    const item = await open(client, itemId, signer, false);
    const invalidated = {
      reviewer_id: signer.reviewerId,
      action: "invalidate",
      reason_code: outcome.gone,
    };
    await decide(client, item, invalidated);
  });
  throw new InvalidatedError(
    `Not signed: ${outcome.gone}. The draft was invalidated and will be redone.`,
  );
}

function simpleDecision(role: string, action: string, reasonCode: string) {
  return (itemId: string, signer: Signer) =>
    inTransaction(role, async (client) => {
      const item = await open(client, itemId, signer, role === "steward_cli");
      return decide(client, item, {
        reviewer_id: signer.reviewerId,
        action,
        reason_code: reasonCode,
      });
    });
}

export function reject(itemId: string, signer: Signer, reason: string): Promise<number> {
  return simpleDecision("reviewer_cli", "reject", reason)(itemId, signer);
}

// The data steward closes the question. No medical answer is sent. Its safety packet stays.
export function close(itemId: string, signer: Signer, reason: string): Promise<number> {
  return simpleDecision("steward_cli", "close", reason)(itemId, signer);
}

// The data steward sets an unknown country. The question then runs again from the start.
export function setCountry(itemId: string, signer: Signer, country: string): Promise<number> {
  if (!loadPolicy().countries.includes(country)) {
    throw new RefusedError(`${country} is not one of the countries in policy.yaml.`);
  }
  return inTransaction("steward_cli", async (client) => {
    const item = await open(client, itemId, signer, true);
    if ((await client.query(SET_COUNTRY, [country, item.requester_id])).rowCount !== 1) {
      throw new RefusedError(`${item.requester_id} already has a country.`);
    }
    return decide(client, item, {
      reviewer_id: signer.reviewerId,
      action: "set_country",
      reason_code: country,
    });
  });
}

export function latestDecision(itemId: string): Promise<number | null> {
  return inTransaction("reviewer_cli", async (client) => {
    const row = await firstRow<{ id: number }>(client, LATEST, [itemId]);
    return row ? Number(row.id) : null;
  });
}

export function waiting() {
  return inTransaction("reviewer_cli", async (client) => {
    return (await client.query(WAITING)).rows as {
      id: string;
      queue: string;
      due_at: Date | null;
    }[];
  });
}

const dueText = (due: Date | null) => due?.toISOString() ?? "None";

export async function show(itemId: string): Promise<string> {
  const item = await inTransaction("reviewer_cli", (client) =>
    firstRow<Item>(client, ITEM, [itemId]),
  );
  if (!item) throw new RefusedError(`No review item ${itemId}.`);
  const lines = [
    `${item.id}  queue ${item.queue}  status ${item.status}  due ${dueText(item.due_at)}`,
    `Question ${item.question_id}: ${item.question}`,
    `Why this queue: ${item.reasons.join(", ") || "none"}`,
    item.draft ? "Draft:" : "No draft. A writer must answer from scratch.",
  ];
  (item.draft ?? []).forEach((sentence, index) => {
    lines.push(`  ${index + 1}. ${sentence.text}  [${sentence.cites.join(", ")}]`);
  });
  for (const flag of item.verifier?.flags ?? []) {
    lines.push(`  FLAG sentence ${flag.sentence}: ${flag.reasons.join("; ")}`);
  }
  return lines.join("\n");
}
