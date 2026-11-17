"""The safety scan: a fixed step that runs before the graph, as its own role.

A question that contains one of policy.yaml's safety_terms, at the start of a word, gets exactly
one safety packet. The packet keeps the reporter's exact words, and its Day 0 is when the
question was received. The packet, the medical zone's marker and the audit entry commit together.

The question id is the idempotency key, so running the scan again writes nothing.

Rules only: a keyword list misses unlisted words and indirect descriptions (trap T16). It is not
suitable for real safety intake.
"""

import re
from dataclasses import dataclass

from medinfo.audit import record
from medinfo.database import connect
from medinfo.policy import load_policy

LOCK = "select pg_advisory_xact_lock(hashtext(%s))"
QUESTION = "select text, received_at from medical.questions where id = %s"
SCANNED = "select 1 from audit.entries where question_id = %s and type = 'safety_scan'"
PACKET_OF = "select id from safety.packets where question_id = %s"
INSERT_PACKET = """insert into safety.packets
  (id, question_id, verbatim_text, received_at, matched_terms) values (%s, %s, %s, %s, %s)
  on conflict (question_id) do nothing"""
INSERT_MARKER = "insert into medical.safety_markers (question_id, packet_id) values (%s, %s)"


@dataclass(frozen=True)
class Scan:
    packet_id: str | None
    already_scanned: bool


def matched_terms(text: str, terms: list[str]) -> list[str]:
    """The configured terms the text contains, each at the start of a word ("pregnan" matches
    "pregnant", "rash" doesn't match "crash")."""
    return [term for term in terms if re.search(r"\b" + re.escape(term), text, re.IGNORECASE)]


def scan(question_id: str) -> Scan:
    terms = load_policy()["safety_terms"]
    with connect("safety_scan") as connection:
        # Two scans of one question take turns, so the second always sees the first's work.
        connection.execute(LOCK, (question_id,))
        if connection.execute(SCANNED, (question_id,)).fetchone():
            packet = connection.execute(PACKET_OF, (question_id,)).fetchone()
            return Scan(packet["id"] if packet else None, already_scanned=True)
        question = connection.execute(QUESTION, (question_id,)).fetchone()
        matched = matched_terms(question["text"], terms)
        packet_id = f"SP-{question_id}" if matched else None
        if packet_id:
            values = (packet_id, question_id, question["text"], question["received_at"], matched)
            connection.execute(INSERT_PACKET, values)
            connection.execute(INSERT_MARKER, (question_id, packet_id))
        record(connection, question_id, "safety_scan", {"packet_id": packet_id})
    return Scan(packet_id, already_scanned=False)
