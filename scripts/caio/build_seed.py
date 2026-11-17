#!/usr/bin/env python3
"""Build the CAIO module's seed migrations from data/*.json and templates/*.md (standard library only).

  python3 -I build_seed.py <migrations-dir>

writes
  20261105100100_caio_reference_seed.sql   registers, fields (with dropdown vocabularies), gate definitions
  20261105100200_caio_templates_seed.sql   the 40 templates for every organization (HTML + seed hash)

Re-seeding is safe: reference rows are upserted; a template is only rewritten when its seed hash changed AND the
owner has not edited it in the app (source stays 'seed' until he does).
"""
import hashlib, html, json, re, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent

# ── dropdown vocabularies (proposed; the workbook has none). Keyed by (register_key, column label). ──
TIER = ["Low", "Medium", "High"]
CLASS = ["Public", "Confidential", "Restricted"]
PRIORITY = ["Low", "Medium", "High", "Critical"]
VOCAB = {
    ("ai_systems", "Data classification"): CLASS,
    ("ai_systems", "Autonomy level"): ["Suggest only", "Draft for approval", "Act within limits", "Act then report"],
    ("ai_systems", "Risk tier"): TIER,
    ("ai_systems", "Status"): ["Proposed", "In review", "Approved", "Pilot", "Production", "Suspended", "Retired"],
    ("approved_tools", "Approval status"): ["Proposed", "Approved", "Conditional", "Rejected", "Retired"],
    ("risks", "Inherent likelihood"): TIER, ("risks", "Inherent impact"): TIER,
    ("risks", "Residual likelihood"): TIER, ("risks", "Residual impact"): TIER,
    ("risks", "Risk tier"): TIER,
    ("risks", "Treatment decision"): ["Reduce", "Avoid", "Transfer", "Accept"],
    ("risks", "Status"): ["Open", "Treating", "Accepted", "Closed"],
    ("decisions", "Status"): ["Proposed", "Decided", "Deferred", "Superseded"],
    ("incidents", "Severity"): ["Low", "Medium", "High", "Critical"],
    ("incidents", "Status"): ["Open", "Contained", "Recovering", "Closed"],
    ("exceptions", "Status"): ["Requested", "Approved", "Expired", "Revoked", "Closed"],
    ("vendors", "Critical dependency"): ["Yes", "No"],
    ("vendors", "Decision"): ["Under review", "Approved", "Conditional", "Rejected", "Retired"],
    ("obligations", "Status"): ["Candidate", "Applies", "Not applicable", "Actioned", "Under review"],
    ("training", "Attendance status"): ["Scheduled", "Attended", "Missed", "Excused"],
    ("training", "Comprehension result"): ["Pass", "Needs remediation", "Not assessed"],
    ("training", "Remediation needed"): ["Yes", "No"],
    ("actions", "Priority"): PRIORITY,
    ("actions", "Status"): ["Open", "In progress", "Blocked", "Done", "Closed"],
    ("change_log", "Status"): ["Requested", "In review", "Approved", "Released", "Rolled back", "Rejected"],
    ("evidence", "Classification"): CLASS,
    ("evidence", "Status"): ["Current", "Needs refresh", "Superseded", "Retired"],
    ("access_reviews", "Human or service"): ["Human", "Service"],
    ("access_reviews", "Environment"): ["Test", "Production"],
    ("access_reviews", "Status"): ["Open", "Reviewed", "Change required", "Revoked"],
    ("knowledge_sources", "Classification"): CLASS,
    ("knowledge_sources", "Status"): ["Proposed", "Approved", "Needs refresh", "Retired"],
    ("opportunities", "AI or ordinary automation"): ["AI", "Ordinary automation", "Either"],
    ("opportunities", "Build buy or wait"): ["Build", "Buy", "Wait"],
    ("opportunities", "Data readiness"): ["Ready", "Partly ready", "Not ready"],
    ("opportunities", "Risk tier"): TIER,
    ("opportunities", "Priority"): TIER,
    ("opportunities", "Decision"): ["Backlog", "Approved for pilot", "Deferred", "Rejected"],
    ("kpi_log", "Metric type"): ["Time made available", "Quality and reliability", "Adoption", "Governance coverage", "Net financial benefit", "Risk and incidents"],
    ("kpi_log", "Finance validation"): ["Not validated", "Validated", "Disputed"],
    ("budget", "One-time or recurring"): ["One-time", "Recurring"],
    ("budget", "Estimate or actual"): ["Estimate", "Actual"],
    ("budget", "Approval status"): ["Draft", "Approved", "Rejected"],
}

