"""What the graph carries from node to node for one question, and the line each node prints."""

from typing import TypedDict


class Run(TypedDict, total=False):
    question_id: str
    requester: dict
    question_text: str
    questions: list[str]
    topics: list[str]
    search_status: str | None
    passages: list[dict]
    srd_match: dict | None
    draft: list[dict]
    model_problems: list[str]
    queue: str | None
    reasons: list[str]
    due_at: str | None
    decision_id: int
    decision_action: str
    acknowledged: bool
    outcome: str


def trace(node: str) -> None:
    """One line per node that runs, so a resume can be seen not to start over."""
    print(f"  node {node}", flush=True)
