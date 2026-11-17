"""The nodes that work out an answer: the model steps, and the route that picks a queue.

A model step whose reply doesn't validate never stops the question. The step falls back to a
safe value, records the problem, and the route sends the question to full review. Model
confidence is never used: the route reads topics, the SRD match and (from step 6) the verifier.
"""

import re
from functools import partial

from medinfo import model_steps
from medinfo.audit import record_alone
from medinfo.policy import load_policy
from medinfo.run_state import Run, trace

# A model call's details for the audit entry, and the problem when its reply didn't validate.
CallResult = tuple[dict, str | None]


def _ask_model(name: str, ask, fallback: dict) -> tuple[dict, dict, str | None]:
    """The checked reply and its call details, or the fallback and the problem."""
    try:
        answer = ask()
    except model_steps.InvalidReplyError as error:
        return fallback, {}, str(error)
    return answer.value, answer.call, None


def _finish_step(run: Run, name: str, outcome: dict, details: CallResult) -> dict:
    """Record the step in the audit chain and add any problem to the run's list."""
    call, problem = details
    record_alone("graph", run["question_id"], name, {**outcome, **call, "problem": problem})
    problems = run.get("model_problems", []) + ([problem] if problem else [])
    return {**outcome, "model_problems": problems}


def extract_questions(run: Run) -> dict:
    trace("extract_questions")
    question_id, text = run["question_id"], run["question_text"]
    ask = partial(model_steps.extract_questions, question_id, text)
    value, call, problem = _ask_model("extract_questions", ask, {"questions": [text]})
    return _finish_step(run, "extract_questions", value, (call, problem))


def rule_topics(text: str, rules: dict) -> list[str]:
    """Keyword rules from policy.yaml, each term at the start of a word."""

    def matches(term: str) -> bool:
        return re.search(r"\b" + re.escape(term), text, re.IGNORECASE) is not None

    return [topic for topic, terms in rules.items() if any(matches(term) for term in terms)]


def topic_check(run: Run) -> dict:
    """The model's topics joined with the keyword rules', so either one can flag a topic."""
    trace("topic_check")
    topics = load_policy()["topics"]
    allowed = topics["escalate_with_draft"] + topics["human_only"]
    question_id, text = run["question_id"], run["question_text"]
    ask = partial(model_steps.topic_check, question_id, text, allowed)
    value, call, problem = _ask_model("topic_check", ask, {"topics": []})
    by_rules = rule_topics(text, topics["rules"])
    joined = {"topics": sorted(set(value["topics"]) | set(by_rules))}
    outcome = {**joined, "by_model": value["topics"], "by_rules": by_rules}
    return {**_finish_step(run, "topic_check", outcome, (call, problem)), **joined}


def srd_match(run: Run) -> dict:
    """Does one SRD fully answer the questions? No SRD among the passages means no."""
    trace("srd_match")
    srd_passages = [passage for passage in run["passages"] if passage["kind"] == "srd"]
    if not srd_passages:
        none = {"srd_match": {"document": None, "coverage": "none"}}
        return _finish_step(run, "srd_match", none, ({}, None))
    question_id, questions = run["question_id"], run["questions"]
    ask = partial(model_steps.srd_match, question_id, questions, srd_passages)
    fallback = {"document": None, "coverage": "none"}
    value, call, problem = _ask_model("srd_match", ask, fallback)
    return _finish_step(run, "srd_match", {"srd_match": value}, (call, problem))


def draft(run: Run) -> dict:
    """adapt_srd from the one SRD that fully answers, or compose from every passage."""
    trace("draft")
    match = run["srd_match"]
    adapt = match["coverage"] == "full"
    passages = run["passages"]
    if adapt:
        chosen = match["document"]
        passages = [
            passage for passage in passages if f"{passage['doc_id']}@{passage['version']}" == chosen
        ]
    question_id, questions = run["question_id"], run["questions"]
    ask = partial(model_steps.write_draft, question_id, questions, passages, adapt)
    value, call, problem = _ask_model("draft", ask, {"draft": [], "step": None})
    return _finish_step(run, "draft", value, (call, problem))


def choose_queue(run: Run, topics_policy: dict) -> tuple[str | None, list[str]]:
    """Where the question goes, and why. None means the rep redirect template, with no review."""
    requester, topics = run["requester"], run.get("topics", [])
    if requester["country"] is None:
        return "identity_resolution", ["country unknown"]
    if requester["kind"] == "rep" and "off_label" in topics:
        return None, ["off-label question from a rep: redirect template"]
    human_only = [topic for topic in topics if topic in topics_policy["human_only"]]
    if human_only:
        return "human_only", [f"topic: {topic}" for topic in human_only]
    if run.get("search_status") == "nothing_found":
        return "writer_needed", ["no approved answer"]
    if run.get("model_problems"):
        return "full_review", run["model_problems"]
    flagged = [topic for topic in topics if topic in topics_policy["escalate_with_draft"]]
    if flagged:
        return "full_review", [f"topic: {topic}" for topic in flagged]
    if run["srd_match"]["coverage"] != "full":
        return "full_review", [f"SRD coverage: {run['srd_match']['coverage']}"]
    return "light_check", ["one SRD fully answers it, and no topic is flagged"]
