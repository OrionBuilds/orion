#!/usr/bin/env python3
"""Read the owner's three CAIO source documents (read-only, standard library only) and write the structured
inputs the CAIO module is built from:

  out/registers.json   the 17 registers: key, title, purpose, prefix, columns (label, type, promote_as, ...)
  out/directory.json   the 40 templates: number, title, when_to_use, milestones, registers they feed
  out/gates.json       the five delivery gates with their acceptance conditions and required templates

Usage: python3 -I extract_sources.py <registers.xlsx> <START_HERE.docx> <roadmap.docx> <out-dir>

Nothing in the input files is executed or evaluated; they are unzipped and their XML is parsed as data.
"""
import json, re, sys, zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

N = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"

# Register tab -> (register key, record-id prefix). Order = the workbook's tab order.
REGISTERS = [
    ("AI Systems", "ai_systems", "SYS"), ("Approved Tools", "approved_tools", "TOOL"), ("Risks", "risks", "RSK"),
    ("Decisions", "decisions", "DEC"), ("Incidents", "incidents", "INC"), ("Exceptions", "exceptions", "EXC"),
    ("Vendors", "vendors", "VND"), ("Obligations", "obligations", "OBL"), ("Training", "training", "TRN"),
    ("Actions", "actions", "ACT"), ("Change Log", "change_log", "CHG"), ("Evidence", "evidence", "EVD"),
    ("Access Reviews", "access_reviews", "ACC"), ("Knowledge Sources", "knowledge_sources", "SRC"),
    ("Opportunities", "opportunities", "OPP"), ("KPI Log", "kpi_log", "KPI"), ("Budget", "budget", "BUD"),
]

# Which column plays which role in queries/reminders. Matched on the column LABEL, lower-cased.
PROMOTE = {
    "status": {"status", "approval status", "decision", "attendance status"},
    "risk_tier": {"risk tier", "severity"},
    "owner": {"owner", "business owner", "action owner", "process owner", "register owner", "company account owner",
              "budget owner", "containment owner", "risk owner", "content owner", "reviewer"},
    "system_ref": {"system id", "system or initiative id"},
}
# The column whose date drives reminders, per register (first match wins).
DUE_COLUMN = {
    "ai_systems": "Next review", "approved_tools": "Next review", "risks": "Next review", "decisions": "Review date",
    "incidents": None, "exceptions": "Expiry date", "vendors": "Next review", "obligations": "Next review",
    "training": "Refresher due", "actions": "Due date", "change_log": "Next review", "evidence": "Retention review",
    "access_reviews": "Next review", "knowledge_sources": "Next review", "opportunities": None, "kpi_log": "Review date",
    "budget": "Next review",
}
# Columns that must never be shown to a client in the portal (internal handling detail).
INTERNAL_ONLY = {"Secret storage reference", "Notification decision owner", "Notification decision and basis",
                 "Disagreement or challenge", "Finance validation"}


def shared_strings(z):
    out = []
    if "xl/sharedStrings.xml" in z.namelist():
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall(N + "si"):
            out.append("".join(t.text or "" for t in si.iter(N + "t")))
    return out


def col_index(ref):
    letters = re.match(r"[A-Z]+", ref).group()
    n = 0
    for ch in letters:
        n = n * 26 + ord(ch) - 64
    return n


def sheet_rows(z, ss, path):
    sh = ET.fromstring(z.read(path))
    rows = {}
    for row in sh.iter(N + "row"):
        cells = {}
        for c in row.findall(N + "c"):
            v = c.find(N + "v")
            t = c.get("t")
            if t == "s" and v is not None:
                val = ss[int(v.text)]
            elif t == "inlineStr":
                val = "".join(x.text or "" for x in c.iter(N + "t"))
            else:
                val = v.text if v is not None else ""
            if val != "":
                cells[col_index(c.get("r"))] = val
        if cells:
            rows[int(row.get("r"))] = cells
    return rows


