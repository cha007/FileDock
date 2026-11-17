// Legacy XML export kept for the old desktop client.
// Remove after the 2.0 release.
import { loadNotes } from './app.js';

export function exportXml() {
  const notes = loadNotes();
  const items = notes
    .map((note) => `  <note id="${note.id}"><title>${note.title}</title></note>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>\n<notes>\n${items}\n</notes>\n`;
}
