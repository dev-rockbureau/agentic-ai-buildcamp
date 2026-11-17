// The routes rule: every question first goes to the queue traps.json expects, as the route's own
// audit entry records it. A question with no approved answer has no draft (T6), an off-label
// question from a doctor has one (T4), and a rep's off-label question gets the redirect template
// with no search and no review (T10).
import { checkerQuery } from "./checking";
import type { Line } from "./firewall";
import { type Expected, readExpectations } from "./retrieval";
import { readQuestions } from "./world";

type Facts = {
  question_id: string;
  queue: string | null;
  routed: boolean;
  drafted: boolean | null;
  redirects: number;
  searches: number;
};

// The first route entry per question: the queue before any reviewer or steward acted.
const FACTS = `select q.id as question_id, r.queue, r.seq is not null as routed,
  case when i.id is null then null else i.draft is not null end as drafted,
  (select count(*) from outbox.messages m where m.question_id = q.id and m.kind = 'rep_reply')::int
    as redirects,
  (select count(*) from audit.entries a where a.question_id = q.id and a.type = 'retrieve')::int
    as searches
  from medical.questions q
  left join lateral (select payload->>'queue' as queue, seq from audit.entries a
    where a.question_id = q.id and a.type = 'route' order by seq limit 1) r on true
  left join review.items i on i.question_id = q.id`;

function draftProblems(expected: Expected, facts: Facts): string[] {
  if (expected.draft === false && facts.drafted) return ["it has a draft"];
  if (expected.draft === true && !facts.drafted) return ["it has no draft"];
  return [];
}

function redirectProblems(expected: Expected, facts: Facts): string[] {
  if (expected.outcome !== "rep_redirect") return [];
  const problems: string[] = [];
  if (facts.redirects !== 1) problems.push(`${facts.redirects} redirect messages`);
  if (facts.drafted !== null) problems.push("it has a review item");
  if (facts.searches > 0) problems.push("it was searched");
  return problems;
}

function routeLine(questionId: string, expected: Expected, facts: Facts | undefined): Line {
  const trap = expected.trap === "baseline" ? "baseline" : `trap ${expected.trap}`;
  const destination = expected.queue ?? "the rep redirect";
  const says = `${questionId} (${trap}) is routed to ${destination}`;
  if (!facts?.routed) return { says, result: "fail", detail: "no route entry" };
  const problems = [
    ...(facts.queue === (expected.queue ?? null) ? [] : [`routed to ${facts.queue}`]),
    ...draftProblems(expected, facts),
    ...redirectProblems(expected, facts),
  ];
  if (problems.length === 0) return { says, result: "pass" };
  return { says, result: "fail", detail: problems.join("; ") };
}

export async function checkRoutes(): Promise<Line[]> {
  const rows = await checkerQuery<Facts>(FACTS);
  const facts = new Map(rows.map((row) => [row.question_id, row]));
  const expectations = readExpectations();
  return readQuestions().map((question) =>
    routeLine(question.id, expectations[question.id], facts.get(question.id)),
  );
}
