// The safety rule (must-never 3): every question that contains a configured safety term has
// exactly one packet and one marker, with Day 0 = the time the question was received. A second
// scan writes nothing. T16's questions are known misses of a rules-only scan, and are reported
// as known misses, not passes.
import { checkerQuery, line } from "./checking";
import type { Line } from "./firewall";
import { type Expected, readExpectations } from "./retrieval";
import { runSolution } from "./solution";
import { readPolicy, readQuestions } from "./world";

type Found = {
  question_id: string;
  packet_id: string | null;
  day_zero_ok: boolean | null;
  verbatim_ok: boolean | null;
  marker: string | null;
};
type Counts = { packets: number; markers: number; scans: number };

const FOUND = `select q.id as question_id, p.id as packet_id,
  p.received_at = q.received_at as day_zero_ok, p.verbatim_text = q.text as verbatim_ok,
  m.packet_id as marker
  from medical.questions q left join safety.packets p on p.question_id = q.id
  left join medical.safety_markers m on m.question_id = q.id`;
const COUNTS = `select (select count(*) from safety.packets)::int as packets,
  (select count(*) from medical.safety_markers)::int as markers,
  (select count(*) from audit.entries where type = 'safety_scan')::int as scans`;

// The same matching the policy describes: a term at the start of a word, in any case.
function termsIn(text: string, terms: string[]): string[] {
  const literal = (term: string) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return terms.filter((term) => new RegExp(`\\b${literal(term)}`, "i").test(text));
}

function packetProblems(found: Found | undefined): string[] {
  if (!found?.packet_id) return ["no packet"];
  const problems: string[] = [];
  if (found.marker !== found.packet_id) problems.push("no marker in the medical zone");
  if (!found.day_zero_ok) problems.push("Day 0 is not the time the question was received");
  if (!found.verbatim_ok) problems.push("the packet doesn't keep the exact words");
  return problems;
}

function packetLine(questionId: string, terms: string[], found: Found | undefined, trap: string) {
  const says = `${questionId} (${trap}) has one safety packet for "${terms.join('", "')}"`;
  const problems = packetProblems(found);
  return line(`${says}, with its marker and Day 0`, problems.length === 0, problems.join("; "));
}

function knownMissLine(questionId: string, expected: Expected, found: Found | undefined): Line {
  const says = `${questionId} (trap ${expected.trap}): ${expected.known_miss}`;
  if (found?.packet_id) return { says, result: "pass", detail: "caught" };
  return { says, result: "known miss", detail: "a rules-only scan can't see it" };
}

async function scanAgain(questionIds: string[]): Promise<Line> {
  const [before] = await checkerQuery<Counts>(COUNTS);
  const failed = questionIds.filter((id) => runSolution(["scan", id]).status !== 0);
  const [after] = await checkerQuery<Counts>(COUNTS);
  const unchanged = JSON.stringify(before) === JSON.stringify(after);
  const everyQuestionOnce = before.scans === questionIds.length;
  const detail = `before ${JSON.stringify(before)}, after ${JSON.stringify(after)}`;
  const passed = unchanged && everyQuestionOnce && failed.length === 0;
  return line("every question was scanned once, and a second scan writes nothing", passed, detail);
}

export async function checkSafety(): Promise<Line[]> {
  const terms = readPolicy().safety_terms as string[];
  const expectations = readExpectations();
  const found = new Map((await checkerQuery<Found>(FOUND)).map((row) => [row.question_id, row]));
  const lines: Line[] = [];
  for (const question of readQuestions()) {
    const expected = expectations[question.id];
    const matched = termsIn(question.text, terms);
    const trap = expected.trap === "baseline" ? "baseline" : `trap ${expected.trap}`;
    if (matched.length > 0)
      lines.push(packetLine(question.id, matched, found.get(question.id), trap));
    if (expected.known_miss)
      lines.push(knownMissLine(question.id, expected, found.get(question.id)));
  }
  lines.push(await scanAgain(readQuestions().map((question) => question.id)));
  return lines;
}
