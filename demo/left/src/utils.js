import { promises as fs } from 'fs';
import path from 'path';

export async function readFile(filePath) {
  return fs.readFile(filePath, 'utf8');
}

export async function writeFile(filePath, contents) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, 'utf8');
}

export function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

export function slugify(title) {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-');
}
