# Aurora Notes

A tiny note-taking service used as the FileDock demo project.
FileDock opens both sides side by side so you can compare them.

## Getting started

```bash
npm install
npm run start:dev
```

The server listens on port **4100** by default (configurable with `PORT`).
Notes are stored as Markdown files under `notes/`, one file per note.

## Features

- Autosave every 2 seconds
- Full-text search with highlighted matches
- Export to PDF (experimental)
