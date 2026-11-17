"""The graph's model steps: their prompts, and the checks each reply must pass.

Every step asks for JSON and checks it. A reply that isn't valid JSON, or names a topic, a document
or a section it wasn't given, raises InvalidReplyError, and the graph sends the question to a
human. The question's text is always data, never instructions: each prompt says so, and the text
sits inside tags.

The system prompts live in prompts/, shared by both solutions, because the replay key is a hash of
the prompt and must be the same in each. A changed prompt needs new recordings.
"""

import json
import re
from dataclasses import dataclass

from medinfo.model import Reply, Request, chat
from medinfo.policy import CASE_STUDY_DIR


def _prompt(name: str) -> str:
    """A system prompt from prompts/<name>.txt. Both solutions read the same files, so their
    prompts, and so their replay keys, are the same. The file's final newline is not part of it."""
    text = (CASE_STUDY_DIR / "prompts" / f"{name}.txt").read_text(encoding="utf-8")
    return text.removesuffix("\n")


EXTRACT = _prompt("extract_questions")
TOPICS = _prompt("topic_check")
SRD_MATCH = _prompt("srd_match")
ADAPT = _prompt("adapt_srd")
COMPOSE = _prompt("compose")
JUDGE = _prompt("judge")


COVERAGES = ("full", "partial", "none")
STATUSES = ("supported", "partly_supported", "unsupported")


class InvalidReplyError(Exception):
    """The model's reply didn't have the shape its step asked for."""


@dataclass(frozen=True)
class Answer:
    """A checked reply, and what the audit entry records about the call."""

    value: dict
    call: dict


def _ask(label: str, role: str, system: str, user: str) -> tuple[dict, Reply]:
    reply = chat(Request(label, role, system, user))
    # Some models wrap JSON in a code fence. The fence is not part of the answer.
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", reply.text.strip())
    try:
        value = json.loads(text)
    except json.JSONDecodeError as error:
        raise InvalidReplyError(f"{label}: the reply is not JSON") from error
    if not isinstance(value, dict):
        raise InvalidReplyError(f"{label}: the reply is not a JSON object")
    return value, reply


def _answer(value: dict, reply: Reply, role: str) -> Answer:
    call = {"model_role": role, "model": reply.model, "usage": reply.usage}
    return Answer(value, call)


def message(text: str) -> str:
    return f"<message>\n{text}\n</message>"


def extract_questions(question_id: str, text: str) -> Answer:
    value, reply = _ask(f"{question_id}.extract_questions", "fast", EXTRACT, message(text))
    questions = value.get("questions")
    valid = isinstance(questions, list) and 0 < len(questions) <= 5
    if not valid or not all(
        isinstance(question, str) and question.strip() for question in questions
    ):
        raise InvalidReplyError(f"{question_id}.extract_questions: expected 1 to 5 questions")
    return _answer({"questions": questions}, reply, "fast")


def topic_check(question_id: str, text: str, allowed: list[str]) -> Answer:
    value, reply = _ask(f"{question_id}.topic_check", "fast", TOPICS, message(text))
    topics = value.get("topics")
    if not isinstance(topics, list) or not set(topics) <= set(allowed):
        raise InvalidReplyError(f"{question_id}.topic_check: topics must come from the list")
    return _answer({"topics": sorted(set(topics))}, reply, "fast")


def asked(questions: list[str]) -> str:
    return "<questions>\n" + "\n".join(f"- {question}" for question in questions) + "\n</questions>"


def sections(passages: list[dict], tag: str) -> str:
    """Each passage with its id, the document and section it comes from, and its words."""
    blocks = [
        f'<{tag} id="{passage["chunk_id"]}" '
        f'document="{passage["doc_id"]}@{passage["version"]}" '
        f'section="{passage["section"]}">\n{passage["text"]}\n</{tag}>'
        for passage in passages
    ]
    return "\n".join(blocks)