# ── gate acceptance conditions (from the roadmap's acceptance-gate paragraphs) ──
GATES = [
    ("day_30", "Day 30", 1, "30 days", "Authority, inventory and interim data rules in place; baseline and an approved, bounded pilot.", [
        "The sponsor approves the CAIO charter and decision authority",
        "The sponsor approves the initial AI inventory, with the coverage gaps recorded explicitly",
        "The sponsor accepts the priority risks and the prioritized backlog",
        "The sponsor approves the first pilot charter",
        "The business owner confirms the baseline",
        "IT confirms a suitable test environment and authorized data access"]),
    ("day_60", "Day 60", 2, "60 days", "Pilot tested beside the existing process within approved boundaries; governance controls adopted.", [
        "The business owner validates the pilot test results",
        "IT and security verify the controls (off switch and manual fallback tested)",
        "The CAIO has recorded a recommendation: continue, revise or stop",
        "Any limited live release has separately documented scope, approved users, monitoring, cost limits and rollback",
        "Any material unresolved risk has a written decision from the sponsor"]),
    ("day_90", "Day 90", 3, "90 days", "A measured production decision, or a documented stop and safe decommissioning.", [
        "The sponsor has recorded the budget and risk decision: production, extension or stop",
        "The process owner has accepted the workflow",
        "IT and security have signed off within their remit",
        "The release record links the evaluation, controls, trained users, runbook, monitoring, fallback and owner (or the stop record and decommissioning exist)",
        "The incident exercise shows a named person can stop the workflow, preserve evidence, switch to the manual process and restore service",
        "A named internal owner holds daily operations"]),
    ("month_6", "Month 6", 4, "6 months", "Controls tested and the portfolio reviewed; proven workflows expanded selectively.", [
        "The sponsor approves the portfolio decisions and the next budget",
        "Finance validates the reported economic treatment",
        "Process owners demonstrate sustained use and operational ownership",
        "IT verifies access and recovery controls",
        "The AI register is reconciled with procurement, IT access, integrations and departmental use",
        "Corrective actions from the live incident exercise have owners and due dates"]),
    ("month_12", "Month 12", 5, "12 months", "Annual review done, accountability renewed, validated results and next year's plan.", [
        "Leadership accepts the annual report, residual risks, next-year priorities, owners and budget",
        "Renew, scale, redesign and retire decisions are recorded for every system and vendor",
        "The continuity review is complete: company-owned records and accounts, tested runbooks, trained backups and support coverage",
        "The company can show what AI runs, who approved it, how it is measured, what happens on failure and who can operate it independently",
        "The decision on continued CAIO leadership, an internal lead, specialist support or a mix is recorded"]),
]
GATE_KEY_BY_LABEL = {"Days 1 to 30": "day_30", "Days 31 to 60": "day_60", "Days 61 to 90": "day_90", "Months 4 to 6": "month_6", "Months 7 to 12": "month_12"}


def dq(s):
    """Dollar-quote a string with a tag that cannot occur inside it."""
    tag = "q" + hashlib.sha256(s.encode()).hexdigest()[:10]
    return f"${tag}${s}${tag}$"


def sql_text_array(vals):
    return "ARRAY[" + ", ".join(dq(v) for v in vals) + "]::text[]" if vals else "'{}'::text[]"


# ── Markdown (the subset SPEC.md allows) -> HTML ──
INLINE_CODE = re.compile(r"`([^`]+)`")
BOLD = re.compile(r"\*\*(.+?)\*\*")
ITAL = re.compile(r"(?<!\*)\*(?!\s)([^*]+?)(?<!\s)\*(?!\*)")
LINK = re.compile(r"\[([^\]]+)\]\((https?://[^)\s]+)\)")


def inline(s):
    s = html.escape(s, quote=False)
    s = INLINE_CODE.sub(r"<code>\1</code>", s)
    s = BOLD.sub(r"<strong>\1</strong>", s)
    s = LINK.sub(lambda m: f'<a href="{m.group(2)}" rel="noopener noreferrer">{m.group(1)}</a>', s)
    s = ITAL.sub(r"<em>\1</em>", s)
    return s


def table(lines):
    rows = [[c.strip() for c in ln.strip().strip("|").split("|")] for ln in lines]
    head, body = rows[0], rows[2:]
    out = ["<table><thead><tr>" + "".join(f"<th>{inline(c)}</th>" for c in head) + "</tr></thead><tbody>"]
    for r in body:
        r = (r + [""] * len(head))[:len(head)]
        out.append("<tr>" + "".join(f"<td>{inline(c)}</td>" for c in r) + "</tr>")
    out.append("</tbody></table>")
    return "".join(out)


