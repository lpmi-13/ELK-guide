"""What a learner reads before investigating must not give the investigation away.

Public text — the launcher's cards, the preparation page, the incident briefing, a challenge's opening
and the coach's step headings — must not carry internal identifiers (pack ids, run, Space or session
ids, unresolved template tokens) and must not state the diagnosis: a title may frame the task or the
symptom, but not assert what the brief asks the learner to establish, and no public text may name the
run's finding. Technical pack names stay in internal data (ids, file names).
"""

import importlib.util
import json
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "learning-service"))


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


generator = load_module("wording_sample_generator", ROOT / "scripts" / "generate-protocol-samples.py")
server = generator.server
CATALOG = json.loads((ROOT / "learning" / "catalog.json").read_text(encoding="utf-8"))
PACKS = [entry for entry in CATALOG["scenarios"] if entry["classification"] == "core"]
PACK_IDS = {entry["id"] for entry in CATALOG["scenarios"]}
SEEDS = (11, 2026, 424242, 9001, 77)

# What each pack's brief asks the learner to establish, as the words a title must not assert. A pack
# whose title only frames the task or the symptom has none; every core pack must say which.
CONCLUSION_TERMS = {
    "discover-time-window": [],
    "http-error-regression": [],
    "auth-rejection-surge": [],
    "deployment-version-regression": ["version", "regression"],
    "rare-error-signature": [],
    "schema-drift-data-quality": ["schema", "drift", "data quality"],
    "log-pattern-noise-reduction": [],
    "esql-top-failing-routes": [],
    "esql-before-after-deploy": [],
    "esql-cross-service-summary": [],
    "dashboard-incident-triage": [],
    "dashboard-drilldown-to-evidence": [],
    "dashboard-panel-inspection": [],
    "slow-dependency-trace": [],
    "trace-error-propagation": [],
    "retry-amplification": ["retry", "retries", "amplif"],
    "trace-log-correlation": [],
    "cpu-saturation": ["cpu", "saturat"],
    "memory-leak-and-restarts": ["memory", "leak"],
    "hot-instance-imbalance": [],
    "capacity-throughput-saturation": [],
    "active-alert-triage": ["active"],
}

INTERNAL = [
    (re.compile(r"\$\{[^}]*\}"), "an unresolved template token"),
    (re.compile(r"\brun-[0-9a-f]{6,}"), "a run id"),
    (re.compile(r"\blab-[0-9a-f]{6,}"), "a Space id"),
    (re.compile(r"\bsession-[0-9a-f]{6,}"), "a session id"),
    (re.compile(r"\b(?:truth|param|var|incident)\.[a-z_]+"), "a template path"),
    (re.compile(r"\b(?:reference_action|evidence_focus|goal_focus|readiness_validators|template_id)\b"), "an internal key"),
]


def internal_identifiers(text, pack_ids=True):
    found = [label for pattern, label in INTERNAL if pattern.search(text)]
    if pack_ids:
        found += [f"pack id {pack}" for pack in PACK_IDS if re.search(rf"(?<![\w-]){re.escape(pack)}(?![\w-])", text)]
    return found


def words(text):
    return text.casefold()


def strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from strings(item)
    elif isinstance(value, list):
        for item in value:
            yield from strings(item)


def public_briefing_text(briefing):
    """The briefing's learner-facing copy (not its ids, graphic path or timestamps)."""
    keys = ("headline", "summary", "impact", "severity", "owner", "environment")
    texts = [briefing[key] for key in keys]
    texts += [signal[part] for signal in briefing["signals"] for part in ("label", "value")]
    texts += [fact["text"] for fact in briefing["timed_facts"]]
    texts += [briefing["source"][part] for part in ("label", "detail")]
    return texts


