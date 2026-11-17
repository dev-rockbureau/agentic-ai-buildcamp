"""The Medical Question Helper as a LangGraph graph, with Postgres checkpoints.

A question runs until it waits for a reviewer, then the process may exit or be killed. The
checkpoint keeps the run, and any later process resumes it on the same thread_id (the question
id). Nothing reaches a doctor except through the gateway: a signed reply, or a pre-approved
template (the acknowledgment, the rep redirect).

Every node adds one entry to the question's audit chain. Every question passes through `route`,
which picks its queue. The model steps are in answer_nodes.py. Step 6 adds the verifier.
"""

import datetime
from dataclasses import asdict

from langgraph.checkpoint.postgres import PostgresSaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command, interrupt
from psycopg.types.json import Jsonb

from medinfo import gateway, knowledge_service
from medinfo.answer_nodes import choose_queue, draft, extract_questions, srd_match, topic_check
from medinfo.audit import record, record_alone
from medinfo.database import checkpointer, connect
from medinfo.policy import load_policy
from medinfo.profile_service import Requester, medical_view
from medinfo.run_state import Run, trace

QUESTION = "select requester_id, text from medical.questions where id = %s"
# One item per question. A repeat with the same queue and draft changes nothing and returns no
# row. A question that runs again after the steward sets a country updates its item.
UPSERT_ITEM = """insert into review.items
  (id, thread_id, question_id, queue, draft, citations, reasons, due_at)
  values (%s, %s, %s, %s, %s, %s, %s, %s)
  on conflict (id) do update set queue = excluded.queue, draft = excluded.draft,
    citations = excluded.citations, reasons = excluded.reasons, due_at = excluded.due_at,
    status = 'waiting'
  where review.items.queue is distinct from excluded.queue
    or review.items.draft is distinct from excluded.draft
  returning id"""
DECISION = "select action from review.decisions where id = %s"
# Where each decision sends the question next.
NEXT_NODE = {
    "approve": "send",
    "reject": "close",
    "close": "close",
    "set_country": "load_context",
}
FINISH_ITEM = "update review.items set status = %s, reasons = reasons || %s where id = %s"
SET_STATUS = "update medical.questions set status = %s where id = %s"
# What load_context clears, so a question that runs again after the steward starts clean.
FRESH = {
    "questions": [],
    "topics": [],
    "search_status": None,
    "passages": [],
    "srd_match": None,
    "draft": [],
    "model_problems": [],
}


def load_context(run: Run) -> dict:
    trace("load_context")
    with connect("graph") as connection:
        question = connection.execute(QUESTION, (run["question_id"],)).fetchone()
        requester = medical_view(connection, question["requester_id"])
        seen = {"requester_id": requester.id, "kind": requester.kind, "country": requester.country}
        record(connection, run["question_id"], "load_context", seen)
    return {**FRESH, "requester": asdict(requester), "question_text": question["text"]}


def retrieve(run: Run) -> dict:
    trace("retrieve")
    requester = Requester(**run["requester"])
    with connect("graph") as connection:
        found = knowledge_service.search(connection, run["question_text"], requester, load_policy())
        versions = {
            f"{passage.doc_id}@{passage.version}@{passage.content_hash}"
            for passage in found.passages
        }
        searched = {"status": found.status, "sources": sorted(versions)}
        record(connection, run["question_id"], "retrieve", searched)
    return {
        "search_status": found.status,
        "passages": [asdict(passage) for passage in found.passages],
    }


def due_at(queue: str | None) -> str | None:
    minutes = load_policy()["queues"][queue]["due_minutes"] if queue else None
    if minutes is None:
        return None
    due = datetime.datetime.now(datetime.UTC) + datetime.timedelta(minutes=minutes)
    return due.isoformat()


def route(run: Run) -> dict:
    trace("route")
    queue, reasons = choose_queue(run, load_policy()["topics"])
    routed = {"queue": queue, "reasons": reasons, "topics": run.get("topics", [])}
    record_alone("graph", run["question_id"], "route", routed)
    return {"queue": queue, "reasons": reasons, "due_at": due_at(queue)}


def acknowledge(run: Run) -> dict:
    """Doctors get a pre-approved acknowledgment. Reps don't."""
    trace("acknowledge")
    doctor = run["requester"]["kind"] == "doctor"
    if doctor:
        gateway.send_acknowledgment(run["question_id"], run["queue"], run["due_at"])
    record_alone("graph", run["question_id"], "acknowledge", {"acknowledged": doctor})
    return {"acknowledged": doctor}


def citations(run: Run) -> list[dict]:
    cited = {chunk for sentence in run.get("draft", []) for chunk in sentence["cites"]}
    fields = ("chunk_id", "doc_id", "version", "content_hash")
    passages = [passage for passage in run["passages"] if passage["chunk_id"] in cited]
    return [{field: passage[field] for field in fields} for passage in passages]


def queue_item(run: Run) -> None:
    """Write or update the item, with an audit entry only when something changed."""
    question_id = run["question_id"]
    item_id = f"RV-{question_id}"
    draft_or_none = Jsonb(run["draft"]) if run.get("draft") else None
    item = (item_id, question_id, question_id, run["queue"], draft_or_none)
    rest = (Jsonb(citations(run)), run["reasons"], run["due_at"])
    with connect("graph") as connection:
        if connection.execute(UPSERT_ITEM, (*item, *rest)).fetchone():
            connection.execute(SET_STATUS, ("waiting", question_id))
            queued = {"item_id": item_id, "queue": run["queue"]}
            record(connection, question_id, "review_queued", queued)


