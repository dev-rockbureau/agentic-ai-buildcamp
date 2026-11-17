// The gateway: the only way out. Only its Postgres role may write to the outbox.
//
// A reply goes out only when a qualified reviewer signed it and the signature still covers the
// exact text being sent and the current version of every cited source. The checks and the insert
// run in one serializable transaction, so a source withdrawn at the same moment can't slip
// through. The unique key on (question_id, kind) makes a second send write nothing.
import { record } from "./audit";
import { type Client, firstRow, inTransaction, SERIALIZATION_FAILURE } from "./database";
import { currentVersion, type Stored, whyNotAllowed } from "./knowledge";
import { loadPolicy, type Policy } from "./policy";
import { medicalView, type Requester } from "./profile";
import { signatureHash, sourceKey } from "./signature";

const ATTEMPTS = 3;
const REQUESTER = "select requester_id from medical.questions where id = $1";
const ITEM = "select id, citations from review.items where question_id = $1";
const SIGNED = `select final_text, signature_hash, signed_sources from review.decisions
  where item_id = $1 and action in ('approve', 'edit') order by id desc limit 1`;
const INSERT = `insert into outbox.messages
  (id, question_id, kind, recipient_id, text, signature_hash)
  values ($1, $2, $3, $4, $5, $6) on conflict do nothing`;

// The only text that may go out without a signature: a pre-approved acknowledgment.
const ACKNOWLEDGMENT =
  "Thank you for your question ({question_id}). A {queue} reviewer has it. " +
  "We aim to reply by {due}.";
// The rep redirect: a rep asked about a use that isn't approved. The rep gets no medical answer.
const REP_REDIRECT =
  "Thank you for passing this on ({question_id}). Questions about uses that are not approved " +
  "can only be answered for the healthcare professional who asks. Please ask them to contact " +
  "Medical Information directly.";

export type Sent = { sent: boolean; reason?: string };
type Citation = { doc_id: string; version: number };
type Signed = { final_text: string; signature_hash: string | null; signed_sources: string[] };
type Message = {
  id: string;
  questionId: string;
  kind: string;
  text: string;
  signature: string | null;
};

const fill = (template: string, values: Record<string, string>) =>
  template.replace(/\{(\w+)\}/g, (_, name: string) => values[name]);

// The recipient is always the person who asked, read here, never passed in.
async function requesterOf(client: Client, questionId: string): Promise<Requester> {
  const row = await firstRow<{ requester_id: string }>(client, REQUESTER, [questionId]);
  return medicalView(client, row?.requester_id ?? "");
}

// Write the message and its audit entry. A repeat hits the unique key and writes neither.
async function insertOnce(client: Client, message: Message): Promise<void> {
  const recipient = await requesterOf(client, message.questionId);
  const values = [message.id, message.questionId, message.kind, recipient.id, message.text];
  const inserted = await client.query(INSERT, [...values, message.signature]);
  if (inserted.rowCount !== 1) return;
  const entry = { message_id: message.id, kind: message.kind, signature_hash: message.signature };
  await record(client, message.questionId, "message_sent", entry);
}

export async function sendAcknowledgment(questionId: string, queue: string, dueAt: string | null) {
  const due = dueAt ? `${dueAt.slice(0, 16).replace("T", " ")} UTC` : "the end of the review";
  const values = { question_id: questionId, queue: queue.replaceAll("_", " "), due };
  const text = fill(ACKNOWLEDGMENT, values);
  const message = {
    id: `A-${questionId}`,
    questionId,
    kind: "acknowledgment",
    text,
    signature: null,
  };
  await inTransaction("gateway", (client) => insertOnce(client, message));
  return { sent: true };
}

// A fixed template, so it needs no signature. It goes to the rep who asked.
export async function sendRepRedirect(questionId: string): Promise<Sent> {
  const text = fill(REP_REDIRECT, { question_id: questionId });
  const message = { id: `M-${questionId}`, questionId, kind: "rep_reply", text, signature: null };
  await inTransaction("gateway", (client) => insertOnce(client, message));
  return { sent: true };
}

async function currentSources(client: Client, citations: Citation[]) {
  const cited = [...new Set(citations.map((citation) => `${citation.doc_id}@${citation.version}`))];
  const versions = cited.sort().map((key) => key.split("@"));
  return Promise.all(
    versions.map(([docId, version]) => currentVersion(client, docId, Number(version))),
  );
}

// Why this signed reply must not go out now, or undefined when it may.
function refusal(
  signed: Signed,
  current: (Stored | undefined)[],
  requester: Requester,
  policy: Policy,
) {
  if (current.some((document) => !document)) return "source_missing";
  const documents = current as Stored[];
  const keys = documents.map((doc) => sourceKey(doc.doc_id, doc.version, doc.content_hash));
  if (signatureHash(signed.final_text, keys) !== signed.signature_hash) {
    const asSigned = signatureHash(signed.final_text, signed.signed_sources);
    return asSigned === signed.signature_hash ? "source_changed" : "text_changed";
  }
  const problems = documents.map((document) => whyNotAllowed(document, requester, policy));
  const problem = problems.find(Boolean);
  return problem ? `source_not_allowed: ${problem}` : undefined;
}

async function checkedSend(client: Client, questionId: string, policy: Policy): Promise<Sent> {
  const requester = await requesterOf(client, questionId);
  const item = await firstRow<{ id: string; citations: Citation[] }>(client, ITEM, [questionId]);
  const signed = item ? await firstRow<Signed>(client, SIGNED, [item.id]) : undefined;
  let reason: string | undefined = "unsigned";
  if (item && signed?.signature_hash) {
    reason = refusal(signed, await currentSources(client, item.citations), requester, policy);
  }
  if (reason) {
    // The refusal is recorded in the same transaction as the checks that made it.
    await record(client, questionId, "send_refused", { reason });
    return { sent: false, reason };
  }
  const text = (signed as Signed).final_text;
  const signature = (signed as Signed).signature_hash;
  await insertOnce(client, { id: `M-${questionId}`, questionId, kind: "reply", text, signature });
  return { sent: true };
}

// Send the signed reply for one question, or refuse and say why.
export async function sendReply(questionId: string): Promise<Sent> {
  const policy = loadPolicy();
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await inTransaction(
        "gateway",
        (client) => checkedSend(client, questionId, policy),
        true,
      );
    } catch (error) {
      // A withdrawal committed at the same moment. Try again, and see it this time.
      const lostRace = (error as { code?: string }).code === SERIALIZATION_FAILURE;
      if (!lostRace || attempt === ATTEMPTS) throw error;
    }
  }
}