class PublicWordingTests(unittest.TestCase):
    def test_every_core_pack_declares_what_its_title_must_not_assert(self):
        self.assertEqual(set(CONCLUSION_TERMS), {entry["id"] for entry in PACKS})

    def test_titles_frame_the_task_not_the_conclusion(self):
        for entry in PACKS:
            scenario = json.loads((ROOT / "learning" / entry["pack"] / "scenario.json").read_text(encoding="utf-8"))
            for title in {entry["title"], scenario["title"]}:
                for term in CONCLUSION_TERMS[entry["id"]]:
                    self.assertNotIn(term, words(title), f"{entry['id']}: title {title!r} asserts {term!r}")
                # Public and internal names differ where the internal one names the diagnosis.
                if CONCLUSION_TERMS[entry["id"]]:
                    self.assertNotEqual(words(title).replace(" ", "-"), entry["id"])

    def test_launcher_cards_carry_no_internal_identifiers(self):
        for entry in CATALOG["scenarios"]:
            for text in (entry["title"], entry["brief"], entry["surface"]):
                self.assertEqual(internal_identifiers(text), [], f"{entry['id']}: {text!r}")
            # Skills are public tags; one may share its words with a pack's id (trace-log-correlation).
            for skill in entry["skills"]:
                self.assertEqual(internal_identifiers(skill, pack_ids=False), [], f"{entry['id']}: {skill!r}")

    def test_the_preparation_page_carries_no_internal_identifiers(self):
        page = (ROOT / "telemetry" / "preparing.html").read_text(encoding="utf-8")
        visible = re.sub(r"<script.*?</script>|<style.*?</style>|<[^>]+>", " ", page, flags=re.S)
        self.assertEqual(internal_identifiers(visible), [])

    def test_briefings_and_openings_name_no_finding_and_no_internal_identifier(self):
        for entry in PACKS:
            for seed in SEEDS:
                for mode in ("demonstration", "guided", "challenge"):
                    session = generator.new_session(entry["id"], mode, seed=seed)
                    truth = server.substitute(session["manifest"]["scenario"]["truth"], session)
                    # A triage decision's answer is one of the classes its question names ("whether it is
                    # an active customer issue"), so only an investigation's finding must stay unnamed.
                    finding = "" if session["manifest"]["scenario"]["type"] == "triage" else str(truth["answers"].get("finding", ""))
                    briefing = server.build_incident_briefing(session)
                    texts = [session["manifest"]["scenario"]["title"], session["manifest"]["scenario"]["brief"], *public_briefing_text(briefing)]
                    if mode == "challenge":
                        session["briefing_acknowledged"] = True
                        opening = server.next_command(session)
                        texts.append(opening["narration"])
                    for text in texts:
                        where = f"{entry['id']} seed {seed} {mode}: {text!r}"
                        self.assertEqual(internal_identifiers(text), [], where)
                        if len(finding) >= 4:
                            self.assertNotRegex(words(text), rf"(?<![\w-]){re.escape(words(finding))}(?![\w-])", where)

    def test_a_challenge_opening_reveals_nothing_of_the_reference_route(self):
        for entry in PACKS:
            session = generator.new_session(entry["id"], "challenge")
            session["briefing_acknowledged"] = True
            opening = server.next_command(session)
            self.assertIn(opening["type"], {"request_answer", "request_diagnosis"})
            self.assertEqual(opening["narration"], session["manifest"]["scenario"]["brief"])
            for field in ("reasoning", "evidence", "concept"):
                self.assertEqual(opening[field], "", f"{entry['id']}: {field}")
            self.assertEqual(opening["learning_focus"], [])
            self.assertIsNone(opening["evidence_focus"])
            self.assertIsNone(opening["goal_focus"])
            self.assertNotIn("walkthrough", opening)
            self.assertNotIn("restore_state", opening)

    def test_step_headings_are_the_steps_titles_not_their_ids(self):
        for entry in PACKS:
            for mode in ("demonstration", "guided"):
                session = generator.new_session(entry["id"], mode)
                session["briefing_acknowledged"] = True
                command = server.next_command(session)
                self.assertTrue(command["step_title"])
                self.assertNotEqual(command["step_title"], command["step_id"])
                self.assertEqual(internal_identifiers(command["step_title"]), [], entry["id"])
        panel = (ROOT / "kibana-coach" / "src" / "ui" / "coach-panel.js").read_text(encoding="utf-8")
        self.assertIn("command.step_title || command.step_id", panel)


if __name__ == "__main__":
    unittest.main()
