import type { CallState } from "./types.ts";
import { whoLabel } from "./work-line.ts";

/** The label the hold text and whisper use for this caller. */
export const holdWho = (s: Pick<CallState, "learned" | "profile" | "fromE164">) => whoLabel(s.learned, s.profile, s.fromE164);
