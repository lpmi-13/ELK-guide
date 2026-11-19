"""Learner-facing text stays readable for people whose first language is not English.

The copy is being rewritten in plain English one surface at a time. Each surface checked here has
been rewritten and must stay that way: no word from learning/plain-language.json's "avoid" list
(each one names a plainer alternative), and no sentence longer than MAX_SENTENCE_WORDS. Kibana UI
labels, field names and the observability terms a scenario teaches (plain-language.json's "terms")
are fine: keep them, and explain each in plain words where a learner first meets it. Every pack's copy is
checked (briefings, launcher cards, conclusions, answer forms, playbooks), as are the coach, launcher
and service strings in code. A new pack or surface gets the same checks.
"""

import ast
import importlib.util
import json
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "learning-service"))
sys.path.insert(0, str(ROOT / "learning-service" / "engine"))

from contracts import expand_descriptor  # noqa: E402


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


generator = load_module("plain_language_sample_generator", ROOT / "scripts" / "generate-protocol-samples.py")
server = generator.server
CATALOG = json.loads((ROOT / "learning" / "catalog.json").read_text(encoding="utf-8"))
BRIEFINGS = json.loads((ROOT / "learning" / "incident-briefings.json").read_text(encoding="utf-8"))
WORDS = json.loads((ROOT / "learning" / "plain-language.json").read_text(encoding="utf-8"))
AVOID = WORDS["avoid"]
# Kibana and observability vocabulary learners should learn: kept, and explained where first used.
TERMS = WORDS["terms"]

# Every pack, on every surface: its briefing; its launcher card, title, brief, reference conclusion
# and answer form; and its playbook's cards, hints, drift notes and end-of-demo summary.
PACKS = [entry["id"] for entry in CATALOG["scenarios"]]
PLAIN_BRIEFINGS = PLAIN_SCENARIOS = PLAIN_PLAYBOOKS = PACKS
# Code whose string literals include learner-facing copy: the coach, the launcher and the service's
# feedback. Its literals are checked for avoid-list words only, since a literal is often a fragment.
PLAIN_CODE = [*sorted((ROOT / "kibana-coach" / "src").rglob("*.js")), ROOT / "telemetry" / "index.html",
              ROOT / "telemetry" / "preparing.html", ROOT / "learning-service" / "server.py",
              ROOT / "learning-service" / "engine" / "evaluator.py"]
# Code that draws on the page but shows no words. Every other file must yield copy, or the extractor missed it.
WORDLESS_CODE = {ROOT / "kibana-coach" / "src" / "ui" / "spotlight.js"}
# Playbook keys whose strings a learner reads; the rest are ids, validators and Kibana actions.
COPY_KEYS = {"title", "narration", "concept", "reasoning", "evidence", "hints", "note", "detail"}
CODE_KEYS = {"accepts", "validators", "reference_action", "starting_view", "goal_focus", "evidence_focus", "restore_state", "variables"}
SEEDS = range(6)
# Descriptive text; instructions aim for 20 or fewer.
MAX_SENTENCE_WORDS = 25


def forms(word):
    """The word and the base forms its common English endings could come from."""
    found = {word}
    for ending, base in (("ies", "y"), ("ied", "y"), ("es", ""), ("s", ""), ("ed", ""), ("ed", "e"), ("d", ""),
                         ("ing", ""), ("ing", "e"), ("ly", ""), ("ily", "y")):
        if word.endswith(ending) and len(word) - len(ending) >= 3:
            found.add(word[: -len(ending)] + base)
    return found


def hard_words(text):
    words = re.findall(r"[a-z]+(?:'[a-z]+)?", text.casefold())
    return [f"{word} (try: {AVOID[base]})" for word in words for base in sorted(forms(word.removesuffix("'s"))) if base in AVOID]


def long_sentences(text):
    sentences = re.split(r"(?<=[.!?])\s+", text.strip())
    return [f"{len(sentence.split())} words: {sentence}" for sentence in sentences if len(sentence.split()) > MAX_SENTENCE_WORDS]


def playbook_copy(value, key=None):
    """(key, text) for every learner-facing string in an expanded playbook. Template tokens stand in for
    one word each; the values they resolve to (a conclusion, a field name) are checked where they're written."""
    if isinstance(value, dict):
        for child, item in value.items():
            if child not in CODE_KEYS:
                yield from playbook_copy(item, child)
    elif isinstance(value, list):
        for item in value:
            yield from playbook_copy(item, key)
    elif isinstance(value, str) and key in COPY_KEYS and value.strip():
        yield key, re.sub(r"\$\{[^}]+\}", "X", value)


def prose(text):
    return " " in text and len(re.findall(r"[A-Za-z]{2,}", text)) >= 3


def js_literals(source):
    """(line, text) for each string or template literal with a few words in it, comments removed."""
    source = re.sub(r"/\*.*?\*/", lambda match: "\n" * match.group().count("\n"), source, flags=re.S)
    source = re.sub(r"(?m)(^|[\s;{}(),])//.*$", r"\1", source)
    for match in re.finditer(r"'(?:[^'\\\n]|\\.)*'|\"(?:[^\"\\\n]|\\.)*\"|`(?:[^`\\]|\\.)*`", source):
        if prose(match.group()[1:-1]):
            yield source[: match.start()].count("\n") + 1, match.group()[1:-1]


def py_literals(source):
    """(line, text) for each string constant with a few words in it (f-string parts too), not docstrings."""
    tree = ast.parse(source)
    documented = (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)
    docstrings = {id(node.body[0].value) for node in ast.walk(tree) if isinstance(node, documented)
                  and node.body and isinstance(node.body[0], ast.Expr) and isinstance(node.body[0].value, ast.Constant)}
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in docstrings and prose(node.value):
            yield node.lineno, node.value


