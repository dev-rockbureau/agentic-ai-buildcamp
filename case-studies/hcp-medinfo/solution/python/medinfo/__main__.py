"""python -m medinfo <command>

search <question_id>                       the approved passages search returns, as JSON
ask <question_id>                          run a question until it waits for review
resume <question_id>                       carry on a paused question with its recorded decision
review list                                the items waiting for review
review show <item_id>                      one item: question, queue, draft and citations
review approve <item_id> --reviewer <id>   sign the draft, then resume the question
review sign <item_id> --reviewer <id>      sign only; `resume` sends it later
review reject <item_id> --reviewer <id> --reason <text>

Every review decision asks for the reviewer's PIN at a hidden prompt (or reads it from standard
input when that isn't a terminal).
"""

import argparse
import getpass
import json
import sys
from dataclasses import asdict

from medinfo import graph, knowledge_service, review_service
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


def decide(arguments: argparse.Namespace) -> str:
    pin = read_pin()
    if arguments.action == "reject":
        if not arguments.reason:
            raise review_service.RefusedError("A rejection needs --reason.")
        review_service.reject(arguments.item_id, arguments.reviewer, pin, arguments.reason)
        said = f"Rejected by {arguments.reviewer}."
    else:
        review_service.approve(arguments.item_id, arguments.reviewer, pin)
        said = f"Signed by {arguments.reviewer}."
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
    for name in ("search", "ask", "resume"):
        commands.add_parser(name).add_argument("question_id")
    review = commands.add_parser("review").add_subparsers(dest="action", required=True)
    review.add_parser("list")
    review.add_parser("show").add_argument("item_id")
    for action in ("approve", "sign", "reject"):
        decision = review.add_parser(action)
        decision.add_argument("item_id")
        decision.add_argument("--reviewer", required=True)
        decision.add_argument("--reason")
    return top


def run(arguments: argparse.Namespace) -> str:
    if arguments.command == "search":
        return json.dumps(search_command(arguments.question_id), indent=2)
    if arguments.command == "ask":
        return graph.ask(arguments.question_id)
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