def review(run: Run) -> dict:
    """Write the item first, so the reviewer CLI can see it, then pause. On resume this node runs
    again from the top, so writing the item must be safe to repeat."""
    trace("review")
    queue_item(run)
    answer = interrupt({"item_id": f"RV-{run['question_id']}", "queue": run["queue"]})
    with connect("graph") as connection:
        action = connection.execute(DECISION, (answer["decision_id"],)).fetchone()["action"]
        decided = {"decision_id": answer["decision_id"], "action": action}
        record(connection, run["question_id"], "review_decided", decided)
    return {"decision_id": answer["decision_id"], "decision_action": action}


def finish(question_id: str, status: str, entry_type: str, reasons: list[str]) -> None:
    """Close the item and the question, and record the final state, in one transaction."""
    with connect("graph") as connection:
        connection.execute(FINISH_ITEM, (status, reasons, f"RV-{question_id}"))
        connection.execute(SET_STATUS, (status, question_id))
        record(connection, question_id, entry_type, {"outcome": status, "reasons": reasons})


def send(run: Run) -> dict:
    trace("send")
    result = gateway.send_reply(run["question_id"])
    outcome = "sent" if result.sent else "send_refused"
    refusal = [] if result.sent else [result.reason]
    finish(run["question_id"], outcome, "send", refusal)
    return {"outcome": outcome, "reasons": run["reasons"] + refusal}


def close(run: Run) -> dict:
    """A reviewer's rejection, or a data steward closing an unresolved request."""
    trace("close")
    outcome = "closed" if run["decision_action"] == "close" else "rejected"
    finish(run["question_id"], outcome, "close", [])
    return {"outcome": outcome}


def redirect(run: Run) -> dict:
    """A rep asked an off-label question. The rep gets the pre-approved redirect, no answer."""
    trace("redirect")
    gateway.send_rep_redirect(run["question_id"])
    finish(run["question_id"], "rep_redirect", "redirect", run["reasons"])
    return {"outcome": "rep_redirect"}


def after_load(run: Run) -> str:
    # An unknown country gets no search and no medical answer: straight to the data steward.
    return "route" if run["requester"]["country"] is None else "extract_questions"


def after_topics(run: Run) -> str:
    """A rep's off-label question and a human-only topic get no search and no draft."""
    human_only = set(run["topics"]) & set(load_policy()["topics"]["human_only"])
    rep_off_label = run["requester"]["kind"] == "rep" and "off_label" in run["topics"]
    return "route" if human_only or rep_off_label else "retrieve"


def after_search(run: Run) -> str:
    # Nothing approved found: no SRD match and no draft. The route sends it to a writer.
    return "srd_match" if run["search_status"] == "found" else "route"


def after_route(run: Run) -> str:
    if run["queue"] is None:
        return "redirect"
    # An unresolved requester gets no acknowledgment: there is nobody verified to send it to.
    return "review" if run["queue"] == "identity_resolution" else "acknowledge"


NODES = (
    load_context,
    extract_questions,
    topic_check,
    retrieve,
    srd_match,
    draft,
    route,
    acknowledge,
    review,
    send,
    close,
    redirect,
)


def build_graph(saver: PostgresSaver):
    builder = StateGraph(Run)
    for node in NODES:
        builder.add_node(node.__name__, node)
    builder.add_edge(START, "load_context")
    builder.add_conditional_edges("load_context", after_load, ["route", "extract_questions"])
    builder.add_edge("extract_questions", "topic_check")
    builder.add_conditional_edges("topic_check", after_topics, ["route", "retrieve"])
    builder.add_conditional_edges("retrieve", after_search, ["srd_match", "route"])
    builder.add_edge("srd_match", "draft")
    builder.add_edge("draft", "route")
    builder.add_conditional_edges("route", after_route, ["redirect", "review", "acknowledge"])
    builder.add_edge("acknowledge", "review")
    # Setting a country sends the question back to the start, now that it has one.
    review_next = ["send", "close", "load_context"]
    builder.add_conditional_edges(
        "review", lambda run: NEXT_NODE[run["decision_action"]], review_next
    )
    for last in ("send", "close", "redirect"):
        builder.add_edge(last, END)
    return builder.compile(checkpointer=saver)


def summary(question_id: str, result: dict) -> str:
    if "__interrupt__" in result:
        acknowledged = " Acknowledgment sent." if result.get("acknowledged") else ""
        waiting = f"Waiting for review RV-{question_id}."
        return f"{question_id} → {result['queue']}.{acknowledged} {waiting}"
    if result["outcome"] == "sent":
        return f"{question_id} → sent as M-{question_id}."
    if result["outcome"] == "send_refused":
        return f"{question_id} → the gateway refused to send: {result['reasons'][-1]}."
    if result["outcome"] == "rep_redirect":
        return f"{question_id} → the rep was sent the redirect template, M-{question_id}."
    return f"{question_id} → {result['outcome']}."


def ask(question_id: str) -> str:
    config = {"configurable": {"thread_id": question_id}}
    with checkpointer() as saver:
        graph = build_graph(saver)
        if graph.get_state(config).values:
            return f"{question_id} was already asked. Use resume to carry on."
        return summary(question_id, graph.invoke({"question_id": question_id}, config))


def resume(question_id: str, decision_id: int | None) -> str:
    """Carry on a paused question with a recorded decision, in this process or any later one."""
    config = {"configurable": {"thread_id": question_id}}
    with checkpointer() as saver:
        graph = build_graph(saver)
        state = graph.get_state(config)
        if not state.values:
            return f"{question_id} hasn't been asked yet."
        if not state.next:
            return summary(question_id, state.values)
        # A decision this run already acted on is not an answer to the current pause.
        if decision_id is None or decision_id <= state.values.get("decision_id", 0):
            return f"RV-{question_id} is still waiting for a reviewer."
        result = graph.invoke(Command(resume={"decision_id": decision_id}), config)
    return summary(question_id, result)