def code_copy(path):
    source = path.read_text(encoding="utf-8")
    if path.suffix == ".py":
        yield from py_literals(source)
        return
    if path.suffix == ".html":
        source = re.sub(r"<style.*?</style>", lambda match: "\n" * match.group().count("\n"), source, flags=re.S)
        visible = re.sub(r"<script.*?</script>|<[^>]+>", " ", source, flags=re.S)
        yield 0, visible
    yield from js_literals(source)


def briefing_text(briefing):
    """Everything the briefing card can show, plus the signals behind its triage request."""
    texts = [briefing["headline"], briefing["summary"], briefing["impact"]]
    texts += [signal["value"] for signal in briefing["signals"]]
    texts += [fact["text"] for fact in briefing["timed_facts"]]
    texts += [briefing["source"]["label"], briefing["source"]["detail"]]
    return texts


class PlainLanguageTests(unittest.TestCase):
    def assertPlain(self, text, where):
        self.assertEqual(hard_words(text), [], f"{where}: {text!r}")
        self.assertEqual(long_sentences(text), [], where)

    def test_the_word_list_names_a_plainer_alternative_for_each_word(self):
        for word, alternative in AVOID.items():
            self.assertEqual(word, word.casefold())
            self.assertTrue(alternative.strip(), word)
            self.assertEqual(hard_words(alternative), [], f"{word}: the alternative {alternative!r} is on the list")

    def test_kibana_terms_are_kept_and_explained_plainly(self):
        for term, explanation in TERMS.items():
            self.assertEqual(hard_words(term), [], f"{term} is a term to keep, so it can't also be on the avoid list")
            self.assertPlain(explanation, f"term {term}")

    def test_the_checker_catches_inflected_forms(self):
        self.assertEqual(len(hard_words("Errors are elevated, obscuring the actionable reason.")), 2 + 1)
        self.assertEqual(len(hard_words("It corroborates and isolates; it was isolated.")), 3)
        self.assertEqual(hard_words("Find the unusual rejection reason."), [])
        self.assertEqual(long_sentences("One two three. " + "word " * 26), [f"26 words: {'word ' * 25}word"])

    def test_incident_briefings_read_plainly(self):
        for scenario_id in PLAIN_BRIEFINGS:
            for seed in SEEDS:
                session = generator.new_session(scenario_id, "guided", seed=seed)
                for text in briefing_text(server.build_incident_briefing(session)):
                    self.assertPlain(text, f"{scenario_id} seed {seed}")

    def test_every_briefing_source_reads_plainly(self):
        for key, source in BRIEFINGS["sources"].items():
            for part in ("label", "detail"):
                self.assertPlain(source[part], f"source {key} {part}")

    def test_launcher_cards_and_scenario_briefs_read_plainly(self):
        entries = {entry["id"]: entry for entry in CATALOG["scenarios"]}
        for scenario_id in PLAIN_SCENARIOS:
            entry = entries[scenario_id]
            scenario = json.loads((ROOT / "learning" / entry["pack"] / "scenario.json").read_text(encoding="utf-8"))
            for key in ("title", "brief"):
                # The launcher card shows the catalog's copy; the run (the challenge opening, the
                # briefing fallback) shows the scenario's. Rewrite both together.
                self.assertEqual(entry[key], scenario[key], f"{scenario_id}: catalog and scenario {key} differ")
                self.assertPlain(scenario[key], f"{scenario_id} {key}")
            for field in scenario["answer_schema"]["fields"]:
                for part in ("label", "placeholder"):
                    if field.get(part):
                        self.assertPlain(field[part], f"{scenario_id} answer {field['id']} {part}")

    def test_reference_conclusions_read_plainly(self):
        for scenario_id in PLAIN_SCENARIOS:
            for seed in SEEDS:
                session = generator.new_session(scenario_id, "guided", seed=seed)
                truth = server.substitute(session["manifest"]["scenario"]["truth"], session)
                self.assertPlain(truth["answers"]["conclusion"], f"{scenario_id} seed {seed} conclusion")

    def test_coach_cards_hints_and_demo_summaries_read_plainly(self):
        entries = {entry["id"]: entry for entry in CATALOG["scenarios"]}
        for scenario_id in PLAIN_PLAYBOOKS:
            descriptor = json.loads((ROOT / "learning" / entries[scenario_id]["pack"] / "playbook.json").read_text(encoding="utf-8"))
            playbook = expand_descriptor(ROOT / "learning", "playbook", descriptor)
            copy = list(playbook_copy(playbook))
            self.assertGreater(len(copy), 40, scenario_id)
            for key, text in copy:
                self.assertPlain(text, f"{scenario_id} {key}")

    def test_coach_launcher_and_service_copy_uses_plain_words(self):
        for path in PLAIN_CODE:
            found = list(code_copy(path))
            self.assertTrue(found or path in WORDLESS_CODE, path)
            for line, text in found:
                self.assertEqual(hard_words(text), [], f"{path.relative_to(ROOT)}:{line}: {text[:200]!r}")

    def test_the_fallback_briefing_reads_plainly(self):
        source = (ROOT / "learning-service" / "server.py").read_text(encoding="utf-8")
        fallback = re.search(r'"impact": "([^"]+)",\n\s+"signals": \[\{"label": "Triage request"', source)
        self.assertIsNotNone(fallback)
        self.assertPlain(fallback.group(1), "fallback impact")


if __name__ == "__main__":
    unittest.main()
