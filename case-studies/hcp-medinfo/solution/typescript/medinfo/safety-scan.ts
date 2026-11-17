// The safety scan: a fixed step that runs before the graph, as its own role.
//
// A question that contains one of policy.yaml's safety_terms, at the start of a word, gets exactly
// one safety packet. The packet keeps the reporter's exact words, and its Day 0 is when the
// question was received. The packet, the medical zone's marker and the audit entry commit together.
// The question id is the idempotency key, so running the scan again writes nothing.
//
// Rules only: a keyword list misses unlisted words and indirect descriptions (trap T16). It is not
// suitable for real safety intake.
import { record } from "./audit";
import { type Client, firstRow, inTransaction } from "./database";
import { loadPolicy } from "./policy";

const LOCK = "select pg_advisory_xact_lock(hashtext($1))";
const QUESTION = "select text, received_at from medical.questions where id = $1";
const SCANNED = "select 1 from audit.entries where question_id = $1 and type = 'safety_scan'";
const PACKET_OF = "select id from safety.packets where question_id = $1";
const INSERT_PACKET = `insert into safety.packets
  (id, question_id, verbatim_text, received_at, matched_terms) values ($1, $2, $3, $4, $5)
  on conflict (question_id) do nothing`;
const INSERT_MARKER = "insert into medical.safety_markers (question_id, packet_id) values ($1, $2)";

export type Scan = { packetId: string | null; alreadyScanned: boolean };

const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The configured terms the text contains, each at the start of a word ("pregnan" matches
// "pregnant", "rash" doesn't match "crash").
export function matchedTerms(text: string, terms: string[]): string[] {
  return terms.filter((term) => new RegExp(`\\b${literal(term)}`, "i").test(text));
}

async function scanOnce(client: Client, questionId: string, terms: string[]): Promise<Scan> {
  const question = await firstRow<{ text: string; received_at: Date }>(client, QUESTION, [
    questionId,
  ]);
  if (!question) throw new Error(`No question with id ${questionId}`);
  const matched = matchedTerms(question.text, terms);
  const packetId = matched.length > 0 ? `SP-${questionId}` : null;
  if (packetId) {
    const values = [packetId, questionId, question.text, question.received_at, matched];
    await client.query(INSERT_PACKET, values);
    await client.query(INSERT_MARKER, [questionId, packetId]);
  }
  await record(client, questionId, "safety_scan", { packet_id: packetId });
  return { packetId, alreadyScanned: false };
}

export function scan(questionId: string): Promise<Scan> {
  const terms = loadPolicy().safety_terms;
  return inTransaction("safety_scan", async (client) => {
    // Two scans of one question take turns, so the second always sees the first's work.
    await client.query(LOCK, [questionId]);
    if (await firstRow(client, SCANNED, [questionId])) {
      const packet = await firstRow<{ id: string }>(client, PACKET_OF, [questionId]);
      return { packetId: packet?.id ?? null, alreadyScanned: true };
    }
    return scanOnce(client, questionId, terms);
  });
}
