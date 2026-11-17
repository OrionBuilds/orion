/**
 * Inbound prompt-injection defence (ported from CLARA's injection.ts).
 *
 * Two pure layers: (1) canary tokens (proof of prompt exfiltration, so always a hard block) and
 * (2) a deterministic heuristic over the common injection shapes. Keyword matches are fail-open by
 * default (log + page the owner; the reply still proceeds) because the matcher is string-based and
 * a false positive must not suppress a legitimate message. CLARA_INJECTION_HARD=1 flips matches to
 * hard-suppress.
 */
import type { Env } from "./phones.ts";

export interface InjectionVerdict {
  triggered: boolean;
  reasons: string[];
  canaryLeak?: string;
  hardBlock: boolean;
}

// Single-line patterns only: cross-line matching risks catching innocuous multi-sentence text.
const PATTERNS: Array<[RegExp, string]> = [
  [/\b(ignore|disregard|forget)\s+(all\s+)?(prior|previous|earlier|above|the)\s+(instructions?|prompts?|rules?|context)/i, "ignore-previous-instructions"],
  [/\byou\s+are\s+now\s+(a|an|the)\b/i, "role-override"],
  [/\bnew\s+(system|role|persona|instructions?)[:\s]/i, "new-system-role"],
  [/\bpretend\s+(you|to\s+be)/i, "pretend-to-be"],
  [/\bact\s+as\s+(a|an|the|if)\b/i, "act-as-different-role"],
  [/\b(reveal|show|print|repeat|output|display)\s+(your|the)\s+(system\s+)?(prompt|instructions?|rules?)/i, "prompt-exfiltration"],
  [/\bwhat\s+(are|were)\s+your\s+(system\s+)?(instructions?|prompts?|rules?)/i, "prompt-exfiltration-question"],
  [/\b(DAN|jailbreak|developer\s+mode)\b/i, "jailbreak-phrase"],
  [/\bbypass\s+(your|the)\s+(safety|rules?|restrictions?|filters?)/i, "bypass-safety"],
  [/\bapprove\s+(the|all|any|my)\s+(pending|open|next)?\s*approvals?/i, "approve-approvals-command"],
  [/\b(placeApprovedBusinessCall|findBusiness|mergeDocuments|notifyOwner|queueApproval|dispatchApproval|CLARA_(?:DISABLE_AUTH|SESSION_SECRET))\b/i, "tool-name-callout"],
  [/(?:<\/system>|<\/instructions>|```\s*end\s+of\s+system)/i, "delimiter-smuggling"],
  [/\b(curl|wget|fetch)\s+http[s]?:\/\//i, "shell-command-injection"],
];

export function detectPromptInjection(text: string | undefined, env: Env): InjectionVerdict {
  const s = String(text ?? "");
  if (!s.trim()) return { triggered: false, reasons: [], hardBlock: false };

  const reasons: string[] = [];
  let canaryLeak: string | undefined;
  const canaries = (env.get("CLARA_PROMPT_CANARIES") ?? "").split(",").map((c) => c.trim()).filter(Boolean);
  for (const canary of canaries) {
    if (s.includes(canary)) {
      canaryLeak = canary;
      reasons.push(`canary-leak:${canary.slice(0, 12)}`);
      break;
    }
  }
  for (const [re, label] of PATTERNS) if (re.test(s)) reasons.push(label);
  // Owner impersonation: owner commands are gated by verified phone, never by claimed identity in text.
  const first = (env.get("OWNER_FIRST_NAME") ?? "").trim().replace(/[^\p{L}' -]/gu, "");
  if (first) {
    const n = first.replace(/\s+/g, "\\s+");
    const re = new RegExp(`\\b(this\\s+is\\s+${n}|${n}\\s+here|from\\s+${n}|on\\s+behalf\\s+of\\s+${n}|${n}\\s+(said|asked|told)\\s+me)\\b`, "i");
    if (re.test(s)) reasons.push("owner-impersonation");
  }

  const triggered = reasons.length > 0;
  const hard = (env.get("CLARA_INJECTION_HARD") ?? "").trim() === "1";
  return { triggered, reasons, canaryLeak, hardBlock: Boolean(canaryLeak) || (triggered && hard) };
}
