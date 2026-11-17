import { readFile, writeFile } from './utils.js';
import { parseConfig } from './config.js';

const config = parseConfig('config.json');

export function loadNotes() {
  const raw = readFile(config.dataDir + '/notes.json');
  if (!raw) {
    return [];
  }
  return JSON.parse(raw);
}

export function saveNotes(notes) {
  writeFile(config.dataDir + '/notes.json', JSON.stringify(notes, null, 2));
  console.log(`saved ${notes.length} notes`);
}

export function findNotes(query) {
  const notes = loadNotes();
  const needle = query.toLowerCase();

  return notes.filter((note) => {
    return note.title.toLowerCase().includes(needle);
  });
}
