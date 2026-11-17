// The verification rule. A draft whose words the sources don't back is flagged (T9), and nobody
// can sign it without a reason for each flag. A reviewer's edit is checked again (T15). A source
// withdrawn while the draft waits invalidates it, and the redraft doesn't cite it (T12).
// The check also redoes the number check itself on every signed reply, from the signed sentences
// and the sections they cite, so a solution that skips its own verifier can't pass.
import {
  checkerQuery,
  decide,
  decisionCount,
  type Item,
  line,
  messageCount,
  qualifiedReviewer,
  readItem,
} from "./checking";
import { withRole } from "./database";
import type { Line } from "./firewall";
import { type Expected, readExpectations } from "./retrieval";
import { runSolution } from "./solution";

type Flag = { sentence: number; reasons: string[] };
type Sentence = { text: string; cites: string[] };
type Signed = {
  question_id: string;
  final_text: string;
  final_sentences: Sentence[] | null;
  override_reasons: Record<string, string> | null;
};
type Edit = { sentence: number; from: string; to: string };

const VERIFIER = "select verifier, draft from review.items where question_id = $1";
// Each sent reply, with the signed decision whose hash it carries.
const SENT = `select m.question_id, m.text as final_text, d.final_sentences, d.override_reasons
  from outbox.messages m join review.items i on i.question_id = m.question_id
  join review.decisions d on d.item_id = i.id and d.signature_hash = m.signature_hash
  where m.kind = 'reply'`;
const CHUNKS = "select chunk_id, text from knowledge.chunks";
const LATEST_SIGNED = `select d.action, d.override_reasons, d.diff, d.signed_sources
  from review.decisions d join review.items i on i.id = d.item_id
  where i.question_id = $1 and d.action in ('approve', 'edit') order by d.id desc limit 1`;
const OVERRIDE = "checked by the reviewer against the label";

// The same pattern as the solution's verifier: a number with an optional unit.
const UNITS = "%|mg/kg|mg|mL/min|mL|g/kg|g|kg|hours?|days?|weeks?|months?|years?";
const NUMBER = new RegExp(`\\d+(?:\\.\\d+)?(?:\\s*(?:${UNITS})(?![A-Za-z]))?`, "g");

const normalized = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

function missingNumbers(sentence: string, source: string): string[] {
  const words = normalized(source);
  const literal = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const present = (number: string) =>
    new RegExp(`(?<![\\d.])${literal(number)}(?!\\d)`).test(words);
  return (sentence.match(NUMBER) ?? []).map(normalized).filter((number) => !present(number));
}

function trapQuestion(trap: string): [string, Expected] {
  const found = Object.entries(readExpectations()).find(([, expected]) => expected.trap === trap);
  if (!found) throw new Error(`traps.json has no question for ${trap}`);
  return found;
}

function signer(item: Item) {
  const reviewer = qualifiedReviewer(item);
  if (!reviewer) throw new Error(`reviewers.json has nobody for ${item.queue} in ${item.country}`);
  return reviewer;
}

async function latestSigned(questionId: string) {
  type Row = { override_reasons: Record<string, string> | null; diff: string | null };
  const rows = await checkerQuery<Row & { action: string; signed_sources: string[] }>(
    LATEST_SIGNED,
    [questionId],
  );
  return rows[0];
}

// T9: the planted number is flagged, signing is refused without a reason, and allowed with one.
async function flaggedDraft(questionId: string): Promise<string | undefined> {
  runSolution(["ask", questionId]);
  const [row] = await checkerQuery<{ verifier: { flags: Flag[] } | null }>(VERIFIER, [questionId]);
  const flags = row?.verifier?.flags ?? [];
  if (!flags.some((flag) => flag.reasons.some((reason) => reason.includes("is not in a cited")))) {
    return "the verifier didn't flag a number missing from the source";
  }
  const item = (await readItem(questionId)) as Item;
  const refused = decide("approve", item.id, signer(item));
  if (refused.status === 0 || (await decisionCount(item.id)) !== 0) {
    return "it was signed with no override reason";
  }
  const overrides = flags.flatMap((flag) => ["--override", `${flag.sentence}:${OVERRIDE}`]);
  decide("approve", item.id, signer(item), overrides);
  const signed = await latestSigned(questionId);
  if (!signed?.override_reasons) return "the override reasons weren't recorded";
  return (await messageCount(questionId, "reply")) === 1 ? undefined : "it wasn't sent";
}

