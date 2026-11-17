// Full-text search with simple highlighting.
import { loadNotes } from './app.js';

const STOP_WORDS = new Set(['the', 'a', 'an', 'of', 'to', 'and']);

export function searchNotes(query) {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term && !STOP_WORDS.has(term));

  if (terms.length === 0) {
    return [];
  }

  return loadNotes()
    .map((note) => {
      const haystack = `${note.title}\n${note.body}`.toLowerCase();
      const score = terms.reduce(
        (total, term) => total + (haystack.includes(term) ? 1 : 0),
        0,
      );
      return { note, score };
    })
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((result) => result.note);
}
