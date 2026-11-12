#!/usr/bin/env python3
"""Read frozen G6 raw records; write only this attachment's counts.json.

No model calls, source patches, new fixtures, or mark injection. The report uses
repetition 1, matching the original 17-item snapshot comparison. Every JSON raw
input is hashed; excluded records remain in the manifest with a reason.
"""
from __future__ import annotations

import hashlib
import json
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path


HERE = Path(__file__).resolve().parent
SNAPSHOT = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE.parents[1] / "snapshot-before"
REFINE_MARK = "做记忆精筛"
MARK_INSTRUCTION = '放进 marks:[{"roomId", "seq", "kind"'
EMPTY_RESULT = {"note": None, "memories": [], "personaSuggestion": None}


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def parsed_object(text: str):
    # Match the production adapter's parseReflect JSON extraction, not a new
    # interpretation of model output. The raw call outcome remains authoritative
    # for whether the recorder classified the call as successful.
    begin, end = text.find("{"), text.rfind("}")
    if begin < 0 or end < begin:
        return None
    try:
        value = json.loads(text[begin : end + 1])
    except json.JSONDecodeError:
        return None
    return value if isinstance(value, dict) else None


def main() -> None:
    summary_path = SNAPSHOT / "summary.json"
    summary_bytes = summary_path.read_bytes()
    summary = json.loads(summary_bytes)
    expected = summary["fixture"]["items"]
    selected_repetition = 1
    manifest, records = [], []
    for path in sorted((SNAPSHOT / "raw").glob("*/*.json")):
        data = path.read_bytes()
        record = json.loads(data)
        selected = (
            record.get("schema") == "g6-raw/v1"
            and record.get("mode") == "real"
            and record.get("rep") == selected_repetition
            and record.get("item") in expected
        )
        entry = {
            "path": str(path.relative_to(SNAPSHOT)),
            "sha256": sha256(data),
            "bytes": len(data),
            "runId": record.get("runId"),
            "group": record.get("group"),
            "model": record.get("model"),
            "item": record.get("item"),
            "rep": record.get("rep"),
            "commit": record.get("commit"),
            "selected": selected,
            "exclusionReason": None if selected else "outside original repetition-1 comparison",
        }
        manifest.append(entry)
        if selected:
            records.append((entry["path"], record))

    groups = []
    for definition in summary["groups"]:
        group_id = definition["id"]
        own = [(path, record) for path, record in records if record["group"] == group_id]
        counts = Counter()
        outcomes = Counter()
        classes = Counter()
        prompt_catalog = {}
        per_item = []
        examples = []
        for path, record in own:
            switches = [
                report for report in record.get("reports", [])
                if report["what"] == "memory-writer-switched"
                and json.loads(report["detail"]).get("generation") == 2
            ]
            counts["generation2Reports"] += len(switches)
            per_item.append({
                "item": record["item"], "raw": path,
                "runStatus": record["status"],
                "generation2Reports": len(switches),
                "hostPatch": record.get("hostPatch"),
            })
            for call in record["calls"]:
                classes[call["cls"]] += 1
                system = call.get("system", "")
                if REFINE_MARK in system:
                    counts["requestsContainingRefineSystemMarker"] += 1
                    if call["cls"] != "refine":
                        counts["refineMarkerMisclassified"] += 1
                for tool in call.get("tools", []):
                    if tool["name"] == "remember":
                        counts["roundRememberToolCalls"] += 1
                        if record["item"] == "U1":
                            examples.append({"raw": path, "call": call["n"], "tool": "remember", "input": tool["input"]})
                if call["cls"] != "check":
                    continue
                counts["checkCalls"] += 1
                outcomes[call["outcome"]] += 1
                prompt_hash = sha256(system.encode("utf-8"))
                prompt = prompt_catalog.setdefault(prompt_hash, {
                    "sha256": prompt_hash,
                    "calls": 0,
                    "firstEvidence": {"raw": path, "call": call["n"]},
                    "hasMarksInstruction": MARK_INSTRUCTION in system,
                    "hasLaterRefineInstruction": "留给之后的精筛" in system,
                    "hasOneItemOneExitInstruction": "同一项不要两处都放" in system,
                    "hasExistingMemoryDedupInstruction": "与已有记忆内容相同就不要再列" in system,
                    "initialJsonExample": system.splitlines()[1] if len(system.splitlines()) > 1 else None,
                    "relevantInstructions": [line for line in system.splitlines() if any(term in line for term in ["粗筛:", "已有记忆内容相同", "每条记忆必须带"])],
                })
                prompt["calls"] += 1
                if MARK_INSTRUCTION in system:
                    counts["checkCallsWithMarksInstruction"] += 1
                parsed = parsed_object(call.get("text", ""))
                if call["outcome"] == "ok" and parsed is not None:
                    counts["checkOkParsedObjects"] += 1
                    if parsed.get("memories") == [] and parsed.get("marks") in (None, []):
                        counts["checkOkNoCandidates"] += 1
                    if parsed == EMPTY_RESULT:
                        counts["checkOkExactEmptyResult"] += 1
                    if "marks" in parsed:
                        counts["checkOkWithMarksField"] += 1
                    if isinstance(parsed.get("marks"), list):
                        counts["checkOkMarkItems"] += len(parsed["marks"])
                    if isinstance(parsed.get("memories"), list):
                        counts["checkOkMemoryItems"] += len(parsed["memories"])
                elif call["outcome"] == "ok":
                    counts["checkOkButJsonExtractionFailed"] += 1
                else:
                    counts["checkFailedCalls"] += 1
        fields = [
            "generation2Reports", "requestsContainingRefineSystemMarker", "refineMarkerMisclassified",
            "roundRememberToolCalls", "checkCalls", "checkCallsWithMarksInstruction",
            "checkOkParsedObjects", "checkOkNoCandidates", "checkOkExactEmptyResult", "checkOkWithMarksField",
            "checkOkMarkItems", "checkOkMemoryItems", "checkOkButJsonExtractionFailed", "checkFailedCalls",
        ]
        observed_items = sorted(record["item"] for _, record in own)
        result = {
            "group": group_id,
            "label": definition["label"],
            "declaredGroupCommit": definition.get("groupCommit"),
            "actualRawCommits": sorted({record["commit"] for _, record in own}),
            "slices": [x["slice"] for x in definition.get("inputs", [])],
            "records": len(own),
            "expectedItems": len(expected),
            "missingItems": sorted(set(expected) - set(observed_items)),
            "duplicateItems": [item for item, number in Counter(observed_items).items() if number > 1],
            "counts": {field: counts[field] for field in fields},
            "callClasses": {cls: classes[cls] for cls in ["round", "check", "compact", "refine", "background"]},
            "checkOutcomes": dict(sorted(outcomes.items())),
            "checkSystemPrompts": list(prompt_catalog.values()),
            "perItem": per_item,
            "u1RememberEvidence": examples,
        }
        assert result["counts"]["checkCalls"] == result["counts"]["checkOkParsedObjects"] + result["counts"]["checkOkButJsonExtractionFailed"] + result["counts"]["checkFailedCalls"]
        groups.append(result)

    manifest_identity = [{"path": entry["path"], "sha256": entry["sha256"]} for entry in manifest]
    output = {
        "schema": "g6-refine-observation/v1",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "method": "Read existing frozen raw only; no model calls or source changes; compare repetition 1.",
        "snapshotPath": str(SNAPSHOT),
        "summary": {"path": str(summary_path), "sha256": sha256(summary_bytes), "runner": summary.get("runner"), "fixture": summary.get("fixture")},
        "script": {"path": str(Path(__file__).resolve()), "sha256": sha256(Path(__file__).read_bytes())},
        "selectedRepetition": selected_repetition,
        "rawManifestSha256": sha256(json.dumps(manifest_identity, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")),
        "rawFiles": manifest,
        "groups": groups,
        "interpretation": {
            "realRefineCallCovered": any(g["callClasses"]["refine"] > 0 or g["counts"]["requestsContainingRefineSystemMarker"] > 0 for g in groups),
            "causalG5AttributionSupported": False,
            "allG3G4CheckPromptsContainMarks": all(g["counts"]["checkCalls"] > 0 and g["counts"]["checkCallsWithMarksInstruction"] == g["counts"]["checkCalls"] for g in groups if g["group"] in ["g3", "g4on", "g4off"]),
            "limits": [
                "The observed g3/g4on writer switched to generation 2, but successful check output had no mark or memory candidates; no real refine call was recorded.",
                "Zero refine tokens are no observation of refine quality, per-call cost, latency, or implementation failure.",
                "All g3/g4on check requests contain the marks instruction; the initial JSON example omits marks, whose effect is not established by this observation.",
                "g2 to g3 also adds G3 retrieval and group timing settings, so the difference cannot be attributed solely to G5.",
                "U1 uses the ordinary remember tool before later empty checks; the preset untagged-detail category does not prove absence of memory writes.",
                "No marks are artificially inserted into the original 17-item experiment; incomplete g4off data remains explicitly incomplete.",
                "Raw captures writer reports and model I/O, but not a complete memoryMarks table snapshot; no database-level count is claimed.",
            ],
        },
    }
    output_path = Path(sys.argv[2]) if len(sys.argv) > 2 else HERE / "counts.json"
    output_path.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({
        "output": str(output_path), "sha256": sha256(output_path.read_bytes()),
        "rawFiles": len(manifest), "selectedRecords": len(records),
        "rawManifestSha256": output["rawManifestSha256"],
        "groups": [{"group": g["group"], "records": g["records"], "checkEmptyCandidates": g["counts"]["checkOkNoCandidates"], "checkExactEmptyResult": g["counts"]["checkOkExactEmptyResult"], "checkFailed": g["counts"]["checkFailedCalls"], "generation2": g["counts"]["generation2Reports"], "refineCalls": g["callClasses"]["refine"]} for g in groups],
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