// T15: the reviewer's edit is checked again, refused without a reason, signed with one.
async function editedDraft(questionId: string, edit: Edit): Promise<string | undefined> {
  runSolution(["ask", questionId]);
  const item = (await readItem(questionId)) as Item;
  const [row] = await checkerQuery<{ draft: Sentence[] }>(VERIFIER, [questionId]);
  const words = row.draft[edit.sentence - 1]?.text ?? "";
  if (!words.includes(edit.from)) return `sentence ${edit.sentence} doesn't say "${edit.from}"`;
  const change = ["--edit", `${edit.sentence}:${words.replace(edit.from, edit.to)}`];
  const refused = decide("edit", item.id, signer(item), change);
  if (refused.status === 0) return "the edit was signed with no override reason";
  const override = ["--override", `${edit.sentence}:${OVERRIDE}`];
  decide("edit", item.id, signer(item), [...change, ...override]);
  const signed = await latestSigned(questionId);
  if (signed?.action !== "edit" || !signed.diff) return "no edit with its diff was recorded";
  if (!signed.override_reasons?.[String(edit.sentence)]) return "the override wasn't recorded";
  return (await messageCount(questionId, "reply")) === 1 ? undefined : "it wasn't sent";
}

async function withdraw(documentKey: string): Promise<void> {
  const [docId, version] = documentKey.split("@");
  const sql = `update knowledge.documents set status = 'withdrawn'
    where doc_id = $1 and version = $2`;
  await withRole("postgres", (client) => client.query(sql, [docId, Number(version)]));
}

const cites = (item: Item, documentKey: string) =>
  item.citations.some((citation) => `${citation.doc_id}@${citation.version}` === documentKey);

// T12: a cited source is withdrawn while the draft waits. Signing invalidates the draft, the
// redraft doesn't cite it, and the reply goes out without it.
async function withdrawnWhileWaiting(questionId: string, expected: Expected) {
  const documentKey = expected.withdraw_while_waiting ?? "";
  runSolution(["ask", questionId]);
  const before = (await readItem(questionId)) as Item;
  if (!cites(before, documentKey)) return `the draft doesn't cite ${documentKey}`;
  await withdraw(documentKey);
  if (decide("approve", before.id, signer(before)).status === 0) return "the old draft was signed";
  const after = (await readItem(questionId)) as Item;
  if (cites(after, documentKey)) return `the redraft still cites ${documentKey}`;
  if (after.queue !== expected.queue_after_redraft) return `the redraft went to ${after.queue}`;
  decide("approve", after.id, signer(after));
  const signed = await latestSigned(questionId);
  if (signed?.signed_sources.some((key) => key.startsWith(`${documentKey}@`))) {
    return `the signature covers ${documentKey}`;
  }
  return (await messageCount(questionId, "reply")) === 1 ? undefined : "it wasn't sent";
}

// Every sent reply: its words are the signed sentences, and every number its cited sections
// don't contain has an override reason.
async function unexplainedNumbers(): Promise<string[]> {
  const chunks = await checkerQuery<{ chunk_id: string; text: string }>(CHUNKS);
  const textOf = new Map(chunks.map((chunk) => [chunk.chunk_id, chunk.text]));
  const problems: string[] = [];
  for (const signed of await checkerQuery<Signed>(SENT)) {
    const sentences = signed.final_sentences ?? [];
    const joined = sentences.map((sentence) => sentence.text).join(" ");
    if (joined !== signed.final_text) {
      problems.push(`${signed.question_id}: the sent words aren't the signed sentences`);
    }
    sentences.forEach((sentence, index) => {
      const source = sentence.cites.map((chunk) => textOf.get(chunk) ?? "").join("\n");
      const missing = missingNumbers(sentence.text, source);
      if (missing.length > 0 && !signed.override_reasons?.[String(index + 1)]) {
        problems.push(`${signed.question_id} sentence ${index + 1}: ${missing.join(", ")}`);
      }
    });
  }
  return problems;
}

export async function checkVerification(): Promise<Line[]> {
  const [flaggedId] = trapQuestion("T9");
  const [withdrawnId, withdrawnExpected] = trapQuestion("T12");
  const [editedId, editedExpected] = trapQuestion("T15");
  const flagged = await flaggedDraft(flaggedId);
  const withdrawn = await withdrawnWhileWaiting(withdrawnId, withdrawnExpected);
  if (!editedExpected.reviewer_edit) throw new Error(`traps.json gives ${editedId} no edit`);
  const edited = await editedDraft(editedId, editedExpected.reviewer_edit);
  const unexplained = await unexplainedNumbers();
  return [
    line(
      `${flaggedId} (trap T9): the wrong dose is flagged, and signed only with a reason`,
      !flagged,
      flagged,
    ),
    line(
      `${withdrawnId} (trap T12): a withdrawn source invalidates the draft`,
      !withdrawn,
      withdrawn,
    ),
    line(
      `${editedId} (trap T15): an edit is checked again, and signed only with a reason`,
      !edited,
      edited,
    ),
    line(
      "every sent reply is the signed sentences, and each number is sourced or overridden",
      unexplained.length === 0,
      unexplained.join("; "),
    ),
  ];
}
