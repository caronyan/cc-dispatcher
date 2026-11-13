#!/usr/bin/env python3
"""Check a helper's JSON report against the subset of JSON Schema the skills' schemas use.

usage: hd_check.py SCHEMA REPORT
Prints REPORT_OK, REPORT_MISSING, or REPORT_BAD followed by one problem per line; exit 0 only for REPORT_OK.
Covered: type, required, properties, additionalProperties: false, enum, items.
"""
import json
import sys

TYPES = {
    "object": dict, "array": list, "string": str, "boolean": bool,
    "integer": int, "number": (int, float), "null": type(None),
}


def check(schema, value, path, problems):
    kind = schema.get("type")
    if kind:
        kinds = kind if isinstance(kind, list) else [kind]
        ok = any(isinstance(value, TYPES[k]) and not (k in ("integer", "number") and isinstance(value, bool))
                 for k in kinds)
        if not ok:
            problems.append(f"{path or '$'}: expected {kind}, got {type(value).__name__}")
            return
    if "enum" in schema and value not in schema["enum"]:
        problems.append(f"{path or '$'}: {value!r} not in {schema['enum']}")
    if isinstance(value, dict):
        props = schema.get("properties", {})
        for key in schema.get("required", []):
            if key not in value:
                problems.append(f"{path or '$'}: missing {key}")
        for key, sub in value.items():
            if key in props:
                check(props[key], sub, f"{path}.{key}", problems)
            elif schema.get("additionalProperties") is False:
                problems.append(f"{path or '$'}: unexpected {key}")
    if isinstance(value, list) and "items" in schema:
        for i, item in enumerate(value):
            check(schema["items"], item, f"{path}[{i}]", problems)


def main():
    if len(sys.argv) != 3:
        print(__doc__.strip())
        return 2
    schema_path, report_path = sys.argv[1:]
    try:
        text = open(report_path, encoding="utf-8").read()
    except FileNotFoundError:
        print("REPORT_MISSING")
        return 1
    try:
        report = json.loads(text)
    except json.JSONDecodeError as err:
        print(f"REPORT_BAD\nnot valid JSON: {err}")
        return 1
    problems = []
    check(json.load(open(schema_path, encoding="utf-8")), report, "", problems)
    print("REPORT_OK" if not problems else "REPORT_BAD\n" + "\n".join(problems[:20]))
    return 0 if not problems else 1


if __name__ == "__main__":
    sys.exit(main())