def md_to_html(md):
    lines = md.splitlines()
    out, i = [], 0
    while i < len(lines):
        ln = lines[i]
        if not ln.strip():
            i += 1
            continue
        m = re.match(r"^(#{1,3}) (.+)$", ln)
        if m:
            n = len(m.group(1))
            out.append(f"<h{n}>{inline(m.group(2).strip())}</h{n}>")
            i += 1
        elif ln.lstrip().startswith("|") and i + 1 < len(lines) and re.match(r"^\s*\|[\s:|-]+\|\s*$", lines[i + 1]):
            j = i
            while j < len(lines) and lines[j].lstrip().startswith("|"):
                j += 1
            out.append(table(lines[i:j]))
            i = j
        elif re.match(r"^\s*[-*] ", ln):
            items = []
            while i < len(lines) and re.match(r"^\s*[-*] ", lines[i]):
                t = re.sub(r"^\s*[-*] ", "", lines[i])
                box = re.match(r"^\[( |x|X)\] (.*)$", t)
                items.append(("☑ " if box and box.group(1).lower() == "x" else "☐ ") + box.group(2) if box else t)
                i += 1
            out.append("<ul>" + "".join(f"<li>{inline(t)}</li>" for t in items) + "</ul>")
        elif re.match(r"^\s*\d+[.)] ", ln):
            items = []
            while i < len(lines) and re.match(r"^\s*\d+[.)] ", lines[i]):
                items.append(re.sub(r"^\s*\d+[.)] ", "", lines[i]))
                i += 1
            out.append("<ol>" + "".join(f"<li>{inline(t)}</li>" for t in items) + "</ol>")
        elif ln.startswith(">"):
            q = []
            while i < len(lines) and lines[i].startswith(">"):
                q.append(lines[i].lstrip("> ").rstrip())
                i += 1
            out.append("<blockquote><p>" + inline(" ".join(q)) + "</p></blockquote>")
        else:
            p = []
            while i < len(lines) and lines[i].strip() and not re.match(r"^(#{1,3} |\s*[-*] |\s*\d+[.)] |>|\s*\|)", lines[i]):
                p.append(lines[i].strip())
                i += 1
            if not p:                 # a line that matched none of the block rules: treat as a paragraph
                p = [lines[i].strip()]
                i += 1
            out.append("<p>" + inline(" ".join(p)) + "</p>")
    return "\n".join(out)


def front_matter(text):
    m = re.match(r"^---\n(.*?)\n---\n", text, re.S)
    meta = {}
    for line in m.group(1).splitlines():
        k, v = line.split(":", 1)
        meta[k.strip()] = v.strip()
    return meta, text[m.end():]


def reference_sql():
    regs = json.loads((HERE / "data" / "registers.json").read_text())
    road = json.loads((HERE / "data" / "gates.json").read_text())
    directory = json.loads((HERE / "data" / "directory.json").read_text())
    seq = {GATE_KEY_BY_LABEL[g["label"]]: g for g in road["sequence"]}
    deliv = {}
    for g in road["roadmap"]:
        key = {"Day 30": "day_30", "Day 60": "day_60", "Day 90": "day_90", "Six month": "month_6", "Twelve month": "month_12"}
        for prefix, gk in key.items():
            if g["heading"].startswith(prefix):
                deliv[gk] = re.sub(r"^Deliverables:\s*", "", g["deliverables"]).strip()
    out = ["-- Generated by scripts/caio/build_seed.py from the owner's registers workbook, delivery guide and roadmap. Do not edit by hand.",
           "-- Reference data for the CAIO module: the 17 registers, their fields and dropdown vocabularies, the five gates.\n"]
    for sort, r in enumerate(regs, 1):
        out.append(f"INSERT INTO public.caio_registers (register_key, title, prefix, purpose, sort) VALUES ({dq(r['register_key'])}, {dq(r['title'])}, {dq(r['prefix'])}, {dq(r['purpose'])}, {sort})\n"
                   f"ON CONFLICT (register_key) DO UPDATE SET title = EXCLUDED.title, prefix = EXCLUDED.prefix, purpose = EXCLUDED.purpose, sort = EXCLUDED.sort;")
        keys = set()
        for c in r["columns"]:
            assert c["field_key"] not in keys, f"duplicate field key {r['register_key']}.{c['field_key']}"
            keys.add(c["field_key"])
            opts = VOCAB.get((r["register_key"], c["label"]))
            ftype = "select" if opts else c["type"]
            options = f"{dq(json.dumps(opts))}::jsonb" if opts else "NULL"
            promote = dq(c["promote_as"]) if c["promote_as"] else "NULL"
            out.append(f"INSERT INTO public.caio_register_fields (register_key, field_key, label, ftype, sort, options, promote_as, is_id, is_due, client_safe) VALUES "
                       f"({dq(r['register_key'])}, {dq(c['field_key'])}, {dq(c['label'])}, {dq(ftype)}, {c['sort']}, {options}, {promote}, {str(c['is_id']).lower()}, {str(c['is_due']).lower()}, {str(c['client_safe']).lower()})\n"
                       f"ON CONFLICT (register_key, field_key) DO UPDATE SET label = EXCLUDED.label, ftype = EXCLUDED.ftype, sort = EXCLUDED.sort, options = EXCLUDED.options, "
                       f"promote_as = EXCLUDED.promote_as, is_id = EXCLUDED.is_id, is_due = EXCLUDED.is_due, client_safe = EXCLUDED.client_safe;")
    for gate_key, label, sort, after, objective, conds in GATES:
        req = seq[gate_key]["start_templates"]
        out.append(f"INSERT INTO public.caio_gate_defs (gate_key, label, sort, due_after, objective, conditions, deliverables, required_templates) VALUES "
                   f"({dq(gate_key)}, {dq(label)}, {sort}, {dq(after)}::interval, {dq(objective)}, {dq(json.dumps(conds))}::jsonb, {dq(deliv.get(gate_key, ''))}, ARRAY{req}::integer[])\n"
                   f"ON CONFLICT (gate_key) DO UPDATE SET label = EXCLUDED.label, sort = EXCLUDED.sort, due_after = EXCLUDED.due_after, objective = EXCLUDED.objective, "
                   f"conditions = EXCLUDED.conditions, deliverables = EXCLUDED.deliverables, required_templates = EXCLUDED.required_templates;")
    return "\n".join(out) + "\n"


