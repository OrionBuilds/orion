import { describe, expect, it } from 'vitest';
import { resolveWikilink, wikilinksToMarkdown } from './wikilinks';

describe('wikilinksToMarkdown', () => {
  it('turns [[Target]], [[Target|alias]] and [[Target#heading]] into wikilink: markdown links', () => {
    expect(wikilinksToMarkdown('See [[Project Plan]].')).toBe('See [Project Plan](wikilink:Project%20Plan).');
    expect(wikilinksToMarkdown('[[Clients/Umbrella Roofing|Umbrella Roofing]]')).toBe('[Umbrella Roofing](wikilink:Clients%2FUmbrella%20Roofing)');
    expect(wikilinksToMarkdown('[[Daily#Tasks]]')).toBe('[Daily](wikilink:Daily)');
  });

  it('leaves ordinary markdown and single brackets alone', () => {
    const md = '# Title\n[link](https://example.com) and [x] task';
    expect(wikilinksToMarkdown(md)).toBe(md);
  });
});

describe('resolveWikilink', () => {
  const nodes = [
    { id: '02 Projects/Project Plan.md', title: 'Project Plan' },
    { id: 'Clients/Umbrella Roofing.md', title: 'Umbrella Roofing' },
  ];

  it('resolves by title case-insensitively, like Obsidian', () => {
    expect(resolveWikilink('project plan', nodes)).toBe('02 Projects/Project Plan.md');
  });

  it('resolves a path-style target with or without .md', () => {
    expect(resolveWikilink('Clients/Umbrella Roofing', nodes)).toBe('Clients/Umbrella Roofing.md');
    expect(resolveWikilink('Clients/Umbrella Roofing.md', nodes)).toBe('Clients/Umbrella Roofing.md');
  });

  it('returns null when the note does not exist', () => {
    expect(resolveWikilink('Missing', nodes)).toBeNull();
  });
});
