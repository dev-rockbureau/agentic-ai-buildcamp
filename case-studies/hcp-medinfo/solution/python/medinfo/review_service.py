"""The reviewer CLI's side: show what waits, and record a signed decision. It runs as the
reviewer_cli role, which can record decisions but can't send anything. The data steward's two
actions run as steward_cli, the only role that may set a doctor's country.

The PIN is checked here and never enters the graph's state, so it is never written to a
checkpoint. The graph is resumed with the decision's id only.

Signing covers the exact final words. An edit is verified again before it can be signed, and
every flag on the final words, from the draft or from the edit, needs an override reason.
"""

import difflib
import hmac
from dataclasses import dataclass, field

import psycopg
from psycopg.types.json import Jsonb

from medinfo import verifier
from medinfo.audit import record
from medinfo.database import connect
from medinfo.knowledge_service import current_version, why_not_allowed
from medinfo.policy import load_policy
from medinfo.profile_service import Requester, medical_view
from medinfo.signature import MEANING, draft_text, pin_hash, signature_hash, source_key

ITEM = """select i.id, i.question_id, i.queue, i.draft, i.citations, i.verifier, i.reasons,
  i.status, i.due_at, q.requester_id, q.text as question
  from review.items i join medical.questions q on q.id = i.question_id where i.id = %s"""
WAITING = """select id, queue, due_at from review.items where status = 'waiting'
  order by due_at nulls last, id"""
REVIEWER = "select id, role, countries, pin_hash from review.reviewers where id = %s"
DECIDED = """select 1 from review.decisions
  where item_id = %s and action in ('approve', 'edit', 'reject', 'close')"""
SET_COUNTRY = "update shared.doctors set country = %s where id = %s and country is null"
LATEST = "select id from review.decisions where item_id = %s order by id desc limit 1"
CHUNKS = "select chunk_id, text from knowledge.chunks where chunk_id = any(%s)"
FIELDS = (
    "reason_code",
    "final_text",
    "diff",
    "meaning",
    "override_reasons",
    "final_sentences",
    "verification",
    "signed_sources",
    "signature_hash",
)
INSERT = f"""insert into review.decisions (item_id, reviewer_id, action, {", ".join(FIELDS)})
  values ({", ".join(["%s"] * (len(FIELDS) + 3))}) returning id"""


class RefusedError(Exception):
    """A decision this reviewer may not record. Nothing was written."""


class InvalidatedError(Exception):
    """A cited source was withdrawn or changed before signing. Nothing was signed. An
    invalidate decision was recorded, so the question is searched again and redrafted."""


@dataclass(frozen=True)
class Signer:
    reviewer_id: str
    pin: str


@dataclass(frozen=True)
class Signing:
    """Sentence edits (sentence number to new words) and override reasons for flags."""

    edits: dict[int, str] = field(default_factory=dict)
    overrides: dict[int, str] = field(default_factory=dict)


def _item(connection: psycopg.Connection, item_id: str) -> dict:
    item = connection.execute(ITEM, (item_id,)).fetchone()
    if item is None:
        raise RefusedError(f"No review item {item_id}.")
    if item["status"] != "waiting" or connection.execute(DECIDED, (item_id,)).fetchone():
        raise RefusedError(f"{item_id} has already been decided.")
    return item


def _check_reviewer(connection: psycopg.Connection, item: dict, signer: Signer):
    """Only a reviewer with the queue's role, for the requester's country, with the right PIN."""
    reviewer = connection.execute(REVIEWER, (signer.reviewer_id,)).fetchone()
    expected = reviewer["pin_hash"] if reviewer else ""
    if not hmac.compare_digest(expected, pin_hash(signer.reviewer_id, signer.pin)):
        raise RefusedError("Unknown reviewer or wrong PIN.")
    needed = load_policy()["queues"][item["queue"]]["role"]
    if reviewer["role"] != needed:
        raise RefusedError(
            f"The {item['queue']} queue needs a {needed}. {signer.reviewer_id} isn't."
        )
    country = medical_view(connection, item["requester_id"]).country
    if needed != "data_steward" and country not in reviewer["countries"]:
        raise RefusedError(f"{signer.reviewer_id} doesn't review for {country}.")


