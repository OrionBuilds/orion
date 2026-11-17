import { describe, expect, it, vi } from 'vitest';
import { SentenceSegmenter } from './sentenceSegmenter';

function collect(): { sentences: string[]; callback: (s: string) => void } {
  const sentences: string[] = [];
  return { sentences, callback: (s: string) => sentences.push(s) };
}

describe('SentenceSegmenter', () => {
  it('emits a sentence once terminal punctuation is followed by whitespace or end of buffer', () => {
    const { sentences, callback } = collect();
    const segmenter = new SentenceSegmenter(callback);

    segmenter.push('Hello there.');
    expect(sentences).toEqual(['Hello there.']);

    segmenter.push(' How are you? ');
    expect(sentences).toEqual(['Hello there.', 'How are you?']);
  });

  it('splits multiple sentences arriving in a single token', () => {
    const { sentences, callback } = collect();
    new SentenceSegmenter(callback).push('One. Two! Three?');
    expect(sentences).toEqual(['One.', 'Two!', 'Three?']);
  });

  it('assembles sentences across streamed tokens', () => {
    const { sentences, callback } = collect();
    const segmenter = new SentenceSegmenter(callback);
    for (const token of ['Book', 'ing ', 'confirmed', ' for ', 'Friday', '.']) {
      segmenter.push(token);
    }
    expect(sentences).toEqual(['Booking confirmed for Friday.']);
  });

  it('does not break on abbreviations or decimal numbers', () => {
    const { sentences, callback } = collect();
    const segmenter = new SentenceSegmenter(callback);
    segmenter.push('Dr. Smith owes 12.50 dollars');
    expect(sentences).toEqual([]);
    segmenter.flush();
    expect(sentences).toEqual(['Dr. Smith owes 12.50 dollars']);
  });

  it('flushes the remaining buffer and clears it', () => {
    const { sentences, callback } = collect();
    const segmenter = new SentenceSegmenter(callback);
    segmenter.push('no terminator here');
    segmenter.flush();
    segmenter.flush();
    expect(sentences).toEqual(['no terminator here']);
  });

  it('force-breaks on a clause boundary once the buffer exceeds the word limit', () => {
    const callback = vi.fn();
    const segmenter = new SentenceSegmenter(callback);
    segmenter.push(`${'word '.repeat(40)},`);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0][0].endsWith(',')).toBe(true);
    segmenter.flush();
    expect(callback).toHaveBeenCalledTimes(1);
  });
});