def field_type(label, placeholder):
    l = label.lower()
    if "ENTER DATE" in placeholder or l.endswith(" date") or " date" in l or l in ("detected at", "contained at"):
        return "date"
    if "ENTER NUMBER" in placeholder or "ENTER AMOUNT" in placeholder:
        return "number"
    if any(w in l for w in ("scenario", "what happened", "description", "rationale", "assumptions", "options", "reason",
                            "action required", "problem", "outcome", "caveats", "basis", "limitations", "plan")):
        return "longtext"
    return "text"


def read_registers(xlsx):
    z = zipfile.ZipFile(xlsx)
    ss = shared_strings(z)
    wb = ET.fromstring(z.read("xl/workbook.xml"))
    rels = {r.get("Id"): r.get("Target") for r in ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))}
    sheets = {s.get("name"): "xl/" + rels[s.get(R + "id")].lstrip("/").replace("xl/", "") for s in wb.find(N + "sheets")}
    start = sheet_rows(z, ss, sheets["Start Here"])
    purposes = {}
    for r in start.values():
        if r.get(1) in {t for t, _, _ in REGISTERS} and r.get(2):
            purposes[r[1]] = r[2]
    out = []
    for title, key, prefix in REGISTERS:
        rows = sheet_rows(z, ss, sheets[title])
        header = rows[6]            # column labels
        guide = rows.get(5, {})     # [REPLACE PLACEHOLDER BELOW] / [ENTER DATE BELOW] / [ENTER NUMBER BELOW]
        cols = []
        for idx in sorted(header):
            label = header[idx]
            ftype = field_type(label, guide.get(idx, ""))
            promote = None
            for role, names in PROMOTE.items():
                if label.lower() in names and promote is None:
                    promote = role
            cols.append({
                "field_key": re.sub(r"[^a-z0-9]+", "_", label.lower()).strip("_"), "label": label, "type": ftype,
                "sort": idx, "promote_as": promote, "is_id": idx == min(header),
                "is_due": DUE_COLUMN[key] == label, "client_safe": label not in INTERNAL_ONLY,
            })
        out.append({"register_key": key, "title": title, "prefix": prefix, "purpose": purposes.get(title, ""), "columns": cols})
    return out


def docx_blocks(path):
    z = zipfile.ZipFile(path)
    body = ET.fromstring(z.read("word/document.xml")).find(W + "body")
    blocks = []
    for el in body:
        if el.tag == W + "p":
            st = el.find(f"{W}pPr/{W}pStyle")
            style = st.get(W + "val") if st is not None else ""
            text = "".join(x.text or "" for x in el.iter(W + "t")).strip()
            if text:
                blocks.append(("h" if style.startswith("Heading") or style == "Title" else "p", text))
        elif el.tag == W + "tbl":
            rows = []
            for tr in el.iter(W + "tr"):
                rows.append([" ".join("".join(x.text or "" for x in p.iter(W + "t")) for p in tc.findall(W + "p")).strip()
                             for tc in tr.findall(W + "tc")])
            blocks.append(("table", rows))
    return blocks


def expand_range(spec):
    """'01 to 08; 09 to 13; 37 to 39' / '25 to 30; 32; 35' -> sorted template numbers."""
    nums = set()
    for part in re.split(r"[;,]", spec):
        part = part.strip()
        m = re.match(r"^(\d+)\s+to\s+(\d+)", part)
        if m:
            nums.update(range(int(m.group(1)), int(m.group(2)) + 1))
        else:
            m = re.match(r"^(\d+)", part)
            if m:
                nums.add(int(m.group(1)))
    return sorted(nums)


