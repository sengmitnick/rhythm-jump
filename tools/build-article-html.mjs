// Dependency-free Markdown -> single-file HTML for the contest article.
// Handles the subset used by docs/aiui-contest-lingzhu-leaderboard.md so the page can be
// published as-is (GitHub Pages, forum preview) without a build toolchain.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BT = String.fromCharCode(96);
const FENCE = BT + BT + BT;
const root = fileURLToPath(new URL('..', import.meta.url));
const source = path.join(root, 'docs', 'aiui-contest-lingzhu-leaderboard.md');
const target = path.join(root, 'docs', 'aiui-contest-lingzhu-leaderboard.html');

const escapeHtml = text => text
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

function slug(text) {
  return text.toLowerCase()
    .replace(new RegExp('[^a-z0-9\\u4e00-\\u9fa5]+', 'g'), '-')
    .replace(/^-+|-+$/g, '') || 'section';
}

function inline(text) {
  const codes = [];
  let out = escapeHtml(text).replace(
    new RegExp(BT + '([^' + BT + ']+)' + BT, 'g'),
    (_, code) => {
      codes.push('<code>' + code + '</code>');
      return '\u0000' + (codes.length - 1) + '\u0000';
    },
  );
  out = out.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img alt="$1" src="$2" loading="lazy">');
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\u0000(\d+)\u0000/g, (_, index) => codes[Number(index)]);
  return out;
}

function renderTable(lines) {
  const rows = lines.map(line => line.replace(/^\||\|\s*$/g, '').split('|').map(cell => cell.trim()));
  const head = rows[0];
  const body = rows.slice(2);
  const thead = '<thead><tr>' + head.map(cell => '<th>' + inline(cell) + '</th>').join('') + '</tr></thead>';
  const tbody = '<tbody>' + body.map(row =>
    '<tr>' + row.map(cell => '<td>' + inline(cell) + '</td>').join('') + '</tr>').join('') + '</tbody>';
  return '<div class="table-wrap"><table>' + thead + tbody + '</table></div>';
}

function convert(markdown) {
  const lines = markdown.split('\n');
  const html = [];
  const toc = [];
  let index = 0;
  const usedSlugs = new Map();

  const uniqueSlug = base => {
    const count = usedSlugs.get(base) || 0;
    usedSlugs.set(base, count + 1);
    return count ? base + '-' + count : base;
  };

  while (index < lines.length) {
    const line = lines[index];

    if (line.startsWith(FENCE)) {
      const lang = line.slice(FENCE.length).trim();
      const body = [];
      index += 1;
      while (index < lines.length && !lines[index].startsWith(FENCE)) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1;
      html.push('<pre class="code' + (lang ? ' lang-' + lang : '') + '"><code>' +
        escapeHtml(body.join('\n')) + '</code></pre>');
      continue;
    }

    if (!line.trim()) { index += 1; continue; }

    if (/^---+$/.test(line.trim())) { html.push('<hr>'); index += 1; continue; }

    if (/^###\s/.test(line)) {
      const text = line.replace(/^###\s+/, '');
      const id = uniqueSlug(slug(text));
      toc.push({ level: 3, id, text });
      html.push('<h3 id="' + id + '">' + inline(text) + '</h3>');
      index += 1; continue;
    }

    if (/^##\s/.test(line)) {
      const text = line.replace(/^##\s+/, '');
      const id = uniqueSlug(slug(text));
      toc.push({ level: 2, id, text });
      html.push('<h2 id="' + id + '">' + inline(text) + '</h2>');
      index += 1; continue;
    }

    if (/^#\s/.test(line)) {
      html.push('<h1>' + inline(line.replace(/^#\s+/, '')) + '</h1>');
      index += 1; continue;
    }

    if (/^>/.test(line)) {
      const quote = [];
      while (index < lines.length && /^>/.test(lines[index])) {
        quote.push(lines[index].replace(/^>\s?/, ''));
        index += 1;
      }
      html.push('<blockquote>' + quote.map(item =>
        item.trim() ? '<p>' + inline(item) + '</p>' : '').join('') + '</blockquote>');
      continue;
    }

    if (line.trim().startsWith('|') && /^\|[-:\s|]+\|\s*$/.test((lines[index + 1] || '').trim())) {
      const table = [];
      while (index < lines.length && lines[index].trim().startsWith('|')) {
        table.push(lines[index].trim());
        index += 1;
      }
      html.push(renderTable(table));
      continue;
    }

    if (/^\d+\.\s/.test(line) || /^-\s/.test(line)) {
      const ordered = /^\d+\.\s/.test(line);
      const items = [];
      while (index < lines.length && (ordered ? /^\d+\.\s/ : /^-\s/).test(lines[index])) {
        items.push(lines[index].replace(ordered ? /^\d+\.\s+/ : /^-\s+/, ''));
        index += 1;
      }
      const tag = ordered ? 'ol' : 'ul';
      html.push('<' + tag + '>' + items.map(item => '<li>' + inline(item) + '</li>').join('') + '</' + tag + '>');
      continue;
    }

    const paragraph = [];
    while (index < lines.length && lines[index].trim() &&
      !lines[index].startsWith(FENCE) && !/^#{1,3}\s/.test(lines[index]) &&
      !/^>/.test(lines[index]) && !/^---+$/.test(lines[index].trim()) &&
      !/^\d+\.\s/.test(lines[index]) && !/^-\s/.test(lines[index]) &&
      !lines[index].trim().startsWith('|')) {
      paragraph.push(lines[index]);
      index += 1;
    }
    if (paragraph.length) html.push('<p>' + inline(paragraph.join(' ')) + '</p>');
    else index += 1;
  }

  return { body: html.join('\n'), toc };
}

const template = await readFile(path.join(root, 'tools', 'article-template.html'), 'utf8');
const markdown = await readFile(source, 'utf8');
const { body, toc } = convert(markdown);

const tocHtml = toc
  .map(item => '<a class="lv' + item.level + '" href="#' + item.id + '">' + inline(item.text) + '</a>')
  .join('\n    ');

const page = template
  .replace('<!--TOC-->', tocHtml)
  .replace('<!--BODY-->', body);

await writeFile(target, page);
// Pages serves this folder, so the index is the same page at the site root.
await writeFile(path.join(root, 'docs', 'index.html'), page);
console.log('article html: ' + path.relative(root, target) + ' (' + Math.round(page.length / 1024) + ' KB, ' + toc.length + ' sections)');
console.log('article html: docs/index.html (GitHub Pages entry)');

