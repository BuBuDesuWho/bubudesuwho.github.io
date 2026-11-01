import { describe, it, expect } from 'vitest';
import { portraitFolders, portraitUrls } from './bubudle-faces';

// The tile DOM is checked in the browser (no jsdom here); these are the pure parts.

describe('portraitFolders', () => {
  it("looks in the parent group's folder first for a member the parent has", () => {
    expect(portraitFolders('saint-aqours-snow', 'aqours', 'aqours', true)).toEqual(['aqours', 'saint-aqours-snow']);
  });
  it("looks in the collab group's own folder first for its guests", () => {
    expect(portraitFolders('saint-aqours-snow', 'aqours', 'aqours', false)).toEqual(['saint-aqours-snow', 'aqours']);
  });
  it('is just the group when it has no parent', () => {
    expect(portraitFolders('liella', undefined, 'liella', false)).toEqual(['liella']);
  });
  it('falls back to the page group when the song group differs', () => {
    expect(portraitFolders('aqours-miku', 'aqours', 'muse', false)).toEqual(['aqours-miku', 'aqours', 'muse']);
  });
});

describe('portraitUrls', () => {
  it('builds one URL per folder under the content base', () => {
    expect(portraitUrls('/', ['saint-aqours-snow', 'aqours'], 10)).toEqual([
      '/css/images/members/saint-aqours-snow/10.webp',
      '/css/images/members/aqours/10.webp',
    ]);
  });
});
