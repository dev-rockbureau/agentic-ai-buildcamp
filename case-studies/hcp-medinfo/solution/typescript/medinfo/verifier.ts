// The verifier: is every sentence of a reply backed by the sections it cites?
//
// Two kinds of check, and a sentence is flagged if either finds a problem:
// - The judge model says whether each sentence is supported, partly supported or unsupported, and
//   quotes the words that support it.
// - Code checks what the model can't be trusted to: (1) every cited section was retrieved, (2) the
//   judge's quote is in a cited section word for word, (3) every number in the sentence, with its
//   unit, is in a cited section.
//
// The model's confidence is never used. It runs on every draft, and again on a reviewer's edit.
import { type Claim, InvalidReplyError, judge } from "./model-steps";
import type { Sentence } from "./signature";

// A number with an optional unit: "20 mg", "40%", "250 mL", "0.5 g/kg", "7 days".
const UNITS = "%|mg/kg|mg|mL/min|mL|g/kg|g|kg|hours?|days?|weeks?|months?|years?";
const NUMBER = new RegExp(`\\d+(?:\\.\\d+)?(?:\\s*(?:${UNITS})(?![A-Za-z]))?`, "g");

export type Flag = { sentence: number; reasons: string[] };
export type Verification = { claims: Claim[] | null; flags: Flag[]; problem: string | null };

const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Spacing, case and curly quotes don't change what a passage says.
function normalized(text: string): string {
  const straight = text.replaceAll("’", "'").replaceAll("“", '"').replaceAll("”", '"');
  return straight.replace(/\s+/g, " ").trim().toLowerCase();
}

// The numbers in the sentence that no cited section contains, each with its unit.
function missingNumbers(sentence: string, citedText: string): string[] {
  const source = normalized(citedText);
  const present = (number: string) =>
    new RegExp(`(?<![\\d.])${literal(number)}(?!\\d)`).test(source);
  return (sentence.match(NUMBER) ?? []).map(normalized).filter((number) => !present(number));
}

// What code finds wrong with one sentence, whatever the judge said.
function codeProblems(sentence: Sentence, claim: Claim, passages: Map<string, string>): string[] {
  const unknown = sentence.cites.filter((chunk) => !passages.has(chunk));
  if (unknown.length > 0) return [`cites ${unknown.join(", ")}, which wasn't retrieved`];
  const citedText = sentence.cites.map((chunk) => passages.get(chunk)).join("\n");
  const missing = missingNumbers(sentence.text, citedText);
  const problems = missing.map((number) => `"${number}" is not in a cited section`);
  const quoteFound = normalized(citedText).includes(normalized(claim.quote ?? ""));
  if (claim.status !== "unsupported" && !quoteFound) {
    problems.push("the judge's quote is not in a cited section");
  }
  return problems;
}

const JUDGED: Record<string, string[]> = {
  supported: [],
  partly_supported: ["the judge found it only partly supported"],
  unsupported: ["the judge found it unsupported"],
};

// Check each sentence. passages maps each retrieved section id to its words. The result lists
// every claim, and a flag for each sentence with any problem.
export async function verify(
  questionId: string,
  step: string,
  sentences: Sentence[],
  passages: Map<string, string>,
): Promise<Verification & Record<string, unknown>> {
  let claims: Claim[] | null = null;
  let call = {};
  let problem: string | null = null;
  try {
    const answer = await judge(questionId, step, sentences, passages);
    claims = answer.value.claims;
    call = answer.call;
  } catch (error) {
    if (!(error instanceof InvalidReplyError)) throw error;
    problem = error.message;
  }
  const flags: Flag[] = [];
  sentences.forEach((sentence, index) => {
    const claim = claims?.[index];
    const reasons = claim
      ? [...JUDGED[claim.status], ...codeProblems(sentence, claim, passages)]
      : ["the judge's reply didn't validate"];
    if (reasons.length > 0) flags.push({ sentence: index + 1, reasons });
  });
  return { claims, flags, problem, ...call };
}
