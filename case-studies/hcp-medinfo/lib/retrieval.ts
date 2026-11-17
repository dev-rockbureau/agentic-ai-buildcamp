// The retrieval rule: every passage the solution's search returns must be allowed for that
// requester on the world's date, and each trap's document must be returned or kept out.
// It reads the documents itself as the checker role, so it never trusts the solution's word.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { withRole } from "./database";
import type { Line } from "./firewall";
import { runSearch, type SearchedPassage, type SearchOutput } from "./solution";
import { CASE_STUDY_DIR, readPolicy, readQuestions, worldClock } from "./world";

export type Expected = {
  trap: string;
  outcome?: string;
  change_after_signing?: string;
  known_miss?: string;
  queue_after_redraft?: string;
  reviewer_edit?: { sentence: number; from: string; to: string };
  queue?: string | null;
  draft?: boolean;
  searched?: boolean;
  searched_kinds?: string[];
  must_cite?: string[];
  must_not_cite?: string[];
  withdraw_while_waiting?: string;
};

type StoredDocument = {
  status: string;
  countries: string[];
  approved_use: string;
  effective_date: string;
  expiry_date: string;
  content_hash: string;
};

type Rules = { clock: string; usesByKind: Record<string, string[]> };

const DOCUMENTS = `select doc_id, version, status, countries, approved_use,
  effective_date::text, expiry_date::text, content_hash from knowledge.documents`;

function readRules(): Rules {
  const policy = readPolicy();
  return { clock: worldClock(), usesByKind: policy.approved_use as Record<string, string[]> };
}

export function readExpectations(): Record<string, Expected> {
  const text = readFileSync(join(CASE_STUDY_DIR, "world", "traps.json"), "utf8");
  return (JSON.parse(text) as { expected: Record<string, Expected> }).expected;
}

async function readStoredDocuments(): Promise<Map<string, StoredDocument>> {
  const rows = await withRole("checker", async (client) => (await client.query(DOCUMENTS)).rows);
  return new Map(rows.map((row) => [`${row.doc_id}@${row.version}`, row as StoredDocument]));
}

// Why this passage must not be shown to this requester today, or nothing when it is allowed.
function whyNotAllowed(stored: StoredDocument, output: SearchOutput, rules: Rules): string[] {
  const reasons: string[] = [];
  const allowedUses = rules.usesByKind[output.requester.kind] ?? [];
  if (stored.status !== "approved") reasons.push(`status is ${stored.status}`);
  if (stored.effective_date > rules.clock) reasons.push("not yet in effect");
  if (stored.expiry_date <= rules.clock) reasons.push(`expired on ${stored.expiry_date}`);
  if (!stored.countries.includes(output.requester.country ?? "")) {
    reasons.push(`not approved in ${output.requester.country}`);
  }
  if (!allowedUses.includes(stored.approved_use)) {
    reasons.push(`a ${output.requester.kind} can't be answered from ${stored.approved_use}`);
  }
  return reasons;
}

function passageProblems(
  passage: SearchedPassage,
  output: SearchOutput,
  context: { stored: Map<string, StoredDocument>; rules: Rules },
): string[] {
  const key = `${passage.doc_id}@${passage.version}`;
  const stored = context.stored.get(key);
  if (!stored) return [`${key} is not in the library`];
  const reasons = whyNotAllowed(stored, output, context.rules);
  if (stored.content_hash !== passage.content_hash) reasons.push("content hash doesn't match");
  return reasons.map((reason) => `${key}: ${reason}`);
}

// A question with an unknown country must not be searched; one with no approved answer must
// come back empty, so it goes to a writer.
function statusProblems(expected: Expected, output: SearchOutput): string[] {
  if (expected.searched === false && output.status !== "country_unknown") {
    return [`expected no search, got status ${output.status}`];
  }
  if (expected.queue === "writer_needed" && output.status !== "nothing_found") {
    return [`expected nothing found, got status ${output.status}`];
  }
  return [];
}

function documentProblems(expected: Expected, output: SearchOutput): string[] {
  const returned = new Set(
    output.passages.map((passage) => `${passage.doc_id}@${passage.version}`),
  );
  const missing = (expected.must_cite ?? []).filter((key) => !returned.has(key));
  // A document withdrawn later in the run (T12) is still allowed before it is withdrawn.
  const keptOut = expected.withdraw_while_waiting ? [] : (expected.must_not_cite ?? []);
  const leaked = keptOut.filter((key) => returned.has(key));
  return [
    ...missing.map((key) => `${key} should be returned`),
    ...leaked.map((key) => `${key} must never be returned`),
  ];
}

function kindProblems(expected: Expected, output: SearchOutput): string[] {
  const kinds = expected.searched_kinds;
  if (!kinds) return [];
  const wrongKind = output.passages.find((passage) => !kinds.includes(passage.kind));
  if (!wrongKind) return [];
  return [`returned ${wrongKind.kind} to a ${output.requester.kind}`];
}

// What the trap expects from search: a status, documents returned, and documents kept out.
function expectationProblems(expected: Expected, output: SearchOutput): string[] {
  return [
    ...statusProblems(expected, output),
    ...documentProblems(expected, output),
    ...kindProblems(expected, output),
  ];
}

function lineFor(questionId: string, expected: Expected, problems: string[]): Line {
  const trap = expected.trap === "baseline" ? "baseline" : `trap ${expected.trap}`;
  const says = `${questionId} (${trap}) returns only allowed passages and meets its trap`;
  if (problems.length === 0) return { says, result: "pass" };
  return { says, result: "fail", detail: problems.join("; ") };
}

export async function checkRetrieval(): Promise<Line[]> {
  const context = { stored: await readStoredDocuments(), rules: readRules() };
  const expectations = readExpectations();
  return readQuestions().map((question) => {
    const output = runSearch(question.id);
    const expected = expectations[question.id];
    const passageIssues = output.passages.flatMap((passage) =>
      passageProblems(passage, output, context),
    );
    // Several sections of one document give the same reason, so each reason is shown once.
    const problems = new Set([...passageIssues, ...expectationProblems(expected, output)]);
    return lineFor(question.id, expected, [...problems]);
  });
}
