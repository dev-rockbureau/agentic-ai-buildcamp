"""The gateway: the only way out. Only its Postgres role may write to the outbox.

A reply goes out only when a qualified reviewer signed it and the signature still covers the exact
text being sent and the current version of every cited source. The checks and the insert run in
one serializable transaction, so a source withdrawn at the same moment can't slip through.
The unique key on (question_id, kind) makes a second send write nothing.
"""

from dataclasses import dataclass

import psycopg
from psycopg import IsolationLevel, errors

from medinfo.audit import record
from medinfo.database import connect
from medinfo.knowledge_service import current_version, why_not_allowed
from medinfo.policy import load_policy
from medinfo.profile_service import Requester, medical_view
from medinfo.signature import signature_hash, source_key

ATTEMPTS = 3

REQUESTER = "select requester_id from medical.questions where id = %s"
ITEM = "select id, citations from review.items where question_id = %s"
SIGNED = """select final_text, signature_hash, signed_sources from review.decisions
  where item_id = %s and action = 'approve' order by id desc limit 1"""
INSERT = """insert into outbox.messages (id, question_id, kind, recipient_id, text, signature_hash)
  values (%s, %s, %s, %s, %s, %s) on conflict do nothing"""

# The only text that may go out without a signature: a pre-approved acknowledgment.
ACKNOWLEDGMENT = (
    "Thank you for your question ({question_id}). A {queue} reviewer has it. "
    "We aim to reply by {due}."
)


@dataclass(frozen=True)
class Sent:
    sent: bool
    reason: str | None = None


def _requester(connection: psycopg.Connection, question_id: str) -> Requester:
    """The recipient is always the person who asked, read here, never passed in."""
    row = connection.execute(REQUESTER, (question_id,)).fetchone()
    return medical_view(connection, row["requester_id"])


def send_acknowledgment(question_id: str, queue: str, due_at: str | None) -> Sent:
    due = f"{due_at[:16].replace('T', ' ')} UTC" if due_at else "the end of the review"
    text = ACKNOWLEDGMENT.format(question_id=question_id, queue=queue.replace("_", " "), due=due)
    with connect("gateway") as connection:
        recipient = _requester(connection, question_id)
        message_id = f"A-{question_id}"
        values = (message_id, question_id, "acknowledgment", recipient.id, text, None)
        _insert_once(connection, question_id, values)
    return Sent(True)


def _insert_once(connection: psycopg.Connection, question_id: str, values: tuple) -> None:
    """Write the message and its audit entry. A repeat hits the unique key and writes neither."""
    if connection.execute(INSERT, values).rowcount == 1:
        message = {"message_id": values[0], "kind": values[2], "signature_hash": values[5]}
        record(connection, question_id, "message_sent", message)


def _current_sources(connection: psycopg.Connection, citations: list[dict]) -> list[dict | None]:
    cited = sorted({(citation["doc_id"], citation["version"]) for citation in citations})
    return [current_version(connection, doc_id, version) for doc_id, version in cited]


def _refusal(signed: dict, current: list[dict | None], requester: Requester, policy: dict):
    """Why this signed reply must not go out now, or None when it may."""
    if None in current:
        return "source_missing"
    keys = [source_key(doc["doc_id"], doc["version"], doc["content_hash"]) for doc in current]
    if signature_hash(signed["final_text"], keys) != signed["signature_hash"]:
        as_signed = signature_hash(signed["final_text"], signed["signed_sources"])
        return "source_changed" if as_signed == signed["signature_hash"] else "text_changed"
    problems = [why_not_allowed(document, requester, policy) for document in current]
    problems = [problem for problem in problems if problem]
    return f"source_not_allowed: {problems[0]}" if problems else None


def _checked_send(connection: psycopg.Connection, question_id: str, policy: dict) -> Sent:
    requester = _requester(connection, question_id)
    item = connection.execute(ITEM, (question_id,)).fetchone()
    signed = connection.execute(SIGNED, (item["id"],)).fetchone() if item else None
    if signed is None or signed["signature_hash"] is None:
        reason = "unsigned"
    else:
        current = _current_sources(connection, item["citations"])
        reason = _refusal(signed, current, requester, policy)
    if reason:
        # The refusal is recorded in the same transaction as the checks that made it.
        record(connection, question_id, "send_refused", {"reason": reason})
        return Sent(False, reason)
    values = (f"M-{question_id}", question_id, "reply", requester.id, signed["final_text"])
    _insert_once(connection, question_id, (*values, signed["signature_hash"]))
    return Sent(True)


def send_reply(question_id: str) -> Sent:
    """Send the signed reply for one question, or refuse and say why."""
    policy = load_policy()
    for attempt in range(ATTEMPTS):
        try:
            with connect("gateway") as connection:
                connection.isolation_level = IsolationLevel.SERIALIZABLE
                return _checked_send(connection, question_id, policy)
        except errors.SerializationFailure:
            # A withdrawal committed at the same moment. Try again, and see it this time.
            if attempt == ATTEMPTS - 1:
                raise
    raise AssertionError("unreachable")
