import { useCallback, useEffect, useRef, useState } from 'react';

interface RecognitionResult { isFinal: boolean; 0: { transcript: string } }
interface RecognitionEvent { resultIndex: number; results: ArrayLike<RecognitionResult> }
interface Recognition {
  lang: string; continuous: boolean; interimResults: boolean;
  onresult: ((e: RecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  start(): void; stop(): void; abort(): void;
}
type RecognitionCtor = new () => Recognition;

function ctor(): RecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function speechSupported(): boolean {
  return ctor() !== null;
}

/** Joins what was already typed with a dictated phrase, with exactly one space between. */
export function appendDictation(base: string, spoken: string): string {
  const s = spoken.trim();
  if (!s) return base;
  const b = base.replace(/\s+$/, '');
  return b ? `${b} ${s}` : s;
}

/**
 * Dictation for the composer: tap the mic, talk, and the text lands in the box (interim words as you speak).
 * Uses the browser's own speech recognition, so it exists on Chrome/Android and Safari but not everywhere.
 */
export function useSpeechInput(getBase: () => string, onText: (text: string) => void) {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<Recognition | null>(null);
  const base = useRef('');
  const supported = speechSupported();

  const stop = useCallback(() => { rec.current?.stop(); }, []);

  const start = useCallback(() => {
    const C = ctor();
    if (!C || rec.current) return;
    setError(null);
    base.current = getBase();
    const r = new C();
    r.lang = navigator.language || 'en-US';
    r.continuous = false;
    r.interimResults = true;
    r.onresult = (e) => {
      let spoken = '';
      for (let i = 0; i < e.results.length; i++) spoken += e.results[i][0].transcript;
      onText(appendDictation(base.current, spoken));
    };
    r.onerror = (e) => setError(e.error === 'not-allowed' ? 'Microphone permission was denied' : e.error === 'no-speech' ? null : 'Dictation stopped');
    r.onend = () => { rec.current = null; setListening(false); };
    rec.current = r;
    setListening(true);
    try { r.start(); } catch { rec.current = null; setListening(false); }
  }, [getBase, onText]);

  useEffect(() => () => { rec.current?.abort(); rec.current = null; }, []);

  return { supported, listening, error, start, stop };
}
