"""Translate a Discover search (KQL, filter pills, time range) into an Elasticsearch query.

The learning service checks evidence against what the learner is actually looking at, so it needs
the same document set Discover shows. This mirrors how Kibana builds that search: an unquoted value
is a ``match``, a quoted one a ``match_phrase``, ``field: *`` an ``exists``, comparisons a ``range``,
and text without a field a lenient ``multi_match``; filter pills are phrase filters. Anything outside
that subset (nested queries, field wildcards) returns None, so a caller can treat the view as
unknown rather than guess.
"""

from __future__ import annotations

import re

_TOKEN = re.compile(r'\s*(?:(?P<paren>[()])|(?P<range><=|>=|<|>)|(?P<colon>:)|"(?P<quoted>(?:\\.|[^"\\])*)"|(?P<word>(?:\\.|[^\s():<>{}"\\])+))')
_KEYWORDS = {"and", "or", "not"}


class KqlError(ValueError):
    pass


def _tokens(text):
    tokens, position = [], 0
    text = str(text or "")
    while position < len(text):
        if not text[position:].strip():
            break
        match = _TOKEN.match(text, position)
        if not match or match.end() == position:
            raise KqlError(f"cannot read the query at {position}")
        position = match.end()
        kind = match.lastgroup
        value = match.group(kind)
        if kind in {"quoted", "word"}:
            value = re.sub(r"\\(.)", r"\1", value)
        if kind == "word" and value.casefold() in _KEYWORDS:
            kind, value = value.casefold(), value.casefold()
        tokens.append((kind, value))
    return tokens


class _Parser:
    def __init__(self, text):
        self.tokens = _tokens(text)
        self.index = 0

    def peek(self, offset=0):
        position = self.index + offset
        return self.tokens[position] if position < len(self.tokens) else (None, None)

    def take(self, kind=None):
        token = self.peek()
        if kind and token[0] != kind:
            raise KqlError(f"expected {kind}, found {token[1]!r}")
        self.index += 1
        return token

    def parse(self):
        if not self.tokens:
            return {"match_all": {}}
        query = self.or_expression(self.clause)
        if self.peek()[0] is not None:
            raise KqlError(f"unexpected {self.peek()[1]!r}")
        return query

    # Boolean structure is shared by whole clauses and by a field's value list: ``field: (a or b)``.
    def or_expression(self, operand):
        parts = [self.and_expression(operand)]
        while self.peek()[0] == "or":
            self.take()
            parts.append(self.and_expression(operand))
        return parts[0] if len(parts) == 1 else {"bool": {"should": parts, "minimum_should_match": 1}}

    def and_expression(self, operand):
        parts = [self.not_expression(operand)]
        while self.peek()[0] == "and":
            self.take()
            parts.append(self.not_expression(operand))
        return parts[0] if len(parts) == 1 else {"bool": {"filter": parts}}

    def not_expression(self, operand):
        if self.peek()[0] == "not":
            self.take()
            return {"bool": {"must_not": [self.not_expression(operand)]}}
        if self.peek()[0] == "paren" and self.peek()[1] == "(":
            self.take()
            inner = self.or_expression(operand)
            self.take("paren")
            return inner
        return operand()

    def clause(self):
        kind, value = self.peek()
        following = self.peek(1)[0]
        if kind == "word" and following == "colon":
            self.take()
            self.take("colon")
            field = value
            if "*" in field:
                raise KqlError("field wildcards are not supported")
            if self.peek()[0] == "paren" and self.peek()[1] == "(":
                self.take()
                inner = self.or_expression(lambda: self.value(field))
                self.take("paren")
                return inner
            return self.value(field)
        if kind == "word" and following == "range":
            self.take()
            operator = {"<": "lt", "<=": "lte", ">": "gt", ">=": "gte"}[self.take("range")[1]]
            literal = self.take()
            if literal[0] not in {"word", "quoted"}:
                raise KqlError("a comparison needs a value")
            return {"range": {value: {operator: literal[1]}}}
        if kind in {"word", "quoted"}:
            text, quoted = self.literal()
            return {"multi_match": {"type": "phrase" if quoted else "best_fields", "query": text, "lenient": True}}
        raise KqlError(f"unexpected {value!r}")

    def literal(self):
        """A quoted phrase, or consecutive unquoted words up to an operator ("order validation failed")."""
        kind, value = self.take()
        if kind == "quoted":
            return value, True
        if kind != "word":
            raise KqlError(f"expected a value, found {value!r}")
        words = [value]
        while self.peek()[0] == "word" and self.peek(1)[0] not in {"colon", "range"}:
            words.append(self.take()[1])
        return " ".join(words), False

    def value(self, field):
        if self.peek()[0] == "paren":
            raise KqlError("unexpected parenthesis")
        text, quoted = self.literal()
        if not quoted and text == "*":
            return {"exists": {"field": field}}
        if not quoted and "*" in text:
            return {"wildcard": {field: {"value": text, "case_insensitive": True}}}
        return {"match_phrase" if quoted else "match": {field: text}}


