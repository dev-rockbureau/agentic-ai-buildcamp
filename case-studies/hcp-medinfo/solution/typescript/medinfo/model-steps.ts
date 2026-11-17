// The graph's model steps: their prompts, and the checks each reply must pass.
//
// Every step asks for JSON and checks it. A reply that isn't valid JSON, or names a topic, a
// document or a section it wasn't given, throws InvalidReplyError, and the graph sends the
// question to a human. The question's text is always data, never instructions: each prompt says
// so, and the text sits inside tags.
//
// The system prompts live in prompts/, shared by both solutions, because the replay key is a hash
// of the prompt. The user messages are built here exactly as the Python solution builds them.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Role } from "../../../../../config/models";
import type { Passage } from "./knowledge";
import { chat, type Reply, type Usage } from "./model";
import { CASE_STUDY_DIR } from "./policy";
import type { Sentence } from "./signature";

export class InvalidReplyError extends Error {}

export type Call = { model_role: Role; model: string; usage: Usage };
export type Answer<Value> = { value: Value; call: Call };
type Json = Record<string, unknown>;

const COVERAGES = ["full", "partial", "none"];
const STATUSES = ["supported", "partly_supported", "unsupported"];

// A system prompt from prompts/<name>.txt. The file's final newline is not part of it.
function prompt(name: string): string {
  const text = readFileSync(join(CASE_STUDY_DIR, "prompts", `${name}.txt`), "utf8");
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

async function ask(
  label: string,
  role: Role,
  system: string,
  user: string,
): Promise<[Json, Reply]> {
  const reply = await chat({ label, role, system, user });
  // Some models wrap JSON in a code fence. The fence is not part of the answer.
  const text = reply.text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new InvalidReplyError(`${label}: the reply is not JSON`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidReplyError(`${label}: the reply is not a JSON object`);
  }
  return [value as Json, reply];
}

const answer = <Value>(value: Value, reply: Reply, role: Role): Answer<Value> => ({
  value,
  call: { model_role: role, model: reply.model, usage: reply.usage },
});

export const message = (text: string) => `<message>\n${text}\n</message>`;

export async function extractQuestions(questionId: string, text: string) {
  const label = `${questionId}.extract_questions`;
  const [value, reply] = await ask(label, "fast", prompt("extract_questions"), message(text));
  const questions = value.questions;
  const valid = Array.isArray(questions) && questions.length > 0 && questions.length <= 5;
  const allText =
    valid && questions.every((question) => typeof question === "string" && question.trim());
  if (!allText) throw new InvalidReplyError(`${label}: expected 1 to 5 questions`);
  return answer({ questions: questions as string[] }, reply, "fast");
}

export async function topicCheck(questionId: string, text: string, allowed: string[]) {
  const label = `${questionId}.topic_check`;
  const [value, reply] = await ask(label, "fast", prompt("topic_check"), message(text));
  const topics = value.topics;
  const known = Array.isArray(topics) && topics.every((topic) => allowed.includes(topic));
  if (!known) throw new InvalidReplyError(`${label}: topics must come from the list`);
  return answer({ topics: [...new Set(topics as string[])].sort() }, reply, "fast");
}

const asked = (questions: string[]) =>
  `<questions>\n${questions.map((question) => `- ${question}`).join("\n")}\n</questions>`;

// Each passage with its id, the document and section it comes from, and its words.
function sections(passages: Passage[], tag: string): string {
  const block = (passage: Passage) =>
    `<${tag} id="${passage.chunk_id}" document="${passage.doc_id}@${passage.version}" ` +
    `section="${passage.section}">\n${passage.text}\n</${tag}>`;
  return passages.map(block).join("\n");
}

// The SRD the reply names, as doc_id@version. A bare doc_id is fine when only one version of it
// was given.
function namedDocument(named: unknown, srdPassages: Passage[]): string | undefined {
  const documents = new Map(
    srdPassages.map((passage) => [`${passage.doc_id}@${passage.version}`, passage.doc_id]),
  );
  if (typeof named === "string" && documents.has(named)) return named;
  const versions = [...documents].filter(([, docId]) => docId === named).map(([key]) => key);
  return versions.length === 1 ? versions[0] : undefined;
}

export async function srdMatch(questionId: string, questions: string[], srdPassages: Passage[]) {
  const label = `${questionId}.srd_match`;
  const user = `${asked(questions)}\n${sections(srdPassages, "srd_section")}`;
  const [value, reply] = await ask(label, "fast", prompt("srd_match"), user);
  const coverage = String(value.coverage);
  const document = namedDocument(value.doc_id, srdPassages);
  if (!COVERAGES.includes(coverage) || (coverage !== "none" && !document)) {
    throw new InvalidReplyError(`${label}: unknown coverage or document`);
  }
  const matched = { document: coverage !== "none" ? (document ?? null) : null, coverage };
  return answer(matched, reply, "fast");
}

function checkedSentences(label: string, sentences: unknown, given: Set<string>): Sentence[] {
  if (!Array.isArray(sentences) || sentences.length === 0) {
    throw new InvalidReplyError(`${label}: expected sentences`);
  }
  for (const sentence of sentences) {
    const valid = typeof sentence === "object" && sentence && typeof sentence.text === "string";
    const cites = valid ? sentence.cites : undefined;
    const known =
      Array.isArray(cites) && cites.length > 0 && cites.every((chunk) => given.has(chunk));
    if (!known) throw new InvalidReplyError(`${label}: every sentence must cite a given section`);
  }
  return sentences.map((sentence) => ({ text: sentence.text, cites: [...sentence.cites] }));
}

// adapt_srd when one SRD fully answers the questions, compose otherwise. Both cite sections.
export async function writeDraft(
  questionId: string,
  questions: string[],
  passages: Passage[],
  adapt: boolean,
) {
  const step = adapt ? "adapt_srd" : "compose";
  const label = `${questionId}.${step}`;
  const user = `${asked(questions)}\n${sections(passages, "passage")}`;
  const [value, reply] = await ask(label, "smart", prompt(step), user);
  const given = new Set(passages.map((passage) => passage.chunk_id));
  const draft = checkedSentences(label, value.sentences, given);
  return answer({ draft, step }, reply, "smart");
}

const numbered = (sentences: Sentence[]) =>
  `<draft>\n${sentences
    .map(
      (sentence, index) => `${index + 1}. ${sentence.text} [cites: ${sentence.cites.join(", ")}]`,
    )
    .join("\n")}\n</draft>`;

// Each cited section once, in the order the draft first cites it.
function citedSections(sentences: Sentence[], passages: Map<string, string>): string {
  const cited = [...new Set(sentences.flatMap((sentence) => sentence.cites))];
  const blocks = cited
    .filter((chunk) => passages.has(chunk))
    .map((chunk) => `<section id="${chunk}">\n${passages.get(chunk)}\n</section>`);
  return blocks.join("\n");
}

export type Claim = { sentence: number; status: string; quote: string };

function checkedClaims(label: string, claims: unknown, count: number): Claim[] {
  const list = Array.isArray(claims) && claims.every((claim) => typeof claim === "object" && claim);
  if (!list) throw new InvalidReplyError(`${label}: expected a list of claims`);
  const order = (claims as Json[]).map((claim) => claim.sentence);
  if (JSON.stringify(order) !== JSON.stringify(Array.from({ length: count }, (_, i) => i + 1))) {
    throw new InvalidReplyError(`${label}: expected one claim per sentence, in order`);
  }
  for (const claim of claims as Json[]) {
    if (!STATUSES.includes(String(claim.status)) || typeof claim.quote !== "string") {
      throw new InvalidReplyError(`${label}: each claim needs a status and a quote`);
    }
  }
  return claims as Claim[];
}

// One claim per sentence, in order, each with a status and a quote.
export async function judge(
  questionId: string,
  step: string,
  sentences: Sentence[],
  passages: Map<string, string>,
) {
  const label = `${questionId}.${step}`;
  const user = `${numbered(sentences)}\n${citedSections(sentences, passages)}`;
  const [value, reply] = await ask(label, "judge", prompt("judge"), user);
  return answer({ claims: checkedClaims(label, value.claims, sentences.length) }, reply, "judge");
}
