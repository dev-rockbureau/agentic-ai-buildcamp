"""The Medical Question Helper as a LangGraph graph, with Postgres checkpoints.

A question runs until it waits for a reviewer, then the process may exit or be killed. The
checkpoint keeps the run, and any later process resumes it on the same thread_id (the question
id). Nothing reaches a doctor except through the gateway, after a signed decision.

Step 3 of the build plan: `draft` and `route` are placeholders. Step 5 replaces the draft with the
model nodes, and step 6 replaces the route with the verifier's.
"""

import datetime
import re
from dataclasses import asdict
from typing import TypedDict

from langgraph.checkpoint.postgres import PostgresSaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command, interrupt
from psycopg.types.json import Jsonb

from medinfo import gateway, knowledge_service
from medinfo.database import checkpointer, connect
from medinfo.policy import load_policy
from medinfo.profile_service import Requester, medical_view

QUESTION = "select requester_id, text from medical.questions where id = %s"
INSERT_ITEM = """insert into review.items
  (id, thread_id, question_id, queue, draft, citations, reasons, due_at)
  values (%s, %s, %s, %s, %s, %s, %s, %s) on conflict (id) do nothing"""
DECISION = "select action from review.decisions where id = %s"
FINISH_ITEM = "update review.items set status = %s, reasons = reasons || %s where id = %s"
FINISH_QUESTION = "update medical.questions set status = %s where id = %s"


class Run(TypedDict, total=False):
    question_id: str
    requester: dict
    question_text: str
    search_status: str
    passages: list[dict]
    draft: list[dict]
    queue: str
    reasons: list[str]
    due_at: str | None
    decision_id: int
    outcome: str


def trace(node: str) -> None:
    """One line per node that runs, so a resume can be seen not to start over."""
    print(f"  node {node}", flush=True)


def load_context(run: Run) -> dict:
    trace("load_context")
    with connect("graph") as connection:
        question = connection.execute(QUESTION, (run["question_id"],)).fetchone()
        requester = medical_view(connection, question["requester_id"])
    return {"requester": asdict(requester), "question_text": question["text"]}


def retrieve(run: Run) -> dict:
    trace("retrieve")
    requester = Requester(**run["requester"])
    with connect("graph") as connection:
        found = knowledge_service.search(connection, run["question_text"], requester, load_policy())
    return {
        "search_status": found.status,
        "passages": [asdict(passage) for passage in found.passages],
    }


def first_sentence(text: str) -> str:
    return re.split(r"(?<=[.!?])\s", text.strip(), maxsplit=1)[0]


def draft(run: Run) -> dict:
    """Placeholder until step 5: the opening sentence of each of the two best passages, each
    citing its own section. It is enough to exercise review, signing and the gateway."""
    trace("draft")
    best = run["passages"][:2]
    return {
        "draft": [
            {"text": first_sentence(passage["text"]), "cites": [passage["chunk_id"]]}
            for passage in best
        ]
    }


def due_at(queue: str) -> str | None:
    minutes = load_policy()["queues"][queue]["due_minutes"]
    if minutes is None:
        return None
    due = datetime.datetime.now(datetime.UTC) + datetime.timedelta(minutes=minutes)
    return due.isoformat()


def route(run: Run) -> dict:
    """Placeholder until step 6, which routes on topics, the SRD match and the verifier."""
    trace("route")
    queue, reasons = {
        "country_unknown": ("identity_resolution", ["country unknown"]),
        "nothing_found": ("writer_needed", ["no approved answer"]),
    }.get(run["search_status"], ("light_check", ["placeholder route (step 3)"]))
    return {"queue": queue, "reasons": reasons, "due_at": due_at(queue)}


def acknowledge(run: Run) -> dict:
    """Doctors get a pre-approved acknowledgment. Reps and unresolved requesters don't."""
    trace("acknowledge")
    if run["requester"]["kind"] == "doctor":
        gateway.send_acknowledgment(run["question_id"], run["queue"], run["due_at"])
    return {}


def citations(run: Run) -> list[dict]:
    cited = {chunk for sentence in run.get("draft", []) for chunk in sentence["cites"]}
    fields = ("chunk_id", "doc_id", "version", "content_hash")
    passages = [passage for passage in run["passages"] if passage["chunk_id"] in cited]
    return [{field: passage[field] for field in fields} for passage in passages]


def review(run: Run) -> dict:
    """Write the item first, so the reviewer CLI can see it, then pause. On resume this node runs
    again from the top, so the insert must be safe to repeat."""
    trace("review")
    question_id = run["question_id"]
    item_id = f"RV-{question_id}"
    draft_or_none = Jsonb(run["draft"]) if run.get("draft") else None
    item = (item_id, question_id, question_id, run["queue"], draft_or_none)
    rest = (Jsonb(citations(run)), run["reasons"], run["due_at"])
    with connect("graph") as connection:
        connection.execute(INSERT_ITEM, (*item, *rest))
    answer = interrupt({"item_id": item_id, "queue": run["queue"]})
    return {"decision_id": answer["decision_id"]}


def after_review(run: Run) -> str:
    with connect("graph") as connection:
        decision = connection.execute(DECISION, (run["decision_id"],)).fetchone()
    return "send" if decision["action"] == "approve" else "close"


def finish(question_id: str, status: str, reasons: list[str]) -> None:
    with connect("graph") as connection:
        connection.execute(FINISH_ITEM, (status, reasons, f"RV-{question_id}"))
        connection.execute(FINISH_QUESTION, (status, question_id))


def send(run: Run) -> dict:
    trace("send")
    result = gateway.send_reply(run["question_id"])
    outcome = "sent" if result.sent else "send_refused"
    refusal = [] if result.sent else [result.reason]
    finish(run["question_id"], outcome, refusal)
    return {"outcome": outcome, "reasons": run["reasons"] + refusal}


def close(run: Run) -> dict:
    trace("close")
    finish(run["question_id"], "rejected", [])
    return {"outcome": "rejected"}


def build_graph(saver: PostgresSaver):
    builder = StateGraph(Run)
    for node in (load_context, retrieve, draft, route, acknowledge, review, send, close):
        builder.add_node(node.__name__, node)
    builder.add_edge(START, "load_context")
    builder.add_edge("load_context", "retrieve")
    builder.add_edge("retrieve", "draft")
    builder.add_edge("draft", "route")
    # An unresolved requester gets no acknowledgment: there is nobody verified to send it to.
    builder.add_conditional_edges(
        "route", lambda run: "review" if run["queue"] == "identity_resolution" else "acknowledge"
    )
    builder.add_edge("acknowledge", "review")
    builder.add_conditional_edges("review", after_review, ["send", "close"])
    builder.add_edge("send", END)
    builder.add_edge("close", END)
    return builder.compile(checkpointer=saver)


def summary(question_id: str, result: dict) -> str:
    if "__interrupt__" in result:
        doctor = result["requester"]["kind"] == "doctor"
        acknowledged = " Acknowledgment sent." if doctor else ""
        waiting = f"Waiting for review RV-{question_id}."
        return f"{question_id} → {result['queue']}.{acknowledged} {waiting}"
    if result["outcome"] == "sent":
        return f"{question_id} → sent as M-{question_id}."
    if result["outcome"] == "send_refused":
        return f"{question_id} → the gateway refused to send: {result['reasons'][-1]}."
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
        if decision_id is None:
            return f"RV-{question_id} is still waiting for a reviewer."
        result = graph.invoke(Command(resume={"decision_id": decision_id}), config)
    return summary(question_id, result)
