// The Medical Question Helper as a LangGraph graph, with Postgres checkpoints.
//
// A question runs until it waits for a reviewer, then the process may exit or be killed. The
// checkpoint keeps the run, and any later process resumes it on the same thread_id (the question
// id). Nothing reaches a doctor except through the gateway: a signed reply, or a pre-approved
// template (the acknowledgment, the rep redirect).
//
// Every node adds one entry to the question's audit chain. Every question passes through `route`,
// which picks its queue. The model steps are in answer-nodes.ts.
import { Command, END, interrupt, START, StateGraph } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import pg from "pg";
import {
  chooseQueue,
  draftNode,
  extractNode,
  srdMatchNode,
  topicNode,
  verifyNode,
} from "./answer-nodes";
import { record, recordAlone } from "./audit";
import { firstRow, inTransaction, url } from "./database";
import { sendAcknowledgment, sendReply, sendRepRedirect } from "./gateway";
import { search } from "./knowledge";
import { loadPolicy } from "./policy";
import { medicalView } from "./profile";
import { type Run, RunState, trace, type Update } from "./state";

const QUESTION = "select requester_id, text from medical.questions where id = $1";
// One item per question. A repeat with the same queue and draft changes nothing and returns no
// row. A question that runs again after the steward sets a country updates its item.
const UPSERT_ITEM = `insert into review.items
  (id, thread_id, question_id, queue, draft, citations, verifier, reasons, due_at)
  values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9)
  on conflict (id) do update set queue = excluded.queue, draft = excluded.draft,
    citations = excluded.citations, verifier = excluded.verifier, reasons = excluded.reasons,
    due_at = excluded.due_at, status = 'waiting'
  where review.items.queue is distinct from excluded.queue
    or review.items.draft is distinct from excluded.draft
  returning id`;
const DECISION = "select action from review.decisions where id = $1";
const FINISH_ITEM = "update review.items set status = $1, reasons = reasons || $2 where id = $3";
const SET_STATUS = "update medical.questions set status = $1 where id = $2";

// Where each decision sends the question next.
const NEXT_NODE: Record<string, string> = {
  approve: "send",
  edit: "send",
  reject: "close",
  close: "close",
  set_country: "load_context",
  // A cited source was withdrawn or changed before signing: search again and redraft.
  invalidate: "retrieve",
};

// What load_context clears, so a question that runs again after the steward starts clean.
const FRESH: Update = {
  questions: [],
  topics: [],
  search_status: null,
  passages: [],
  srd_match: null,
  draft: [],
  verifier: null,
  model_problems: [],
};

async function loadContext(run: Run): Promise<Update> {
  trace("load_context");
  return inTransaction("graph", async (client) => {
    const question = await firstRow<{ requester_id: string; text: string }>(client, QUESTION, [
      run.question_id,
    ]);
    if (!question) throw new Error(`No question with id ${run.question_id}`);
    const requester = await medicalView(client, question.requester_id);
    const seen = { requester_id: requester.id, kind: requester.kind, country: requester.country };
    await record(client, run.question_id, "load_context", seen);
    return { ...FRESH, requester, question_text: question.text };
  });
}

async function retrieve(run: Run): Promise<Update> {
  trace("retrieve");
  return inTransaction("graph", async (client) => {
    const found = await search(client, run.question_text, run.requester, loadPolicy());
    const versions = found.passages.map(
      (passage) => `${passage.doc_id}@${passage.version}@${passage.content_hash}`,
    );
    const searched = { status: found.status, sources: [...new Set(versions)].sort() };
    await record(client, run.question_id, "retrieve", searched);
    return { search_status: found.status, passages: found.passages };
  });
}

