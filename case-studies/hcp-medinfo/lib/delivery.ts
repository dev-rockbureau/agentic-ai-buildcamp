// The delivery rule: a reply leaves only through the gateway, signed by a qualified reviewer, and
// only while the signature still covers the exact text and the exact cited sources.
// The check acts as the reviewer. It plants the T11 and T14 changes as the database owner, and it
// kills the T13 run while that run waits for review.
import {
  type Citation,
  checkerQuery,
  decide,
  decisionCount,
  type Item,
  line,
  messageCount,
  qualifiedReviewer,
  readItem,
} from "./checking";
import { type DatabaseClient, withRole } from "./database";
import type { Line } from "./firewall";
import { readExpectations } from "./retrieval";
import { runSolution, startSolution } from "./solution";
import { sha256 } from "./world";

const WAIT_MS = 120_000;

// Q-001: the wrong reviewer and the wrong PIN are refused, then the right reviewer signs and it
// is sent once.
async function baseline(): Promise<Line[]> {
  runSolution(["ask", "Q-001"]);
  const item = await readItem("Q-001");
  if (!item) return [line("Q-001 (baseline) reaches review", false, "no review item")];
  const right = qualifiedReviewer(item);
  const otherCountry = qualifiedReviewer(item, false);
  if (!right || !otherCountry) throw new Error("reviewers.json lacks a reviewer for Q-001");
  // Each attempt is counted on its own, so one missing check fails only its own line.
  const wrongPin = decide("approve", item.id, { id: right.id, pin: "0000" });
  const afterPin = await decisionCount(item.id);
  const wrongCountry = decide("approve", item.id, otherCountry);
  const afterCountry = await decisionCount(item.id);
  decide("approve", item.id, right);
  const sent = (await readItem("Q-001"))?.status === "sent";
  const replies = await messageCount("Q-001", "reply");
  return [
    line("a wrong PIN can't sign", wrongPin.status !== 0 && afterPin === 0),
    line(
      "a reviewer for another country can't sign",
      wrongCountry.status !== 0 && afterCountry === afterPin,
    ),
    line("Q-001 (baseline) is signed by a qualified reviewer and sent once", sent && replies === 1),
  ];
}

type Tamper = (client: DatabaseClient, item: Item) => Promise<string | undefined>;

// Sign without sending, change something as the database owner, then resume in a new process.
// That is the state a process killed right after signing leaves behind.
async function refusedAfterSigning(questionId: string, expected: string, tamper: Tamper) {
  runSolution(["ask", questionId]);
  const item = await readItem(questionId);
  const reviewer = item && qualifiedReviewer(item);
  if (!item || !reviewer) return `${questionId} never reached a reviewer`;
  const signed = decide("sign", item.id, reviewer);
  if (signed.status !== 0) return `signing failed: ${signed.stderr.trim()}`;
  const notPlanted = await withRole("postgres", (client) => tamper(client, item));
  if (notPlanted) return notPlanted;
  runSolution(["resume", questionId]);
  const after = await readItem(questionId);
  const replies = await messageCount(questionId, "reply");
  if (replies !== 0) return `${replies} reply sent`;
  if (after?.status !== "send_refused") return `item status is ${after?.status}`;
  if (!after.reasons.includes(expected)) return `refused for ${after.reasons.join(", ")}`;
  return undefined;
}

const changeText: Tamper = async (client, item) => {
  const sql = `update review.decisions set final_text = final_text || ' Take it twice a day.'
    where item_id = $1 and action = 'approve'`;
  await client.query(sql, [item.id]);
  return undefined;
};

function changeSource(documentKey: string): Tamper {
  return async (client, item) => {
    const [docId, version] = documentKey.split("@");
    const cited = item.citations.some(
      (citation) => citation.doc_id === docId && citation.version === Number(version),
    );
    if (!cited) return `the draft doesn't cite ${documentKey}, so T14 can't be planted`;
    const sql = `update knowledge.documents set body = body || E'\\n',
      content_hash = encode(sha256(convert_to(body || E'\\n', 'UTF8')), 'hex')
      where doc_id = $1 and version = $2`;
    await client.query(sql, [docId, Number(version)]);
    return undefined;
  };
}

// Read the program's output until it prints `needle`, exits, or time runs out.
async function outputUntil(program: ReturnType<typeof startSolution>, needle: string) {
  let text = "";
  const reader = program.stdout.getReader();
  const timer = setTimeout(() => program.kill("SIGKILL"), WAIT_MS);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
    if (text.includes(needle)) break;
  }
  clearTimeout(timer);
  reader.releaseLock();
  return text;
}

