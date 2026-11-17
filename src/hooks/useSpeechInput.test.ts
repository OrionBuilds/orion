import { describe, it, expect } from 'vitest';
import { appendDictation, speechSupported } from './useSpeechInput';

describe('appendDictation', () => {
  it('adds the spoken phrase after what was typed with a single space', () => {
    expect(appendDictation('Email Blake', 'about the proposal')).toBe('Email Blake about the proposal');
    expect(appendDictation('Email Blake   ', '  about the proposal ')).toBe('Email Blake about the proposal');
  });
  it('starts from nothing and ignores silence', () => {
    expect(appendDictation('', 'what is on today')).toBe('what is on today');
    expect(appendDictation('keep this', '   ')).toBe('keep this');
  });
});

describe('speechSupported', () => {
  it('is false where the browser has no recognition (jsdom)', () => {
    expect(speechSupported()).toBe(false);
  });
});