function dueAt(queue: string | null): string | null {
  const minutes = queue ? loadPolicy().queues[queue].due_minutes : null;
  if (minutes === null) return null;
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

async function route(run: Run): Promise<Update> {
  trace("route");
  const [queue, reasons] = chooseQueue(run, loadPolicy().topics);
  await recordAlone("graph", run.question_id, "route", {
    queue,
    reasons,
    topics: run.topics ?? [],
  });
  return { queue, reasons, due_at: dueAt(queue) };
}

// Doctors get a pre-approved acknowledgment. Reps don't.
async function acknowledge(run: Run): Promise<Update> {
  trace("acknowledge");
  const doctor = run.requester.kind === "doctor";
  if (doctor) await sendAcknowledgment(run.question_id, run.queue ?? "", run.due_at);
  await recordAlone("graph", run.question_id, "acknowledge", { acknowledged: doctor });
  return { acknowledged: doctor };
}

function citations(run: Run) {
  const cited = new Set((run.draft ?? []).flatMap((sentence) => sentence.cites));
  return (run.passages ?? [])
    .filter((passage) => cited.has(passage.chunk_id))
    .map(({ chunk_id, doc_id, version, content_hash }) => ({
      chunk_id,
      doc_id,
      version,
      content_hash,
    }));
}

// Write or update the item, with an audit entry only when something changed.
async function queueItem(run: Run): Promise<void> {
  const itemId = `RV-${run.question_id}`;
  const drafted = run.draft?.length ? JSON.stringify(run.draft) : null;
  const verified = run.verifier ? JSON.stringify(run.verifier) : null;
  const item = [itemId, run.question_id, run.question_id, run.queue, drafted];
  const rest = [JSON.stringify(citations(run)), verified, run.reasons, run.due_at];
  await inTransaction("graph", async (client) => {
    if ((await client.query(UPSERT_ITEM, [...item, ...rest])).rowCount === 0) return;
    await client.query(SET_STATUS, ["waiting", run.question_id]);
    await record(client, run.question_id, "review_queued", { item_id: itemId, queue: run.queue });
  });
}

// Write the item first, so the reviewer CLI can see it, then pause. On resume this node runs
// again from the top, so writing the item must be safe to repeat.
async function review(run: Run): Promise<Update> {
  trace("review");
  await queueItem(run);
  const answer = interrupt({ item_id: `RV-${run.question_id}`, queue: run.queue }) as {
    decision_id: number;
  };
  return inTransaction("graph", async (client) => {
    const row = await firstRow<{ action: string }>(client, DECISION, [answer.decision_id]);
    const action = row?.action ?? "";
    await record(client, run.question_id, "review_decided", {
      decision_id: answer.decision_id,
      action,
    });
    return { decision_id: answer.decision_id, decision_action: action };
  });
}

// Close the item and the question, and record the final state, in one transaction.
async function finish(questionId: string, status: string, entryType: string, reasons: string[]) {
  await inTransaction("graph", async (client) => {
    await client.query(FINISH_ITEM, [status, reasons, `RV-${questionId}`]);
    await client.query(SET_STATUS, [status, questionId]);
    await record(client, questionId, entryType, { outcome: status, reasons });
  });
}

async function send(run: Run): Promise<Update> {
  trace("send");
  const result = await sendReply(run.question_id);
  const outcome = result.sent ? "sent" : "send_refused";
  const refusal = result.sent ? [] : [result.reason ?? ""];
  await finish(run.question_id, outcome, "send", refusal);
  return { outcome, reasons: [...(run.reasons ?? []), ...refusal] };
}

// A reviewer's rejection, or a data steward closing an unresolved request.
async function close(run: Run): Promise<Update> {
  trace("close");
  const outcome = run.decision_action === "close" ? "closed" : "rejected";
  await finish(run.question_id, outcome, "close", []);
  return { outcome };
}

// A rep asked an off-label question. The rep gets the pre-approved redirect, no answer.
async function redirect(run: Run): Promise<Update> {
  trace("redirect");
  await sendRepRedirect(run.question_id);
  await finish(run.question_id, "rep_redirect", "redirect", run.reasons ?? []);
  return { outcome: "rep_redirect" };
}

// An unknown country gets no search and no medical answer: straight to the data steward.
const afterLoad = (run: Run) => (run.requester.country === null ? "route" : "extract_questions");

// A rep's off-label question and a human-only topic get no search and no draft.
function afterTopics(run: Run): string {
  const humanOnly = run.topics.some((topic) => loadPolicy().topics.human_only.includes(topic));
  const repOffLabel = run.requester.kind === "rep" && run.topics.includes("off_label");
  return humanOnly || repOffLabel ? "route" : "retrieve";
}

// Nothing approved found: no SRD match and no draft. The route sends it to a writer.
const afterSearch = (run: Run) => (run.search_status === "found" ? "match_srd" : "route");

function afterRoute(run: Run): string {
  if (run.queue === null) return "redirect";
  // An unresolved requester gets no acknowledgment: there is nobody verified to send it to.
  return run.queue === "identity_resolution" ? "review" : "acknowledge";
}

function buildGraph(checkpointer: PostgresSaver) {
  return (
    new StateGraph(RunState)
      .addNode("load_context", loadContext)
      .addNode("extract_questions", extractNode)
      .addNode("topic_check", topicNode)
      .addNode("retrieve", retrieve)
      // LangGraph JS won't let a node share a state field's name, so these two differ from Python.
      // Their trace lines and audit entries still say srd_match and draft.
      .addNode("match_srd", srdMatchNode)
      .addNode("write_draft", draftNode)
      .addNode("verify", verifyNode)
      .addNode("route", route)
      .addNode("acknowledge", acknowledge)
      .addNode("review", review)
      .addNode("send", send)
      .addNode("close", close)
      .addNode("redirect", redirect)
      .addEdge(START, "load_context")
      .addConditionalEdges("load_context", afterLoad, ["route", "extract_questions"])
      .addEdge("extract_questions", "topic_check")
      .addConditionalEdges("topic_check", afterTopics, ["route", "retrieve"])
      .addConditionalEdges("retrieve", afterSearch, ["match_srd", "route"])
      .addEdge("match_srd", "write_draft")
      .addEdge("write_draft", "verify")
      .addEdge("verify", "route")
      .addConditionalEdges("route", afterRoute, ["redirect", "review", "acknowledge"])
      .addEdge("acknowledge", "review")
      // Setting a country sends the question back to the start, now that it has one.
      .addConditionalEdges("review", (run: Run) => NEXT_NODE[run.decision_action], [
        "send",
        "close",
        "load_context",
        "retrieve",
      ])
      .addEdge("send", END)
      .addEdge("close", END)
      .addEdge("redirect", END)
      .compile({ checkpointer })
  );
}

function summary(questionId: string, result: Record<string, unknown>): string {
  if ("__interrupt__" in result) {
    const acknowledged = result.acknowledged ? " Acknowledgment sent." : "";
    return `${questionId} → ${result.queue}.${acknowledged} Waiting for review RV-${questionId}.`;
  }
  if (result.outcome === "sent") return `${questionId} → sent as M-${questionId}.`;
  if (result.outcome === "send_refused") {
    const reasons = result.reasons as string[];
    return `${questionId} → the gateway refused to send: ${reasons[reasons.length - 1]}.`;
  }
  if (result.outcome === "rep_redirect") {
    return `${questionId} → the rep was sent the redirect template, M-${questionId}.`;
  }
  return `${questionId} → ${result.outcome}.`;
}

// The checkpointer's setup() always runs CREATE SCHEMA IF NOT EXISTS, and Postgres checks the
// database-wide CREATE privilege even when the schema exists. The graph role has CREATE only in
// the langgraph schema, which the seed already made, so that one statement is skipped here rather
// than giving the graph role the right to create schemas anywhere in the database.
function poolWithoutSchemaCreation(): pg.Pool {
  const pool = new pg.Pool({ connectionString: url("graph") });
  const skip = (text: unknown) =>
    typeof text === "string" && text.startsWith("CREATE SCHEMA IF NOT EXISTS");
  // "connect" fires once for each new client the pool opens, however the pool is used.
  pool.on("connect", (client) => {
    const query = client.query.bind(client) as (...args: unknown[]) => unknown;
    client.query = ((text: unknown, ...rest: unknown[]) =>
      skip(text) ? Promise.resolve({ rows: [] }) : query(text, ...rest)) as typeof client.query;
  });
  return pool;
}

// The graph, with its checkpoints in the langgraph schema as the graph role.
async function withGraph<Result>(work: (graph: ReturnType<typeof buildGraph>) => Promise<Result>) {
  const checkpointer = new PostgresSaver(poolWithoutSchemaCreation(), undefined, {
    schema: "langgraph",
  });
  await checkpointer.setup();
  try {
    return await work(buildGraph(checkpointer));
  } finally {
    await checkpointer.end();
  }
}

export function ask(questionId: string): Promise<string> {
  const config = { configurable: { thread_id: questionId } };
  return withGraph(async (graph) => {
    const state = await graph.getState(config);
    if (Object.keys(state.values ?? {}).length > 0) {
      return `${questionId} was already asked. Use resume to carry on.`;
    }
    return summary(questionId, await graph.invoke({ question_id: questionId }, config));
  });
}

// Carry on a paused question with a recorded decision, in this process or any later one.
export function resume(questionId: string, decisionId: number | null): Promise<string> {
  const config = { configurable: { thread_id: questionId } };
  return withGraph(async (graph) => {
    const state = await graph.getState(config);
    const values = (state.values ?? {}) as Record<string, unknown>;
    if (Object.keys(values).length === 0) return `${questionId} hasn't been asked yet.`;
    if (state.next.length === 0) return summary(questionId, values);
    // A decision this run already acted on is not an answer to the current pause.
    if (decisionId === null || decisionId <= Number(values.decision_id ?? 0)) {
      return `RV-${questionId} is still waiting for a reviewer.`;
    }
    const resumed = new Command({ resume: { decision_id: decisionId } });
    return summary(questionId, await graph.invoke(resumed, config));
  });
}
