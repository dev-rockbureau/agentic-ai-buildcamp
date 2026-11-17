"""python -m medinfo <command>

search <question_id>                       the approved passages search returns, as JSON
scan <question_id>                         the safety scan alone (safe to run again)
ask <question_id>                          the safety scan, then the graph until it waits for review
resume <question_id>                       carry on a paused question with its recorded decision
review list                                the items waiting for review
review show <item_id>                      one item: question, queue, draft and citations
review approve <item_id> --reviewer <id>   sign the draft, then resume the question
review sign <item_id> --reviewer <id>      sign only; `resume` sends it later
review reject <item_id> --reviewer <id> --reason <text>
review set-country <item_id> --reviewer <id> --country <code>   data steward: run it again
review close <item_id> --reviewer <id> --reason <text>          data steward: no answer is sent

Every review decision asks for the reviewer's PIN at a hidden prompt (or reads it from standard
input when that isn't a terminal).
"""

import argparse
import getpass
import json
import sys
from dataclasses import asdict

from medinfo import graph, knowledge_service, review_service, safety_scan
from medinfo.database import connect
from medinfo.policy import load_policy
from medinfo.profile_service import medical_view

QUESTION = "select requester_id, text from medical.questions where id = %s"


def search_command(question_id: str) -> dict:
    policy = load_policy()
    with connect("graph") as connection:
        question = connection.execute(QUESTION, (question_id,)).fetchone()
        if question is None:
            raise LookupError(f"No question with id {question_id}")
        requester = medical_view(connection, question["requester_id"])
        result = knowledge_service.search(connection, question["text"], requester, policy)
    return {
        "question_id": question_id,
        "requester": asdict(requester),
        "status": result.status,
        "passages": [asdict(passage) for passage in result.passages],
    }


def read_pin() -> str:
    if sys.stdin.isatty():
        return getpass.getpass("PIN: ")
    return sys.stdin.readline().strip()


def question_of(item_id: str) -> str:
    return item_id.removeprefix("RV-")


def scan_command(question_id: str) -> str:
    scanned = safety_scan.scan(question_id)
    if scanned.already_scanned:
        return f"{question_id} was already scanned. Nothing new written."
    if scanned.packet_id:
        return f"Safety packet {scanned.packet_id} written."
    return "No configured safety term found."


def ask_command(question_id: str) -> str:
    """The safety scan runs first and on its own, so no route through the graph can skip it."""
    return f"{scan_command(question_id)}\n{graph.ask(question_id)}"


# What each decision needs besides the reviewer and PIN, and what the CLI says once it's recorded.
DECISIONS = {
    "approve": (review_service.approve, None, "Signed"),
    "sign": (review_service.approve, None, "Signed"),
    "reject": (review_service.reject, "reason", "Rejected"),
    "set-country": (review_service.set_country, "country", "Country set"),
    "close": (review_service.close, "reason", "Closed"),
}


def decide(arguments: argparse.Namespace) -> str:
    record, needs, done = DECISIONS[arguments.action]
    extra = [getattr(arguments, needs)] if needs else []
    if needs and not extra[0]:
        raise review_service.RefusedError(f"review {arguments.action} needs --{needs}.")
    record(arguments.item_id, arguments.reviewer, read_pin(), *extra)
    said = f"{done} by {arguments.reviewer}."
    if arguments.action == "sign":
        return f"{said} Run resume {question_of(arguments.item_id)} to send it."
    return f"{said}\n{resume_command(question_of(arguments.item_id))}"


def resume_command(question_id: str) -> str:
    return graph.resume(question_id, review_service.latest_decision(f"RV-{question_id}"))


def list_command() -> str:
    items = review_service.waiting()
    rows = [f"{item['id']}  {item['queue']}  due {item['due_at']}" for item in items]
    return "\n".join(rows) or "Nothing is waiting for review."


def parser() -> argparse.ArgumentParser:
    top = argparse.ArgumentParser(prog="medinfo", description=__doc__.splitlines()[0])
    commands = top.add_subparsers(dest="command", required=True)
    for name in ("search", "scan", "ask", "resume"):
        commands.add_parser(name).add_argument("question_id")
    review = commands.add_parser("review").add_subparsers(dest="action", required=True)
    review.add_parser("list")
    review.add_parser("show").add_argument("item_id")
    for action in DECISIONS:
        decision = review.add_parser(action)
        decision.add_argument("item_id")
        decision.add_argument("--reviewer", required=True)
        decision.add_argument("--reason")
        decision.add_argument("--country")
    return top


def run(arguments: argparse.Namespace) -> str:
    if arguments.command == "search":
        return json.dumps(search_command(arguments.question_id), indent=2)
    if arguments.command == "scan":
        return scan_command(arguments.question_id)
    if arguments.command == "ask":
        return ask_command(arguments.question_id)
    if arguments.command == "resume":
        return resume_command(arguments.question_id)
    if arguments.action == "list":
        return list_command()
    if arguments.action == "show":
        return review_service.show(arguments.item_id)
    return decide(arguments)


def main(argv: list[str]) -> int:
    try:
        print(run(parser().parse_args(argv)), flush=True)
    except review_service.RefusedError as refused:
        print(f"Refused: {refused}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