def templates_sql():
    directory = {t["number"]: t for t in json.loads((HERE / "data" / "directory.json").read_text())}
    rows = []
    for f in sorted((HERE / "templates").glob("[0-9][0-9]-*.md")):
        meta, body = front_matter(f.read_text())
        n = int(meta["number"])
        d = directory[n]
        body = re.sub(r"^# .+\n", "", body, count=1).lstrip("\n")          # the page title is the template's title field
        htm = md_to_html(body)
        h = hashlib.sha256((htm + d["title"]).encode()).hexdigest()
        rows.append(f"({n}, {dq(meta['slug'])}, {dq(d['title'])}, {dq(d['when_to_use'])}, {sql_text_array(d['milestones'])}, {sql_text_array(d['feeds'])}, {dq(htm)}, {dq(h)})")
    assert len(rows) == 40, f"expected 40 templates, found {len(rows)}"
    return ("-- Generated by scripts/caio/build_seed.py from scripts/caio/templates/*.md. Do not edit by hand.\n"
            "-- The 40 CAIO deliverable templates, for every organization. A template is rewritten only when its seed hash\n"
            "-- changed AND it is still 'seed' (the owner has not edited it in the app).\n"
            "DO $$\nDECLARE org uuid;\nBEGIN\n  PERFORM set_config('caio.seeding', 'on', true);\n  FOR org IN SELECT id FROM public.organizations LOOP\n"
            "    INSERT INTO public.caio_templates (org_id, number, slug, title, when_to_use, milestones, feeds, body_html, source, seed_hash)\n"
            "    SELECT org, v.number, v.slug, v.title, v.when_to_use, v.milestones, v.feeds, v.body_html, 'seed', v.seed_hash\n"
            "    FROM (VALUES\n" + ",\n".join(rows) + "\n    ) AS v(number, slug, title, when_to_use, milestones, feeds, body_html, seed_hash)\n"
            "    ON CONFLICT (org_id, number) DO UPDATE SET slug = EXCLUDED.slug, title = EXCLUDED.title, when_to_use = EXCLUDED.when_to_use,\n"
            "      milestones = EXCLUDED.milestones, feeds = EXCLUDED.feeds, body_html = EXCLUDED.body_html, seed_hash = EXCLUDED.seed_hash, source = 'seed'\n"
            "    WHERE public.caio_templates.source = 'seed' AND public.caio_templates.seed_hash IS DISTINCT FROM EXCLUDED.seed_hash;\n"
            "  END LOOP;\nEND $$;\n")


def main(mig_dir):
    d = Path(mig_dir)
    (d / "20261105100100_caio_reference_seed.sql").write_text(reference_sql())
    (d / "20261105100200_caio_templates_seed.sql").write_text(templates_sql())
    print("wrote reference seed and templates seed to", d)


if __name__ == "__main__":
    main(sys.argv[1])
