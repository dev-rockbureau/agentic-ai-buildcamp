// The identity rule (trap T7). A question from someone whose country is unknown waits for a data
// steward: no search, no acknowledgment, and its safety packet is still written. Only a data
// steward may finish it. The check closes it, as traps.json expects.
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
import type { Line } from "./firewall";
import { type Expected, readExpectations } from "./retrieval";
import { runSolution } from "./solution";
import { readReviewers } from "./world";

const FIRST_SEARCH = `select payload->>'status' as status,
  jsonb_array_length(payload->'sources')::int as sources
  from audit.entries where question_id = $1 and type = 'retrieve' order by seq limit 1`;
const PACKETS = "select count(*)::int as n from safety.packets where question_id = $1";
const CLOSE_REASON = ["--reason", "requester could not be verified as a healthcare professional"];

type Search = { status: string; sources: number };

function trapQuestion(trap: string): [string, Expected] {
  const found = Object.entries(readExpectations()).find(([, expected]) => expected.trap === trap);
  if (!found) throw new Error(`traps.json has no question for ${trap}`);
  return found;
}

async function waitsForSteward(questionId: string, item: Item, expected: Expected) {
  if (item.queue !== expected.queue) return `its queue is ${item.queue}`;
  const [search] = await checkerQuery<Search>(FIRST_SEARCH, [questionId]);
  if (search?.status !== "country_unknown" || search.sources !== 0) {
    return `it was searched (status ${search?.status})`;
  }
  const sent = await messageCount(questionId, null);
  return sent === 0 ? undefined : `${sent} messages were sent`;
}

// Anyone who isn't a data steward, with their own correct PIN.
async function othersRefused(item: Item): Promise<boolean> {
  const other = readReviewers().find((reviewer) => reviewer.role === "senior_reviewer");
  if (!other) throw new Error("reviewers.json has no senior reviewer");
  const attempt = decide("close", item.id, other, CLOSE_REASON);
  return attempt.status !== 0 && (await decisionCount(item.id)) === 0;
}

async function closedBySteward(questionId: string, item: Item, expected: Expected) {
  const steward = qualifiedReviewer(item);
  if (!steward) throw new Error("reviewers.json has no data steward");
  const closing = decide("close", item.id, steward, CLOSE_REASON);
  if (closing.status !== 0) return `closing failed: ${closing.stderr.trim()}`;
  const after = await readItem(questionId);
  if (after?.status !== expected.outcome) return `its item is ${after?.status}`;
  const sent = await messageCount(questionId, null);
  if (sent !== 0) return `${sent} messages were sent`;
  const packets = (await checkerQuery<{ n: number }>(PACKETS, [questionId]))[0].n;
  return packets === 1 ? undefined : `${packets} safety packets after closing`;
}

export async function checkIdentity(): Promise<Line[]> {
  const [questionId, expected] = trapQuestion("T7");
  runSolution(["ask", questionId]);
  const item = await readItem(questionId);
  const label = `${questionId} (trap T7)`;
  if (!item) return [line(`${label} reaches a review queue`, false, "no review item")];
  const waiting = await waitsForSteward(questionId, item, expected);
  const refused = await othersRefused(item);
  const closed = await closedBySteward(questionId, item, expected);
  return [
    line(`${label} waits for a data steward, unsearched and unacknowledged`, !waiting, waiting),
    line("a reviewer who isn't a data steward can't finish an identity item", refused),
    line(
      `${label} is closed by the data steward, nothing is sent, the packet stays`,
      !closed,
      closed,
    ),
  ];
}
