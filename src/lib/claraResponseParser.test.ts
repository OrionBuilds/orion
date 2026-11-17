import { describe, expect, it } from 'vitest';
import { extractCleanResponse } from './claraResponseParser';

describe('extractCleanResponse', () => {
  it('returns non-JSON text unchanged', () => {
    expect(extractCleanResponse('Just a plain answer.')).toBe('Just a plain answer.');
    expect(extractCleanResponse('')).toBe('');
  });

  it('extracts the first populated known key from JSON payloads', () => {
    expect(extractCleanResponse('{"response_to_user":"Hi there"}')).toBe('Hi there');
    expect(extractCleanResponse('  {"summary":"Short summary"}  ')).toBe('Short summary');
    expect(extractCleanResponse('{"response_to_user":"","message":"fallback key"}')).toBe(
      'fallback key'
    );
  });

  it('prefers response_to_user over other keys', () => {
    const raw = '{"message":"second","response_to_user":"first"}';
    expect(extractCleanResponse(raw)).toBe('first');
  });

  it('returns the raw payload when no known key holds a string', () => {
    const raw = '{"other":"value"}';
    expect(extractCleanResponse(raw)).toBe(raw);
    expect(extractCleanResponse('{"response":123}')).toBe('{"response":123}');
  });

  it('recovers response_to_user from truncated JSON via regex fallback', () => {
    expect(extractCleanResponse('{"response_to_user":"Partial output", "tool')).toBe(
      'Partial output'
    );
    expect(extractCleanResponse('{"response_to_user":"Line one\\nLine two", "x')).toBe(
      'Line one\nLine two'
    );
  });

  it('returns the raw payload when broken JSON has no recoverable key', () => {
    const raw = '{"unfinished": tru';
    expect(extractCleanResponse(raw)).toBe(raw);
  });
});
