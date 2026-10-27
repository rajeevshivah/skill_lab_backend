// Code a student pastes with their project submission: up to MAX_FILES files,
// each with a name and a language (used for colouring on screen).
const LANGUAGES = ['javascript', 'jsx', 'typescript', 'html', 'css', 'python', 'java', 'c', 'cpp', 'csharp',
  'php', 'sql', 'json', 'kotlin', 'dart', 'go', 'bash', 'xml', 'yaml', 'markdown', 'text'];
const MAX_FILES = 10, MAX_FILE_CHARS = 60000, MAX_TOTAL_CHARS = 200000;

class CodeError extends Error {}

// [{ name, language, code }] from the request → cleaned list (empty boxes dropped); throws CodeError
function clean(list) {
  if (list == null) return [];
  if (!Array.isArray(list)) throw new CodeError('Code files must be a list.');
  const out = list
    .map(f => ({ name: String(f?.name || '').trim().slice(0, 80), language: String(f?.language || 'text'), code: String(f?.code || '').replace(/\r\n/g, '\n') }))
    .filter(f => f.code.trim());
  if (out.length > MAX_FILES) throw new CodeError(`At most ${MAX_FILES} code files.`);
  let total = 0;
  out.forEach((f, i) => {
    if (!LANGUAGES.includes(f.language)) f.language = 'text';
    if (!f.name) f.name = `file ${i + 1}`;
    if (f.code.length > MAX_FILE_CHARS) throw new CodeError(`"${f.name}" is too long (max ${MAX_FILE_CHARS / 1000}k characters). Push big projects to GitHub.`);
    total += f.code.length;
  });
  if (total > MAX_TOTAL_CHARS) throw new CodeError(`Too much code in total (max ${MAX_TOTAL_CHARS / 1000}k characters). Push big projects to GitHub.`);
  return out;
}
// what lists show: names and line counts, not the code
const meta = (files) => (files || []).map(f => ({ name: f.name, language: f.language, lines: f.code ? f.code.split('\n').length : f.lines || 0 }));

module.exports = { LANGUAGES, MAX_FILES, clean, meta, CodeError };