def kql_query(text):
    """The Elasticsearch query for a KQL string, or None when it uses syntax this does not cover."""
    try:
        return _Parser(text).parse()
    except (KqlError, KeyError):
        return None


def filter_query(pill):
    """A filter pill as ``(clause, negate)``: the observer's ``{field, value, negate, disabled}`` or the
    coach's reading of Kibana's ``meta`` (``type`` phrase, phrases, exists or range). A disabled pill
    constrains nothing; a custom filter raises KqlError, since its query is not known here."""
    meta = pill.get("meta") or {}
    if pill.get("disabled") or meta.get("disabled"):
        return None, False
    field = pill.get("field") or meta.get("key")
    kind = str(pill.get("type") or meta.get("type") or "phrase")
    if not field:
        raise KqlError("a filter without a field")
    value = pill.get("value", (meta.get("params") or {}).get("query") if isinstance(meta.get("params"), dict) else meta.get("params"))
    operator = str(pill.get("operator") or "is").casefold()
    negate = bool(pill.get("negate", meta.get("negate", False))) or operator in {"is not", "not"}
    if kind == "exists" or operator in {"exists", "does not exist"}:
        return {"exists": {"field": field}}, negate or operator == "does not exist"
    if kind == "range":
        bounds = {key: value[key] for key in ("gt", "gte", "lt", "lte") if isinstance(value, dict) and value.get(key) is not None}
        if not bounds:
            raise KqlError("a range filter without bounds")
        return {"range": {field: bounds}}, negate
    if kind == "phrases" or isinstance(value, list):
        return {"bool": {"should": [{"match_phrase": {field: item}} for item in value or []], "minimum_should_match": 1}}, negate
    if kind != "phrase":
        raise KqlError(f"unsupported filter type {kind}")
    if value is None or value == "":
        return None, False
    return {"match_phrase": {field: value}}, negate


def view_query(view, time_field="@timestamp"):
    """Everything a KQL view constrains (time range, query, pills) as one bool query, or None when
    the query cannot be translated. ES|QL views are not handled here."""
    view = view or {}
    clauses, excluded = [], []
    time_from, time_to = view.get("time_from"), view.get("time_to")
    if time_from or time_to:
        bounds = {key: value for key, value in (("gte", time_from), ("lte", time_to)) if value}
        clauses.append({"range": {time_field: bounds}})
    if str(view.get("language") or "kql").casefold() not in {"kql", "kuery"}:
        return None
    query = kql_query(view.get("query") or "")
    if query is None:
        return None
    if query != {"match_all": {}}:
        clauses.append(query)
    for pill in view.get("filters") or []:
        try:
            clause, negate = filter_query(pill)
        except KqlError:
            return None
        if clause:
            (excluded if negate else clauses).append(clause)
    return {"bool": {"filter": clauses, "must_not": excluded}}