def srd_match(question_id: str, questions: list[str], srd_passages: list[dict]) -> Answer:
    user = f"{asked(questions)}\n{sections(srd_passages, 'srd_section')}"
    value, reply = _ask(f"{question_id}.srd_match", "fast", SRD_MATCH, user)
    coverage = value.get("coverage")
    document = _named_document(value.get("doc_id"), srd_passages)
    if coverage not in COVERAGES or (coverage != "none" and document is None):
        raise InvalidReplyError(f"{question_id}.srd_match: unknown coverage or document")
    matched = {"document": document if coverage != "none" else None, "coverage": coverage}
    return _answer(matched, reply, "fast")


def _named_document(named: object, srd_passages: list[dict]) -> str | None:
    """The SRD the reply names, as doc_id@version. The prompt shows it that way, but a bare
    doc_id is fine too when only one version of it was given."""
    documents = {
        f"{passage['doc_id']}@{passage['version']}": passage["doc_id"] for passage in srd_passages
    }
    if named in documents:
        return named
    versions = [key for key, doc_id in documents.items() if doc_id == named]
    return versions[0] if len(versions) == 1 else None


def write_draft(question_id: str, questions: list[str], passages: list[dict], adapt: bool):
    """adapt_srd when one SRD fully answers the questions, compose otherwise. Both cite sections."""
    step, system = ("adapt_srd", ADAPT) if adapt else ("compose", COMPOSE)
    user = f"{asked(questions)}\n{sections(passages, 'passage')}"
    value, reply = _ask(f"{question_id}.{step}", "smart", system, user)
    given = {passage["chunk_id"] for passage in passages}
    sentences = value.get("sentences")
    if not isinstance(sentences, list) or not sentences:
        raise InvalidReplyError(f"{question_id}.{step}: expected sentences")
    for sentence in sentences:
        valid = isinstance(sentence, dict) and isinstance(sentence.get("text"), str)
        cites = sentence.get("cites") if valid else None
        if not isinstance(cites, list) or not cites or not set(cites) <= given:
            raise InvalidReplyError(
                f"{question_id}.{step}: every sentence must cite a given section"
            )
    drafted = [
        {"text": sentence["text"], "cites": list(sentence["cites"])} for sentence in sentences
    ]
    return _answer({"draft": drafted, "step": step}, reply, "smart")


def numbered(sentences: list[dict]) -> str:
    lines = [
        f"{number}. {sentence['text']} [cites: {', '.join(sentence['cites'])}]"
        for number, sentence in enumerate(sentences, start=1)
    ]
    return "<draft>\n" + "\n".join(lines) + "\n</draft>"


def cited_sections(sentences: list[dict], passages: dict[str, str]) -> str:
    """Each cited section once, in the order the draft first cites it."""
    cited = dict.fromkeys(chunk for sentence in sentences for chunk in sentence["cites"])
    blocks = [
        f'<section id="{chunk}">\n{passages[chunk]}\n</section>'
        for chunk in cited
        if chunk in passages
    ]
    return "\n".join(blocks)


def judge(question_id: str, step: str, sentences: list[dict], passages: dict[str, str]) -> Answer:
    """One claim per sentence, in order, each with a status and a quote."""
    user = f"{numbered(sentences)}\n{cited_sections(sentences, passages)}"
    value, reply = _ask(f"{question_id}.{step}", "judge", JUDGE, user)
    claims = value.get("claims")
    expected = list(range(1, len(sentences) + 1))
    if not isinstance(claims, list) or not all(isinstance(claim, dict) for claim in claims):
        raise InvalidReplyError(f"{question_id}.{step}: expected a list of claims")
    if [claim.get("sentence") for claim in claims] != expected:
        raise InvalidReplyError(f"{question_id}.{step}: expected one claim per sentence, in order")
    for claim in claims:
        if claim.get("status") not in STATUSES or not isinstance(claim.get("quote"), str):
            raise InvalidReplyError(f"{question_id}.{step}: each claim needs a status and a quote")
    return _answer({"claims": claims}, reply, "judge")
