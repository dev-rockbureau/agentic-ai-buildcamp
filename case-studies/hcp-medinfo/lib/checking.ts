// What the check's rules share: reading the database as the checker role, acting as a reviewer
// through the solution's own CLI, and writing a line.
import { withRole } from "./database";
import type { Line } from "./firewall";
import { runSolution } from "./solution";
import { readPolicy, readReviewers } from "./world";

export type Citation = { doc_id: string; version: number; content_hash: string };
export type Item = {
  id: string;
  queue: string;
  status: string;
  reasons: string[];
  citations: Citation[];
  country: string | null;
};
type Signer = { id: string; pin: string };

const ITEM = `select i.id, i.queue, i.status, i.reasons, i.citations, d.country
  from review.items i join medical.questions q on q.id = i.question_id
  join shared.doctors d on d.id = q.requester_id where i.question_id = $1`;
const COUNT_MESSAGES = `select count(*)::int as n from outbox.messages
  where question_id = $1 and ($2::text is null or kind = $2)`;
const COUNT_DECISIONS = "select count(*)::int as n from review.decisions where item_id = $1";

export async function checkerQuery<Row>(sql: string, values: unknown[] = []): Promise<Row[]> {
  return withRole("checker", async (client) => (await client.query(sql, values)).rows as Row[]);
}

export async function readItem(questionId: string): Promise<Item | undefined> {
  return (await checkerQuery<Item>(ITEM, [questionId]))[0];
}

// Messages sent for one question: of one kind, or of any kind when kind is null.
export async function messageCount(questionId: string, kind: string | null): Promise<number> {
  return (await checkerQuery<{ n: number }>(COUNT_MESSAGES, [questionId, kind]))[0].n;
}

export async function decisionCount(itemId: string): Promise<number> {
  return (await checkerQuery<{ n: number }>(COUNT_DECISIONS, [itemId]))[0].n;
}

// A reviewer the policy allows for this item, or with qualified = false, one with the right role
// for another country. A data steward covers every country.
export function qualifiedReviewer(item: Item, qualified = true) {
  const queues = readPolicy().queues as Record<string, { role: string }>;
  const role = queues[item.queue].role;
  const covers = (countries: string[]) =>
    role === "data_steward" || countries.includes(item.country ?? "");
  return readReviewers().find(
    (reviewer) => reviewer.role === role && covers(reviewer.countries) === qualified,
  );
}

// A review command, with the PIN on standard input and any extra flags, such as --reason.
export function decide(action: string, itemId: string, signer: Signer, flags: string[] = []) {
  const args = ["review", action, itemId, "--reviewer", signer.id, ...flags];
  return runSolution(args, `${signer.pin}\n`);
}

export function line(says: string, passed: boolean, detail?: string): Line {
  return passed ? { says, result: "pass" } : { says, result: "fail", detail };
}