// T13: kill the run while it waits, resume it from a new process, then resume once more.
async function killedWhilePaused(): Promise<string | undefined> {
  const first = startSolution(["ask", "Q-015"]);
  const paused = (await outputUntil(first, "Waiting for review")).includes("Waiting for review");
  first.kill("SIGKILL");
  await first.exited;
  if (!paused) return "Q-015 never paused for review";
  const sql = "select count(*)::int as n from langgraph.checkpoints where thread_id = 'Q-015'";
  if ((await checkerQuery<{ n: number }>(sql))[0].n === 0) return "no checkpoint was written";
  const item = await readItem("Q-015");
  const reviewer = item && qualifiedReviewer(item);
  if (!item || !reviewer) return "Q-015 has no review item";
  const resumed = decide("approve", item.id, reviewer).stdout;
  if (resumed.includes("node load_context")) return "the resume started the question over";
  runSolution(["resume", "Q-015"]);
  const replies = await messageCount("Q-015", "reply");
  const acknowledgments = await messageCount("Q-015", "acknowledgment");
  if (replies !== 1 || acknowledgments !== 1) {
    return `${replies} replies and ${acknowledgments} acknowledgments, expected one of each`;
  }
  return undefined;
}

type Reply = { question_id: string; text: string; signature_hash: string; signed_ok: boolean };

const REPLIES = `select m.question_id, m.text, m.signature_hash, i.citations,
  (d.signature_hash = m.signature_hash and d.signed_at <= m.sent_at) as signed_ok
  from outbox.messages m join review.items i on i.question_id = m.question_id
  left join lateral (select signature_hash, signed_at from review.decisions
    where item_id = i.id and action in ('approve', 'edit')
    order by id desc limit 1) d on true
  where m.kind = 'reply'`;
const VERSIONS = "select doc_id, version, content_hash from knowledge.documents";

// Recompute every sent reply's hash from the sent text and the cited sources as they are now.
async function unsignedReplies(): Promise<string[]> {
  const replies = await checkerQuery<Reply & { citations: Citation[] }>(REPLIES);
  const versions = await checkerQuery<Citation>(VERSIONS);
  const hashOf = new Map(versions.map((row) => [`${row.doc_id}@${row.version}`, row.content_hash]));
  return replies
    .filter((reply) => {
      const cited = new Set(
        reply.citations.map((citation) => `${citation.doc_id}@${citation.version}`),
      );
      const keys = [...cited].map((key) => `${key}@${hashOf.get(key)}`).sort();
      const recomputed = sha256(`${reply.text}\n${keys.join("\n")}`);
      return !reply.signed_ok || recomputed !== reply.signature_hash;
    })
    .map((reply) => reply.question_id);
}

async function outboxLines(): Promise<Line[]> {
  const writers = await checkerQuery<{ written_by: string }>(
    "select distinct written_by from outbox.messages",
  );
  const onlyGateway = writers.length > 0 && writers.every((row) => row.written_by === "gateway");
  const bad = await unsignedReplies();
  const says = "every reply was signed before it was sent, and its hash recomputes from the sent";
  return [
    line("only the gateway role wrote outbox rows", onlyGateway, JSON.stringify(writers)),
    line(`${says} text and the cited sources`, bad.length === 0, bad.join(", ")),
  ];
}

// The refusal a trap expects: "refused_text_changed" in traps.json means "text_changed".
function expectedRefusal(questionId: string): string {
  return (readExpectations()[questionId].outcome ?? "").replace("refused_", "");
}

export async function checkDelivery(): Promise<Line[]> {
  const baselineLines = await baseline();
  const textChanged = await refusedAfterSigning("Q-012", expectedRefusal("Q-012"), changeText);
  const planted = changeSource(readExpectations()["Q-014"].change_after_signing ?? "");
  const sourceChanged = await refusedAfterSigning("Q-014", expectedRefusal("Q-014"), planted);
  const resumed = await killedWhilePaused();
  return [
    ...baselineLines,
    line("Q-012 (trap T11): text changed after signing is refused", !textChanged, textChanged),
    line(
      "Q-014 (trap T14): a cited source changed after signing is refused",
      !sourceChanged,
      sourceChanged,
    ),
    line("Q-015 (trap T13): killed while paused, resumed, sent once", !resumed, resumed),
    ...(await outboxLines()),
  ];
}
