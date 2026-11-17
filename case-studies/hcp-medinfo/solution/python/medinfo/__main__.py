"""python -m medinfo <command>

search <question_id>   print the approved passages the search returns for one question, as JSON
"""

import json
import sys
from dataclasses import asdict

from medinfo import knowledge_service
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


def main(arguments: list[str]) -> int:
    if len(arguments) == 2 and arguments[0] == "search":
        print(json.dumps(search_command(arguments[1]), indent=2))
        return 0
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