# Which registers each template mainly feeds (the guide's "documents narrate, registers track").
FEEDS = {
    1: ["decisions", "actions"], 2: ["actions", "evidence"], 3: ["ai_systems", "risks", "actions"],
    4: ["ai_systems", "knowledge_sources"], 5: ["opportunities", "kpi_log", "budget"], 6: ["opportunities", "decisions"],
    7: ["decisions", "risks", "actions"], 8: ["decisions", "change_log", "budget"], 9: ["decisions", "evidence"],
    10: ["approved_tools"], 11: ["risks", "ai_systems"], 12: ["vendors", "approved_tools"], 13: ["ai_systems", "decisions"],
    14: ["incidents", "evidence"], 15: ["incidents", "actions"], 16: ["incidents", "actions", "evidence"],
    17: ["training"], 18: ["exceptions", "risks"], 19: ["ai_systems", "kpi_log", "budget", "decisions"],
    20: ["knowledge_sources", "ai_systems", "access_reviews"], 21: ["kpi_log", "evidence"], 22: ["access_reviews", "evidence", "risks"],
    23: ["decisions", "ai_systems", "evidence"], 24: ["ai_systems", "evidence"], 25: ["change_log", "risks", "decisions"],
    26: ["training", "actions"], 27: ["ai_systems", "incidents"], 28: ["vendors", "ai_systems", "actions"],
    29: ["actions", "decisions"], 30: ["kpi_log", "budget", "decisions"], 31: ["kpi_log", "budget", "decisions"],
    32: ["ai_systems", "kpi_log", "budget", "decisions"], 33: ["kpi_log", "budget", "decisions"], 34: ["decisions", "risks", "budget"],
    35: ["risks", "exceptions", "access_reviews", "actions"], 36: ["ai_systems", "evidence", "training"], 37: ["obligations"],
    38: ["kpi_log", "budget"], 39: ["knowledge_sources"], 40: ["ai_systems", "obligations"],
}


def read_guide(path):
    blocks = docx_blocks(path)
    tables = [b[1] for b in blocks if b[0] == "table"]
    seq = next(t for t in tables if t[0][:2] == ["Milestone", "Templates to start with"])
    directory = next(t for t in tables if t[0][:2] == ["ID", "Template"])
    milestones = {}
    for row in seq[1:]:
        label, spec, gate = row[0], row[1], row[2]
        for n in expand_range(spec.replace("; 40 if applicable", "; 40")):
            milestones.setdefault(n, []).append(label)
    out = []
    for row in directory[1:]:
        n = int(row[0])
        out.append({"number": n, "title": row[1], "when_to_use": row[2], "milestones": milestones.get(n, []), "feeds": FEEDS[n]})
    gates = []
    for row in seq[1:]:
        gates.append({"label": row[0], "start_templates": expand_range(row[1].replace("; 40 if applicable", "; 40")), "gate": row[2]})
    return out, gates


def read_roadmap_gates(path):
    """Acceptance-gate paragraphs and deliverable lists per checkpoint, straight from the roadmap text."""
    blocks = docx_blocks(path)
    gates = {}
    current = None
    for kind, val in blocks:
        if kind == "h" and ("acceptance gate" in val.lower()):
            current = val
            gates[current] = {"heading": val, "text": [], "deliverables": ""}
        elif kind == "h":
            current = None
        elif current and kind == "p":
            if val.startswith("Deliverables"):
                gates[current]["deliverables"] = val
            else:
                gates[current]["text"].append(val)
    return list(gates.values())


def main(xlsx, guide, roadmap, out_dir):
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    regs = read_registers(xlsx)
    directory, seq = read_guide(guide)
    road = read_roadmap_gates(roadmap)
    (out / "registers.json").write_text(json.dumps(regs, indent=1))
    (out / "directory.json").write_text(json.dumps(directory, indent=1))
    (out / "gates.json").write_text(json.dumps({"sequence": seq, "roadmap": road}, indent=1))
    print(f"registers: {len(regs)}, columns: {sum(len(r['columns']) for r in regs)}")
    print(f"templates: {len(directory)}, with a milestone: {sum(1 for d in directory if d['milestones'])}")
    print(f"gates (sequence): {len(seq)}, roadmap acceptance gates found: {len(road)}")


if __name__ == "__main__":
    main(*sys.argv[1:5])
