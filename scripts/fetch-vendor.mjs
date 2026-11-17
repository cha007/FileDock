import fs from 'node:fs/promises';
import path from 'node:path';

const VERSION = '5.65.18';
const BASE = `https://unpkg.com/codemirror@${VERSION}/`;
const OUT = path.join(process.cwd(), 'public', 'vendor', 'codemirror');

const files = [
  'lib/codemirror.js',
  'lib/codemirror.css',
  'addon/dialog/dialog.js',
  'addon/dialog/dialog.css',
  'addon/search/search.js',
  'addon/search/searchcursor.js',
  'addon/search/jump-to-line.js',
  'addon/search/match-highlighter.js',
  'addon/edit/closebrackets.js',
  'addon/edit/matchbrackets.js',
  'addon/edit/closetag.js',
  'addon/edit/trailingspace.js',
  'addon/selection/active-line.js',
  'addon/fold/foldcode.js',
  'addon/fold/foldgutter.js',
  'addon/fold/brace-fold.js',
  'addon/fold/foldgutter.css',
  'addon/comment/comment.js',
  'addon/display/placeholder.js',
  'mode/javascript/javascript.js',
  'mode/xml/xml.js',
  'mode/css/css.js',
  'mode/htmlmixed/htmlmixed.js',
  'mode/markdown/markdown.js',
  'mode/python/python.js',
  'mode/clike/clike.js',
  'mode/c/clike.js',
  'mode/cpp/cpp.js',
  'mode/java/java.js',
  'mode/csharp/csharp.js',
  'mode/sql/sql.js',
  'mode/shell/shell.js',
  'mode/yaml/yaml.js',
  'mode/go/go.js',
  'mode/rust/rust.js',
  'mode/php/php.js',
  'mode/properties/properties.js',
  'mode/diff/diff.js',
  'mode/powershell/powershell.js',
  'mode/lua/lua.js',
  'mode/dockerfile/dockerfile.js',
  'mode/toml/toml.js',
  'mode/vb/vb.js',
  'mode/swift/swift.js',
  'mode/perl/perl.js',
  'mode/r/r.js',
  'mode/sass/sass.js',
  'mode/less/less.js',
  'mode/groovy/groovy.js',
  'mode/coffeescript/coffeescript.js',
  'mode/clojure/clojure.js',
  'mode/dart/dart.js',
  'mode/asciiarmor/asciiarmor.js',
];

let ok = 0;
for (const rel of files) {
  const url = BASE + rel;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`  ! skip ${rel} (${res.status})`);
      continue;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const dest = path.join(OUT, rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, buf);
    ok++;
  } catch (err) {
    console.warn(`  ! fail ${rel}: ${err.message}`);
  }
}
console.log(`CodeMirror ${VERSION}: ${ok}/${files.length} files -> public/vendor/codemirror`);