def _open(connection: psycopg.Connection, item_id: str, signer: Signer) -> dict:
    """The item, once the reviewer is allowed to decide it. Identity items are the data
    steward's, through the steward_cli role. Every other queue is a reviewer's."""
    item = _item(connection, item_id)
    _check_reviewer(connection, item, signer)
    steward_tool = connection.info.user == "steward_cli"
    if (item["queue"] == "identity_resolution") != steward_tool:
        tool = "review set-country or review close" if not steward_tool else "approve or reject"
        raise RefusedError(f"{item_id} is in the {item['queue']} queue. Use {tool}.")
    return item


def _decide(connection: psycopg.Connection, item: dict, decision: dict) -> int:
    """Record the decision and its audit entry in one transaction. Returns the decision's id."""
    values = (item["id"], decision["reviewer_id"], decision["action"])
    optional = (decision.get(name) for name in FIELDS)
    row = connection.execute(INSERT, (*values, *optional)).fetchone()
    entry = {key: decision.get(key) for key in ("reviewer_id", "action", "reason_code")}
    entry |= {"decision_id": row["id"], "signature_hash": decision.get("signature_hash")}
    if decision.get("override_reasons"):
        entry["override_reasons"] = decision["override_reasons"].obj
    record(connection, item["question_id"], "decision", entry)
    return row["id"]


def _source_problem(connection: psycopg.Connection, item: dict, requester: Requester):
    """Why a cited version can't be signed now, or None when every one still can."""
    policy = load_policy()
    for citation in item["citations"]:
        document = current_version(connection, citation["doc_id"], citation["version"])
        key = f"{citation['doc_id']}@{citation['version']}"
        if document is None:
            return f"{key} is missing"
        problem = why_not_allowed(document, requester, policy)
        if problem:
            return problem
        if document["content_hash"] != citation["content_hash"]:
            return f"{key} changed after the draft was written"
    return None


def _signed_sources(item: dict) -> list[str]:
    citations = item["citations"]
    keys = {
        source_key(citation["doc_id"], citation["version"], citation["content_hash"])
        for citation in citations
    }
    return sorted(keys)


def _final_sentences(item: dict, edits: dict[int, str]) -> list[dict]:
    sentences = [dict(sentence) for sentence in item["draft"]]
    for number, words in edits.items():
        if not 1 <= number <= len(sentences):
            raise RefusedError(f"The draft has no sentence {number}.")
        sentences[number - 1]["text"] = words
    return sentences


def _verification(connection: psycopg.Connection, item: dict, sentences: list[dict]) -> dict:
    """The draft's own verification when nothing was edited. An edit is verified again, on the
    exact words that will be signed."""
    if sentences == item["draft"]:
        return item["verifier"] or {"flags": []}
    cited = sorted({chunk for sentence in sentences for chunk in sentence["cites"]})
    rows = connection.execute(CHUNKS, (cited,)).fetchall()
    passages = {row["chunk_id"]: row["text"] for row in rows}
    return verifier.verify(item["question_id"], "verify_edit", sentences, passages)


def _require_overrides(verification: dict, overrides: dict[int, str]) -> dict[str, str]:
    """Every flag needs a reason. Returns the reasons for the flagged sentences."""
    flags = verification["flags"]
    missing = [flag for flag in flags if not overrides.get(flag["sentence"], "").strip()]
    if missing:
        lines = [f"  sentence {flag['sentence']}: {'; '.join(flag['reasons'])}" for flag in missing]
        hint = "Give a reason for each with --override <sentence>:<reason>."
        raise RefusedError("Can't sign while these are flagged:\n" + "\n".join(lines) + f"\n{hint}")
    return {str(flag["sentence"]): overrides[flag["sentence"]] for flag in flags}


