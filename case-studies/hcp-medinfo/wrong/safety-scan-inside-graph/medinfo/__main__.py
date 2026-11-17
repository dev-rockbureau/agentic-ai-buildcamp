"""python -m medinfo <command>

search <question_id>                       the approved passages search returns, as JSON
scan <question_id>                         the safety scan alone (safe to run again)
ask <question_id>                          the safety scan, then the graph until it waits for review
resume <question_id>                       carry on a paused question with its recorded decision
review list                                the items waiting for review
review show <item_id>                      one item: question, queue, draft and citations
review approve <item_id> --reviewer <id>   sign the draft, then resume the question
review edit <item_id> --reviewer <id> --edit <n>:<words>   change sentence n, verify, sign, resume
review sign <item_id> --reviewer <id>      sign only; `resume` sends it later
review reject <item_id> --reviewer <id> --reason <text>
review set-country <item_id> --reviewer <id> --country <code>   data steward: run it again
review close <item_id> --reviewer <id> --reason <text>          data steward: no answer is sent

approve, edit and sign take --override <n>:<reason> for each sentence the verifier flags: signing
is refused while any flag has no reason. If a cited source was withdrawn or changed, nothing is
signed and the question is redrafted.

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
    return graph.ask(question_id)


# The decisions that sign. The others need one more value, and say what they did.
SIGNING = ("approve", "edit", "sign")
OTHER_DECISIONS = {
    "reject": (review_service.reject, "reason", "Rejected"),
    "set-country": (review_service.set_country, "country", "Country set"),
    "close": (review_service.close, "reason", "Closed"),
}


def by_sentence(values: list[str] | None, flag: str) -> dict[int, str]:
    """--edit and --override values: "<sentence number>:<words>"."""
    found = {}
    for value in values or []:
        number, _, words = value.partition(":")
        if not number.strip().isdigit() or not words.strip():
            raise review_service.RefusedError(f"--{flag} takes <sentence number>:<words>.")
        found[int(number)] = words.strip()
    return found


def record_decision(arguments: argparse.Namespace, signer: review_service.Signer) -> str:
    if arguments.action in SIGNING:
        edits = by_sentence(arguments.edit, "edit")
        if arguments.action == "edit" and not edits:
            raise review_service.RefusedError("review edit needs at least one --edit.")
        overrides = by_sentence(arguments.override, "override")
        review_service.sign(arguments.item_id, signer, review_service.Signing(edits, overrides))
        return "Edited and signed" if edits else "Signed"
    record, needs, done = OTHER_DECISIONS[arguments.action]
    value = getattr(arguments, needs)
    if not value:
        raise review_service.RefusedError(f"review {arguments.action} needs --{needs}.")
    record(arguments.item_id, signer, value)
    return done


def decide(arguments: argparse.Namespace) -> str:
    signer = review_service.Signer(arguments.reviewer, read_pin())
    question_id = question_of(arguments.item_id)
    try:
        done = record_decision(arguments, signer)
    except review_service.InvalidatedError as invalidated:
        # The invalidation is recorded. Resume now, so the question is searched and redrafted.
        redone = resume_command(question_id)
        raise review_service.RefusedError(f"{invalidated}\n{redone}") from invalidated
    said = f"{done} by {arguments.reviewer}."
    if arguments.action == "sign":
        return f"{said} Run resume {question_id} to send it."
    return f"{said}\n{resume_command(question_id)}"


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
    for action in (*SIGNING, *OTHER_DECISIONS):
        decision = review.add_parser(action)
        decision.add_argument("item_id")
        decision.add_argument("--reviewer", required=True)
        decision.add_argument("--reason")
        decision.add_argument("--country")
        decision.add_argument("--edit", action="append")
        decision.add_argument("--override", action="append")
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
