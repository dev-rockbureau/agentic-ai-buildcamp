"""The reviewer CLI's side: show what waits, and record a signed decision. It runs as the
reviewer_cli role, which can record decisions but can't send anything.

The PIN is checked here and never enters the graph's state, so it is never written to a
checkpoint. The graph is resumed with the decision's id only.
"""

import hmac

import psycopg

from medinfo.database import connect
from medinfo.knowledge_service import current_version, why_not_allowed
from medinfo.policy import load_policy
from medinfo.profile_service import Requester, medical_view
from medinfo.signature import MEANING, draft_text, pin_hash, signature_hash, source_key

ITEM = """select i.id, i.question_id, i.queue, i.draft, i.citations, i.reasons, i.status,
  i.due_at, q.requester_id, q.text as question
  from review.items i join medical.questions q on q.id = i.question_id where i.id = %s"""
WAITING = """select id, queue, due_at from review.items where status = 'waiting'
  order by due_at nulls last, id"""
REVIEWER = "select id, role, countries, pin_hash from review.reviewers where id = %s"
DECIDED = """select 1 from review.decisions
  where item_id = %s and action in ('approve', 'reject')"""
LATEST = "select id from review.decisions where item_id = %s order by id desc limit 1"
INSERT = """insert into review.decisions (item_id, reviewer_id, action, reason_code, final_text,
  meaning, signed_sources, signature_hash) values (%s, %s, %s, %s, %s, %s, %s, %s) returning id"""


class RefusedError(Exception):
    """A decision this reviewer may not record. Nothing was written."""


def _item(connection: psycopg.Connection, item_id: str) -> dict:
    item = connection.execute(ITEM, (item_id,)).fetchone()
    if item is None:
        raise RefusedError(f"No review item {item_id}.")
    if item["status"] != "waiting" or connection.execute(DECIDED, (item_id,)).fetchone():
        raise RefusedError(f"{item_id} has already been decided.")
    return item


def _check_reviewer(connection: psycopg.Connection, item: dict, reviewer_id: str, pin: str):
    """Only a reviewer with the queue's role, for the requester's country, with the right PIN."""
    reviewer = connection.execute(REVIEWER, (reviewer_id,)).fetchone()
    expected = reviewer["pin_hash"] if reviewer else ""
    if not hmac.compare_digest(expected, pin_hash(reviewer_id, pin)):
        raise RefusedError("Unknown reviewer or wrong PIN.")
    needed = load_policy()["queues"][item["queue"]]["role"]
    if reviewer["role"] != needed:
        raise RefusedError(f"The {item['queue']} queue needs a {needed}. {reviewer_id} is not one.")
    country = medical_view(connection, item["requester_id"]).country
    if needed != "data_steward" and country not in reviewer["countries"]:
        raise RefusedError(f"{reviewer_id} doesn't review for {country}.")


def _signed_sources(connection: psycopg.Connection, item: dict, requester: Requester) -> list:
    """Every cited version, as it stands now. It must still be allowed and unchanged."""
    policy = load_policy()
    keys = set()
    for citation in item["citations"]:
        document = current_version(connection, citation["doc_id"], citation["version"])
        key = f"{citation['doc_id']}@{citation['version']}"
        problem = "is missing" if document is None else why_not_allowed(document, requester, policy)
        if problem:
            raise RefusedError(f"Can't sign: {problem}. The draft must be redone.")
        if document["content_hash"] != citation["content_hash"]:
            raise RefusedError(f"Can't sign: {key} changed after the draft was written.")
        keys.add(source_key(document["doc_id"], document["version"], document["content_hash"]))
    return sorted(keys)


def approve(item_id: str, reviewer_id: str, pin: str) -> int:
    """Sign the draft as it stands and record the decision. Returns the decision's id."""
    with connect("reviewer_cli") as connection:
        item = _item(connection, item_id)
        _check_reviewer(connection, item, reviewer_id, pin)
        if not item["draft"]:
            raise RefusedError(f"{item_id} has no draft to approve.")
        requester = medical_view(connection, item["requester_id"])
        sources = _signed_sources(connection, item, requester)
        text = draft_text(item["draft"])
        signed = (text, MEANING, sources, signature_hash(text, sources))
        row = connection.execute(INSERT, (item_id, reviewer_id, "approve", None, *signed))
        return row.fetchone()["id"]


def reject(item_id: str, reviewer_id: str, pin: str, reason: str) -> int:
    with connect("reviewer_cli") as connection:
        item = _item(connection, item_id)
        _check_reviewer(connection, item, reviewer_id, pin)
        values = (item_id, reviewer_id, "reject", reason, None, None, None, None)
        return connection.execute(INSERT, values).fetchone()["id"]


def latest_decision(item_id: str) -> int | None:
    with connect("reviewer_cli") as connection:
        row = connection.execute(LATEST, (item_id,)).fetchone()
    return row["id"] if row else None


def waiting() -> list[dict]:
    with connect("reviewer_cli") as connection:
        return connection.execute(WAITING).fetchall()


def show(item_id: str) -> str:
    with connect("reviewer_cli") as connection:
        item = connection.execute(ITEM, (item_id,)).fetchone()
    if item is None:
        raise RefusedError(f"No review item {item_id}.")
    lines = [
        f"{item['id']}  queue {item['queue']}  status {item['status']}  due {item['due_at']}",
        f"Question {item['question_id']}: {item['question']}",
        f"Why this queue: {', '.join(item['reasons']) or 'none'}",
        "Draft:" if item["draft"] else "No draft. A writer must answer from scratch.",
    ]
    for sentence in item["draft"] or []:
        lines.append(f"  {sentence['text']}  [{', '.join(sentence['cites'])}]")
    return "\n".join(lines)
