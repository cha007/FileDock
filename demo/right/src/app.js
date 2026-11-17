import { readFile, writeFile, readdir } from './utils.js';
import { parseConfig } from './config.js';

const config = parseConfig('config.json');

export function loadNotes() {
  // Notes are Markdown files on disk now, one per note.
  const files = readdir(config.dataDir).filter((name) => name.endsWith('.md'));

  return files.map((name) => {
    const body = readFile(`${config.dataDir}/${name}`);
    const firstLine = body.split('\n')[0] ?? '';
    return {
      id: name.replace(/\.md$/, ''),
      title: firstLine.replace(/^#\s*/, '') || name,
      body,
    };
  });
}

export function saveNotes(notes) {
  for (const note of notes) {
    writeFile(`${config.dataDir}/${note.id}.md`, note.body);
  }
  console.log(`saved ${notes.length} notes`);
}

export function findNotes(query) {
  const notes = loadNotes();
  const needle = query.toLowerCase();

  return notes.filter((note) => {
    return (
      note.title.toLowerCase().includes(needle) ||
      note.body.toLowerCase().includes(needle)
    );
  });
}