def _difference(item: dict, sentences: list[dict]) -> str | None:
    before = [sentence["text"] for sentence in item["draft"]]
    after = [sentence["text"] for sentence in sentences]
    if before == after:
        return None
    return "\n".join(difflib.unified_diff(before, after, "draft", "signed", lineterm=""))


def _signature(connection: psycopg.Connection, item: dict, signer: Signer, signing: Signing):
    """The decision to record: the exact sentences, their verification, the overrides and the
    hash over the final words and the cited versions."""
    sentences = _final_sentences(item, signing.edits)
    verification = _verification(connection, item, sentences)
    overrides = _require_overrides(verification, signing.overrides)
    text, sources = draft_text(sentences), _signed_sources(item)
    return {
        "reviewer_id": signer.reviewer_id,
        "action": "edit" if signing.edits else "approve",
        "final_text": text,
        "diff": _difference(item, sentences),
        "meaning": MEANING,
        "override_reasons": Jsonb(overrides) if overrides else None,
        "final_sentences": Jsonb(sentences),
        "verification": Jsonb(verification),
        "signed_sources": sources,
        "signature_hash": signature_hash(text, sources),
    }


def sign(item_id: str, signer: Signer, signing: Signing) -> int:
    """Approve the draft, or edit and sign it. Returns the decision's id. If a cited source was
    withdrawn or changed, nothing is signed: the draft is invalidated and redone."""
    with connect("reviewer_cli") as connection:
        item = _open(connection, item_id, signer)
        if not item["draft"]:
            raise RefusedError(f"{item_id} has no draft to sign.")
        requester = medical_view(connection, item["requester_id"])
        gone = _source_problem(connection, item, requester)
        if gone is None:
            return _decide(connection, item, _signature(connection, item, signer, signing))
    with connect("reviewer_cli") as connection:
        item = _open(connection, item_id, signer)
        invalidated = {
            "reviewer_id": signer.reviewer_id,
            "action": "invalidate",
            "reason_code": gone,
        }
        _decide(connection, item, invalidated)
    raise InvalidatedError(f"Not signed: {gone}. The draft was invalidated and will be redone.")


def reject(item_id: str, signer: Signer, reason: str) -> int:
    with connect("reviewer_cli") as connection:
        item = _open(connection, item_id, signer)
        decision = {"reviewer_id": signer.reviewer_id, "action": "reject", "reason_code": reason}
        return _decide(connection, item, decision)


def set_country(item_id: str, signer: Signer, country: str) -> int:
    """The data steward sets an unknown country. The question then runs again from the start."""
    if country not in load_policy()["countries"]:
        raise RefusedError(f"{country} is not one of the countries in policy.yaml.")
    with connect("steward_cli") as connection:
        item = _open(connection, item_id, signer)
        if connection.execute(SET_COUNTRY, (country, item["requester_id"])).rowcount != 1:
            raise RefusedError(f"{item['requester_id']} already has a country.")
        decision = {
            "reviewer_id": signer.reviewer_id,
            "action": "set_country",
            "reason_code": country,
        }
        return _decide(connection, item, decision)


def close(item_id: str, signer: Signer, reason: str) -> int:
    """The data steward closes the question. No medical answer is sent. Its safety packet stays."""
    with connect("steward_cli") as connection:
        item = _open(connection, item_id, signer)
        decision = {"reviewer_id": signer.reviewer_id, "action": "close", "reason_code": reason}
        return _decide(connection, item, decision)


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
    for number, sentence in enumerate(item["draft"] or [], start=1):
        lines.append(f"  {number}. {sentence['text']}  [{', '.join(sentence['cites'])}]")
    for flag in (item["verifier"] or {}).get("flags", []):
        lines.append(f"  FLAG sentence {flag['sentence']}: {'; '.join(flag['reasons'])}")
    return "\n".join(lines)
