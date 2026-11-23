// main.ts is mend, the CLI SPEC.md specifies (MIT). It implements SPEC.md in full: the command line, the output and
// exit codes, safe paths, format detection, all four edit formats (unified diffs with possibly-wrong line numbers,
// SEARCH/REPLACE blocks, V4A patches, JSON tool calls), three-tier line matching, and the all-or-nothing write.
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------- files and lines (SPEC section 3) ----------

interface FileParts {
  lines: string[];
  br: string;
  fin: boolean;
}

function splitFile(text: string): FileParts {
  if (text === '') return { lines: [], br: '\n', fin: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const fin = text.endsWith(br);
  if (fin) parts.pop();
  return { lines: parts, br, fin };
}

function joinFile(lines: string[], br: string, fin: boolean): string {
  return lines.length === 0 ? '' : lines.join(br) + (fin ? br : '');
}

// ---------- matching lines (SPEC section 5) ----------

const trimEndST = (s: string): string => s.replace(/[ \t]+$/, '');
const trimST = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

function lineEq(a: string, b: string, tier: number): boolean {
  return tier === 0 ? a === b : tier === 1 ? trimEndST(a) === trimEndST(b) : trimST(a) === trimST(b);
}

function occurrences(file: string[], O: string[], from: number, tier: number): number[] {
  const res: number[] = [];
  for (let i = from; i + O.length <= file.length; i += 1) {
    let ok = true;
    for (let j = 0; j < O.length; j += 1) {
      if (!lineEq(file[i + j]!, O[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) res.push(i);
  }
  return res;
}

function findTier(file: string[], O: string[], from: number, strict: boolean): { tier: number; positions: number[] } | null {
  for (const t of strict ? [0] : [0, 1, 2]) {
    const p = occurrences(file, O, from, t);
    if (p.length > 0) return { tier: t, positions: p };
  }
  return null;
}

interface NEnt {
  text: string;
  ctx: boolean;
  oi: number; // index into O for a context line
}

/** The lines N becomes when it replaces O matched at `pos` in `file` (SPEC section 5). */
function buildN(file: string[], pos: number, O: string[], N: NEnt[], tier: number): string[] {
  let F = '';
  let P = '';
  if (tier === 2 && O.length > 0) {
    F = /^[ \t]*/.exec(file[pos]!)![0]!;
    P = /^[ \t]*/.exec(O[0]!)![0]!;
  }
  return N.map((e) => {
    if (e.ctx) return file[pos + e.oi]!;
    if (tier === 2) {
      const t = e.text;
      if (t !== '' && !/^[ \t]+$/.test(t) && t.startsWith(P)) return F + t.slice(P.length);
      return t;
    }
    return e.text;
  });
}

interface BodyEnt {
  kind: string; // ' ', '-', '+', '\\'
  text: string;
  empty: boolean; // came from a raw empty patch line
}

function onLines(body: BodyEnt[]): { O: string[]; N: NEnt[] } {
  const O: string[] = [];
  const N: NEnt[] = [];
  for (const e of body) {
    if (e.kind === ' ') {
      O.push(e.text);
      N.push({ text: e.text, ctx: true, oi: O.length - 1 });
    } else if (e.kind === '-') O.push(e.text);
    else if (e.kind === '+') N.push({ text: e.text, ctx: false, oi: -1 });
  }
  return { O, N };
}

/** Whether a `\` line follows the body's last context or `+` line. */
function noBreakAfter(body: BodyEnt[]): boolean {
  let last = -1;
  body.forEach((e, i) => {
    if (e.kind === ' ' || e.kind === '+') last = i;
  });
  return last >= 0 && body[last + 1]?.kind === '\\';
}

// ---------- unified diffs (SPEC section 6) ----------

interface Hunk {
  A: number;
  body: BodyEnt[];
}

interface Section {
  gitOld?: string;
  gitNew?: string;
  oldP?: string;
  newP?: string;
  renF?: string;
  renT?: string;
  newFile: boolean;
  delFile: boolean;
  sawPair: boolean;
  hunks: Hunk[];
}

function hdrPath(line: string): string {
  const t = line.slice(4);
  const tab = t.indexOf('\t');
  const p = (tab >= 0 ? t.slice(0, tab) : t).trim();
  return p.replace(/^[ab]\//, '');
}

function applyHunks(content: string, hunks: Hunk[], strict: boolean, failPath: string): string {
  const { lines, br, fin: fin0 } = splitFile(content);
  let fin = fin0;
  let d = 0;
  for (const h of hunks) {
    const { O, N } = onLines(h.body);
    const noBreak = noBreakAfter(h.body);
    if (O.length === 0) {
      const pos = Math.min(h.A + d, lines.length);
      const atEnd = pos === lines.length;
      lines.splice(pos, 0, ...N.map((e) => e.text));
      if (atEnd) fin = !noBreak;
      d += N.length - O.length;
      continue;
    }
    const f = findTier(lines, O, 0, strict);
    if (f === null) throw new Fail('no-match', failPath);
    const target = h.A - 1 + d;
    let best = f.positions[0]!;
    for (const p of f.positions) {
      if (Math.abs(p - target) < Math.abs(best - target)) best = p;
    }
    const runsEnd = best + O.length === lines.length;
    const built = buildN(lines, best, O, N, f.tier);
    lines.splice(best, O.length, ...built);
    if (runsEnd) fin = !noBreak;
    d += N.length - O.length;
  }
  return joinFile(lines, br, fin);
}

function sectionEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldP ?? sec.renF ?? sec.gitOld;
    const newP = sec.newP ?? sec.renT ?? sec.gitNew;
    const isCreate = sec.newFile || oldP === '/dev/null';
    const isDelete = sec.delFile || newP === '/dev/null';
    if (isCreate) {
      const p = newP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const out: string[] = [];
      let lastNoBreak = false;
      for (const h of sec.hunks) {
        h.body.forEach((e, i) => {
          if (e.kind === '+') {
            out.push(e.text);
            lastNoBreak = h.body[i + 1]?.kind === '\\';
          }
        });
      }
      tree.now.set(p, out.length === 0 ? '' : out.join('\n') + (lastNoBreak ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const p = oldP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const src = oldP!;
    const dst = newP ?? src;
    if (!safe(src)) throw new Fail('unsafe', src);
    if (!safe(dst)) throw new Fail('unsafe', dst);
    const before = tree.get(src);
    if (before === null) throw new Fail('missing', src);
    const isMove = dst !== src;
    if (isMove && tree.get(dst) !== null) throw new Fail('exists', dst);
    const text = applyHunks(before, sec.hunks, strict, src);
    if (isMove) {
      tree.now.set(dst, text);
      tree.now.set(src, null);
      tree.moves.push([src, dst]);
    } else {
      tree.now.set(src, text);
    }
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  const isPairStart = (k: number): boolean => lines[k]!.startsWith('--- ') && (lines[k + 1] ?? '').startsWith('+++ ');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = { gitOld: m[1]!, gitNew: m[2]!, newFile: false, delFile: false, sawPair: false, hunks: [] };
      sections.push(cur);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const body: BodyEnt[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const bl = lines[j]!;
        if (bl.startsWith('diff --git ')) break;
        if (isPairStart(j)) break;
        if (bl === '') body.push({ kind: ' ', text: '', empty: true });
        else if (bl[0] === ' ' || bl[0] === '-' || bl[0] === '+' || bl[0] === '\\') body.push({ kind: bl[0]!, text: bl.slice(1), empty: false });
        else break;
        j += 1;
      }
      while (body.length > 0 && body[body.length - 1]!.empty) body.pop();
      cur.hunks.push({ A: parseInt(m[1]!, 10), body });
      i = j;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0 && line.startsWith('--- ')) {
      if (!isPairStart(i)) throw new Exit2(`error: parse ${i + 2}`);
      if (!cur.sawPair) {
        cur.oldP = hdrPath(line);
        cur.newP = hdrPath(lines[i + 1]!);
        cur.sawPair = true;
        i += 2;
        continue;
      }
      // falls through: a fresh section starts below
    }
    if (isPairStart(i)) {
      cur = { oldP: hdrPath(line), newP: hdrPath(lines[i + 1]!), newFile: false, delFile: false, sawPair: true, hunks: [] };
      sections.push(cur);
      i += 2;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) cur.renF = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renT = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.delFile = true;
      i += 1;
      continue;
    }
    i += 1; // prose and anything else outside bodies and headers is ignored
  }
  return sections.map((s) => sectionEdit(s, strict));
}

// ---------- SEARCH/REPLACE blocks (SPEC section 7) ----------

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const { lines: fl, br, fin } = splitFile(before);
    const f = findTier(fl, oldLines, 0, strict);
    if (f === null) throw new Fail('no-match', path);
    if (f.positions.length > 1) throw new Fail('ambiguous', path);
    const pos = f.positions[0]!;
    const N: NEnt[] = newLines.map((t) => ({ text: t, ctx: false, oi: -1 }));
    const built = buildN(fl, pos, oldLines, N, f.tier);
    fl.splice(pos, oldLines.length, ...built);
    tree.now.set(path, joinFile(fl, br, fin));
  };
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = -1;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let eq = -1;
    for (let j = searchIdx + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j += 1) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let path: string | null = null;
    for (let k = searchIdx - 1; k > prevEnd; k -= 1) {
      const l = lines[k]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
    edits.push(srEdit(path, lines.slice(searchIdx + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

// ---------- V4A patches (SPEC section 8) ----------

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyEnt[];
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const { lines: fl, br, fin } = splitFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        let found = -1;
        for (const t of strict ? [0] : [0, 1, 2]) {
          for (let k = cursor; k < fl.length; k += 1) {
            if (lineEq(fl[k]!, ch.anchor, t)) {
              found = k;
              break;
            }
          }
          if (found >= 0) break;
        }
        if (found < 0) throw new Fail('no-match', path);
        cursor = found + 1;
      }
      const { O, N } = onLines(ch.body);
      if (O.length === 0) {
        const pos = ch.eof ? fl.length : Math.min(cursor, fl.length);
        const ins = N.map((e) => e.text);
        fl.splice(pos, 0, ...ins);
        cursor = pos + ins.length;
        continue;
      }
      let chosen: { tier: number; pos: number } | null = null;
      for (const t of strict ? [0] : [0, 1, 2]) {
        const ps = occurrences(fl, O, cursor, t).filter((p) => !ch.eof || p + O.length === fl.length);
        if (ps.length > 0) {
          chosen = { tier: t, pos: ps[0]! };
          break;
        }
      }
      if (chosen === null) throw new Fail('no-match', path);
      const built = buildN(fl, chosen.pos, O, N, chosen.tier);
      fl.splice(chosen.pos, O.length, ...built);
      cursor = chosen.pos + built.length;
    }
    const text = joinFile(fl, br, fin);
    if (moveTo !== null) {
      tree.now.set(moveTo, text);
      tree.now.set(path, null);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, text);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isHdr = (l: string): boolean => l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    if (!isHdr(line)) throw new Exit2(`error: parse ${i + 1}`);
    const kind = line.startsWith('*** Add File: ') ? 'add' : line.startsWith('*** Delete File: ') ? 'del' : 'upd';
    const prefix = kind === 'add' ? '*** Add File: ' : kind === 'del' ? '*** Delete File: ' : '*** Update File: ';
    const path = line.slice(prefix.length).trim();
    const updLine = i + 1;
    const content: { line: string; idx: number }[] = [];
    let j = i + 1;
    while (j < last && !isHdr(lines[j]!)) {
      content.push({ line: lines[j]!, idx: j });
      j += 1;
    }
    while (content.length > 0 && blank(content[content.length - 1]!.line)) content.pop();
    if (kind === 'add') {
      const fl: string[] = [];
      for (const c of content) {
        if (c.line.startsWith('+')) fl.push(c.line.slice(1));
        else if (c.line === '') fl.push('');
        else throw new Exit2(`error: parse ${c.idx + 1}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, fl.length === 0 ? '' : fl.join('\n') + '\n');
      });
    } else if (kind === 'del') {
      if (content.length > 0) throw new Exit2(`error: parse ${content[0]!.idx + 1}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else {
      let moveTo: string | null = null;
      let start = 0;
      if (content.length > 0 && content[0]!.line.startsWith('*** Move to: ')) {
        moveTo = content[0]!.line.slice('*** Move to: '.length).trim();
        start = 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      for (let k = start; k < content.length; k += 1) {
        const c = content[k]!;
        if (c.line.startsWith('@@')) {
          cur = { anchor: c.line.slice(2).trim() || null, eof: false, body: [] };
          chunks.push(cur);
          continue;
        }
        if (c.line.trimEnd() === '*** End of File') {
          if (cur === null) {
            cur = { anchor: null, eof: true, body: [] };
            chunks.push(cur);
          } else cur.eof = true;
          continue;
        }
        if (c.line === '' || c.line[0] === ' ' || c.line[0] === '-' || c.line[0] === '+') {
          if (cur === null) {
            cur = { anchor: null, eof: false, body: [] };
            chunks.push(cur);
          }
          if (c.line === '') cur.body.push({ kind: ' ', text: '', empty: true });
          else cur.body.push({ kind: c.line[0]!, text: c.line.slice(1), empty: false });
          continue;
        }
        throw new Exit2(`error: parse ${c.idx + 1}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updLine}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
    }
    i = j;
  }
  return edits;
}

// ---------- JSON edits (SPEC section 9) ----------

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------- invocation, output, atomicity (SPEC sections 1, 2, 10) ----------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changes = new Map<string, string>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changes.set(p, was === null ? 'A' : now === null ? 'D' : 'M');
  }
  const used = new Set<string>();
  const entries: { key: string; text: string }[] = [];
  for (const [o, n] of tree.moves) {
    if (changes.get(o) === 'D' && changes.get(n) === 'A' && !used.has(o) && !used.has(n)) {
      entries.push({ key: n, text: `R ${o} -> ${n}` });
      used.add(o);
      used.add(n);
    }
  }
  for (const [p, letter] of changes) {
    if (used.has(p)) continue;
    entries.push({ key: p, text: `${letter} ${p}` });
  }
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  const rows = entries.map((e) => e.text);
  if (!check) {
    for (const p of changes.keys()) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
