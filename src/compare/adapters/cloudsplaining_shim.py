#!/usr/bin/env python3
"""Cloudsplaining adapter shim.

Reads a JSON array of policy descriptors on stdin:
    [{ "policyId": "...", "document": { <IAM policy JSON> } }, ...]

Emits, on stdout, a JSON array of per-policy risk summaries that the TypeScript
normalizer turns into normalized Findings. We use Cloudsplaining as a library
because its single-policy CLI only prints a human report.

This file is the tested boundary between us and Cloudsplaining: if their API
shifts, only this shim and its golden fixtures change.
"""
import json
import sys


def _as_str_list(value):
    out = []
    for item in value or []:
        if isinstance(item, str):
            out.append(item)
        elif isinstance(item, dict):
            # privilege_escalation entries look like {"type": "...", "actions": [...]}
            out.append(item.get("type") or json.dumps(item, sort_keys=True))
        else:
            out.append(str(item))
    return out


def summarize(document):
    from cloudsplaining.scan.policy_document import PolicyDocument

    pd = PolicyDocument(document)
    return {
        "allowedActions": list(pd.all_allowed_actions or []),
        "serviceWildcards": list(pd.service_wildcard or []),
        "risks": {
            "privilege_escalation": _as_str_list(pd.allows_privilege_escalation),
            "data_exfiltration": _as_str_list(pd.allows_data_exfiltration_actions),
            "credentials_exposure": _as_str_list(pd.credentials_exposure),
            "permissions_management": _as_str_list(
                pd.permissions_management_without_constraints
            ),
            "write": _as_str_list(pd.write_actions_without_constraints),
            "tagging": _as_str_list(pd.tagging_actions_without_constraints),
            "infrastructure_modification": _as_str_list(pd.infrastructure_modification),
        },
    }


def main():
    try:
        descriptors = json.load(sys.stdin)
    except json.JSONDecodeError as exc:
        json.dump({"error": f"invalid input json: {exc}"}, sys.stdout)
        sys.exit(1)

    results = []
    for d in descriptors:
        try:
            summary = summarize(d.get("document") or {})
        except Exception as exc:  # noqa: BLE001 — report, do not crash the batch
            summary = {"error": str(exc), "allowedActions": [], "serviceWildcards": [], "risks": {}}
        summary["policyId"] = d.get("policyId")
        results.append(summary)

    json.dump(results, sys.stdout)


if __name__ == "__main__":
    main()
