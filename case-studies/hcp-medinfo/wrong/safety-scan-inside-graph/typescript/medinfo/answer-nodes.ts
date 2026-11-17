// The nodes that work out an answer: the model steps, and the route that picks a queue.
//
// A model step whose reply doesn't validate never stops the question. The step falls back to a
// safe value, records the problem, and the route sends the question to full review. Model
// confidence is never used: the route reads topics, the SRD match and the verifier.
import { recordAlone } from "./audit";
import {
  type Answer,
  extractQuestions,
  InvalidReplyError,
  srdMatch,
  topicCheck,
  writeDraft,
} from "./model-steps";
import { loadPolicy, type Policy } from "./policy";
import { scan } from "./safety-scan";
import { type Run, trace, type Update } from "./state";
import { verify as verifySentences } from "./verifier";

type Outcome = Record<string, unknown>;
type Asked<Value> = { value: Value; call: Outcome; problem: string | null };

// The checked reply and its call details, or the fallback and the problem.
async function askModel<Value>(
  ask: () => Promise<Answer<Value>>,
  fallback: Value,
): Promise<Asked<Value>> {
  try {
    const answer = await ask();
    return { value: answer.value, call: answer.call, problem: null };
  } catch (error) {
    if (!(error instanceof InvalidReplyError)) throw error;
    return { value: fallback, call: {}, problem: error.message };
  }
}

// Record the step in the audit chain and add any problem to the run's list.
async function finishStep(run: Run, name: string, outcome: Outcome, asked: Asked<unknown>) {
  const entry = { ...outcome, ...asked.call, problem: asked.problem };
  await recordAlone("graph", run.question_id, name, entry);
  const problems = [...(run.model_problems ?? []), ...(asked.problem ? [asked.problem] : [])];
  return { model_problems: problems };
}

export async function extractNode(run: Run): Promise<Update> {
  trace("extract_questions");
  const ask = () => extractQuestions(run.question_id, run.question_text);
  const asked = await askModel(ask, { questions: [run.question_text] });
  return { ...asked.value, ...(await finishStep(run, "extract_questions", asked.value, asked)) };
}

const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Keyword rules from policy.yaml, each term at the start of a word.
function ruleTopics(text: string, rules: Record<string, string[]>): string[] {
  const matches = (term: string) => new RegExp(`\\b${literal(term)}`, "i").test(text);
  return Object.entries(rules)
    .filter(([, terms]) => terms.some(matches))
    .map(([topic]) => topic);
}

// The model's topics joined with the keyword rules', so either one can flag a topic.
export async function topicNode(run: Run): Promise<Update> {
  trace("topic_check");
  await scan(run.question_id);
  const topics = loadPolicy().topics;
  const allowed = [...topics.escalate_with_draft, ...topics.human_only];
  const ask = () => topicCheck(run.question_id, run.question_text, allowed);
  const asked = await askModel(ask, { topics: [] as string[] });
  const byRules = ruleTopics(run.question_text, topics.rules);
  const joined = [...new Set([...asked.value.topics, ...byRules])].sort();
  const outcome = { topics: joined, by_model: asked.value.topics, by_rules: byRules };
  return { topics: joined, ...(await finishStep(run, "topic_check", outcome, asked)) };
}

// Does one SRD fully answer the questions? No SRD among the passages means no.
export async function srdMatchNode(run: Run): Promise<Update> {
  trace("srd_match");
  const srdPassages = run.passages.filter((passage) => passage.kind === "srd");
  const none = { document: null, coverage: "none" };
  if (srdPassages.length === 0) {
    const nothing = { value: none, call: {}, problem: null };
    return {
      srd_match: none,
      ...(await finishStep(run, "srd_match", { srd_match: none }, nothing)),
    };
  }
  const ask = () => srdMatch(run.question_id, run.questions, srdPassages);
  const asked = await askModel<{ document: string | null; coverage: string }>(ask, none);
  const outcome = { srd_match: asked.value };
  return { srd_match: asked.value, ...(await finishStep(run, "srd_match", outcome, asked)) };
}

// adapt_srd from the one SRD that fully answers, or compose from every passage.
export async function draftNode(run: Run): Promise<Update> {
  trace("draft");
  const match = run.srd_match ?? { document: null, coverage: "none" };
  const adapt = match.coverage === "full";
  const chosen = (passage: Run["passages"][number]) =>
    `${passage.doc_id}@${passage.version}` === match.document;
  const passages = adapt ? run.passages.filter(chosen) : run.passages;
  const ask = () => writeDraft(run.question_id, run.questions, passages, adapt);
  const asked = await askModel(ask, { draft: [] as Run["draft"], step: null as string | null });
  return { draft: asked.value.draft, ...(await finishStep(run, "draft", asked.value, asked)) };
}

// The verifier on the draft. Every flag sends the question to full review.
export async function verifyNode(run: Run): Promise<Update> {
  trace("verify");
  if (!run.draft || run.draft.length === 0) return { verifier: null };
  const passages = new Map(run.passages.map((passage) => [passage.chunk_id, passage.text]));
  const result = await verifySentences(run.question_id, "verify", run.draft, passages);
  await recordAlone("graph", run.question_id, "verify", result);
  return { verifier: result };
}

type Routed = [string | null, string[]];

// The queues a question takes without a draft to judge: an unresolved requester, a rep's
// off-label question, a human-only topic, or no approved answer.
function withoutDraft(run: Run, topicsPolicy: Policy["topics"]): Routed | undefined {
  const topics = run.topics ?? [];
  if (run.requester.country === null) return ["identity_resolution", ["country unknown"]];
  if (run.requester.kind === "rep" && topics.includes("off_label")) {
    return [null, ["off-label question from a rep: redirect template"]];
  }
  const humanOnly = topics.filter((topic) => topicsPolicy.human_only.includes(topic));
  if (humanOnly.length > 0) return ["human_only", humanOnly.map((topic) => `topic: ${topic}`)];
  if (run.search_status === "nothing_found") return ["writer_needed", ["no approved answer"]];
  return undefined;
}

// Where the question goes, and why. null means the rep redirect template, with no review.
export function chooseQueue(run: Run, topicsPolicy: Policy["topics"]): Routed {
  const early = withoutDraft(run, topicsPolicy);
  if (early) return early;
  const topics = run.topics ?? [];
  if ((run.model_problems ?? []).length > 0) return ["full_review", run.model_problems];
  const flagged = topics.filter((topic) => topicsPolicy.escalate_with_draft.includes(topic));
  if (flagged.length > 0) return ["full_review", flagged.map((topic) => `topic: ${topic}`)];
  const flags = run.verifier?.flags ?? [];
  if (flags.length > 0)
    return ["full_review", flags.map((flag) => `verifier: sentence ${flag.sentence}`)];
  const coverage = run.srd_match?.coverage ?? "none";
  if (coverage !== "full") return ["full_review", [`SRD coverage: ${coverage}`]];
  return ["light_check", ["one SRD fully answers it, no topic is flagged, every claim checks out"]];
}
