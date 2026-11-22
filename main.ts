// main.ts is mend, the CLI SPEC.md specifies. It does all ten sections of SPEC.md: the command line, the
// output and exit codes, safe paths, format detection, three-tier line matching (section 5), unified diffs
// (section 6), SEARCH/REPLACE blocks (section 7), V4A patches (section 8), JSON edits (section 9) and the
// all-or-nothing write (section 10). Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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

/** A file's text as lines, its line break, and whether it ends with one (SPEC.md section 3). */
interface FileText {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileText {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

/** The leading spaces and tabs of a line. */
function leadWS(s: string): string {
  let i = 0;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i += 1;
  return s.slice(0, i);
}

/** A line with trailing spaces and tabs removed. */
function trailTrim(s: string): string {
  let i = s.length;
  while (i > 0 && (s[i - 1] === ' ' || s[i - 1] === '\t')) i -= 1;
  return s.slice(0, i);
}

/** A line with leading and trailing spaces and tabs removed. */
function bothTrim(s: string): string {
  return trailTrim(s.slice(leadWS(s).length));
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves that succeeded, as [old, new] pairs, for the `R` output lines. */
  readonly moves: Array<[string, string]> = [];
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

/** Sort helper: byte order of the UTF-8 encoding. */
function byteCmp(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

// ---------- Section 5: matching lines ----------

/** The key of a line at a tier: 0 exact, 1 trailing spaces/tabs removed, 2 both sides removed. */
function tierKey(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return trailTrim(s);
  return bothTrim(s);
}

/** Every 0-based position where O occurs in `lines` at one tier; occurrences may overlap. */
function occurrences(O: string[], lines: string[], tier: number): number[] {
  const out: number[] = [];
  if (O.length === 0 || O.length > lines.length) return out;
  const keys = O.map((l) => tierKey(l, tier));
  for (let i = 0; i + O.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < O.length; j += 1) {
      if (tierKey(lines[i + j]!, tier) !== keys[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

interface Match {
  tier: number;
  positions: number[];
}

/** The first tier (0, then 1, then 2; only 0 with --strict) at which O occurs, or null. */
function findMatch(O: string[], lines: string[], strict: boolean): Match | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const positions = occurrences(O, lines, t);
    if (positions.length > 0) return { tier: t, positions };
  }
  return null;
}

/** One line of N: a context line (written as the file's own matched line) or a new line. */
interface NEntry {
  text: string;
  /** Index of the matching line of O, or null for a line only in N. */
  oIndex: number | null;
}

/**
 * Render N after a match at `pos`: context lines come from the file, other lines are re-indented at
 * tier 2 (F replaces P at the front) and written as they are at tiers 0 and 1.
 */
function renderN(N: NEntry[], fileLines: string[], pos: number, O: string[], tier: number): string[] {
  if (tier !== 2) return N.map((e) => (e.oIndex !== null ? fileLines[pos + e.oIndex]! : e.text));
  const f = leadWS(fileLines[pos]!);
  const p = leadWS(O[0]!);
  return N.map((e) => {
    if (e.oIndex !== null) return fileLines[pos + e.oIndex]!;
    const t = e.text;
    if (t === '' || t.trim() === '') return t;
    if (t.startsWith(p)) return f + t.slice(p.length);
    return t;
  });
}

/**
 * The first line at or after `from` equal to a single-line anchor, at the first tier where one is.
 * Returns its position, or -1.
 */
function findAnchor(anchor: string, lines: string[], from: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const key = tierKey(anchor, t);
    for (let i = from; i < lines.length; i += 1) {
      if (tierKey(lines[i]!, t) === key) return i;
    }
  }
  return -1;
}

/**
 * The first occurrence of O at or after `from`, at the first tier with one. For an end-of-file chunk
 * only an occurrence ending at the file's last line counts. Returns the position and tier, or null.
 */
function findMatchFrom(O: string[], lines: string[], from: number, strict: boolean, eof: boolean): { pos: number; tier: number } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (const p of occurrences(O, lines, t)) {
      if (p < from) continue;
      if (eof && p + O.length !== lines.length) continue;
      return { pos: p, tier: t };
    }
  }
  return null;
}

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
      const { lines, br, final } = splitFile(before);
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile(lines, br, final));
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

// ---------- Section 6: unified diffs ----------

/** One body line of a hunk: ` ` or empty is context, `-` old, `+` new, `\` a no-newline marker. */
interface Hunk {
  /** The -A number of the header: where the hunk says the old lines start (1-based). */
  a: number;
  body: string[];
}

interface USection {
  oldPath: string | null;
  newPath: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  diffA: string | null;
  diffB: string | null;
  isCreate: boolean;
  isDelete: boolean;
  sawPair: boolean;
  hunks: Hunk[];
}

function newUSection(): USection {
  return { oldPath: null, newPath: null, renameFrom: null, renameTo: null, diffA: null, diffB: null, isCreate: false, isDelete: false, sawPair: false, hunks: [] };
}

/** The path after `--- ` or `+++ `: up to the first tab, surrounding spaces removed, a/ or b/ removed. */
function dashPath(line: string): string {
  const raw = line.slice(4).split('\t')[0]!.trim();
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

const HUNK_HEAD = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** A `diff --git a/<X> b/<Y>` line, or null when it is not of that form. */
function diffGitPaths(line: string): [string, string] | null {
  const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(line);
  return m === null ? null : [m[1]!, m[2]!];
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  // mode: 'outside' (between sections), 'header' (a section's header), 'hunks' (after its first hunk).
  let mode: 'outside' | 'header' | 'hunks' = 'outside';
  let i = 0;
  const startSection = (diff: [string, string] | null): void => {
    cur = newUSection();
    if (diff !== null) {
      cur.diffA = diff[0];
      cur.diffB = diff[1];
    }
    sections.push(cur);
    mode = 'header';
  };
  /** Read one hunk at lines[i] (a valid header) and its body; returns the index after the body. */
  const readHunk = (at: number): number => {
    const m = HUNK_HEAD.exec(lines[at]!)!;
    const body: string[] = [];
    let j = at + 1;
    while (j < lines.length) {
      const l = lines[j]!;
      if (l.startsWith('diff --git ')) break;
      if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
      if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
        body.push(l);
        j += 1;
      } else break;
    }
    while (body.length > 0 && body[body.length - 1] === '') body.pop();
    cur!.hunks.push({ a: Number(m[1]), body });
    return j;
  };
  while (i < lines.length) {
    const line = lines[i]!;
    if (mode === 'outside') {
      if (line.startsWith('diff --git ')) {
        const d = diffGitPaths(line);
        if (d === null) throw new Exit2(`error: parse ${i + 1}`);
        startSection(d);
        i += 1;
        continue;
      }
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        startSection(null);
        continue; // the header loop takes the pair
      }
      if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i += 1;
      continue;
    }
    if (mode === 'header') {
      if (line.startsWith('diff --git ')) {
        const d = diffGitPaths(line);
        if (d === null) throw new Exit2(`error: parse ${i + 1}`);
        startSection(d);
        i += 1;
        continue;
      }
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        if (!cur!.sawPair) {
          cur!.oldPath = dashPath(line);
          cur!.newPath = dashPath(lines[i + 1]!);
          cur!.sawPair = true;
          i += 2;
          continue;
        }
        startSection(null);
        continue; // the header loop takes the pair as a new section
      }
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('+++ ')) {
        cur!.newPath = dashPath(line);
        i += 1;
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur!.renameFrom = line.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur!.renameTo = line.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (line === 'new file mode' || line.startsWith('new file mode ')) {
        cur!.isCreate = true;
        i += 1;
        continue;
      }
      if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) {
        cur!.isDelete = true;
        i += 1;
        continue;
      }
      if (line.startsWith('@@')) {
        if (!HUNK_HEAD.test(line)) throw new Exit2(`error: parse ${i + 1}`);
        mode = 'hunks';
        i = readHunk(i);
        continue;
      }
      i += 1; // index, old/new mode, similarity, Index: and anything else: ignored
      continue;
    }
    // mode === 'hunks': between hunks of the section.
    if (line.startsWith('diff --git ')) {
      const d = diffGitPaths(line);
      if (d === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection(d);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      startSection(null);
      continue;
    }
    if (line.startsWith('@@')) {
      if (!HUNK_HEAD.test(line)) throw new Exit2(`error: parse ${i + 1}`);
      i = readHunk(i);
      continue;
    }
    i += 1; // prose or code fences outside bodies: ignored
  }
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

/** O is the hunk's context and `-` lines, N its context and `+` lines, each in body order. */
function hunkON(h: Hunk): { O: string[]; N: NEntry[] } {
  const O: string[] = [];
  const N: NEntry[] = [];
  for (const l of h.body) {
    if (l === '' || l[0] === ' ') {
      const t = l === '' ? '' : l.slice(1);
      O.push(t);
      N.push({ text: t, oIndex: O.length - 1 });
    } else if (l[0] === '-') {
      O.push(l.slice(1));
    } else if (l[0] === '+') {
      N.push({ text: l.slice(1), oIndex: null });
    }
    // a `\` line refers to the body line before it and carries no line of its own.
  }
  return { O, N };
}

/** True when a `\` line follows the hunk's last context or `+` line: no line break at the end. */
function hunkNoEol(h: Hunk): boolean {
  let last = -1;
  for (let k = 0; k < h.body.length; k += 1) {
    const l = h.body[k]!;
    if (l === '' || l[0] === ' ' || l[0] === '+') last = k;
  }
  if (last < 0) return false;
  const next = h.body[last + 1];
  return next !== undefined && next[0] === '\\';
}

/** Apply one section's hunks in order to a file's lines; throws Fail('no-match', path) on failure. */
function applyHunks(lines: string[], final: boolean, hunks: Hunk[], strict: boolean, path: string): { lines: string[]; final: boolean } {
  let cur = lines;
  let curFinal = final;
  let d = 0;
  for (const h of hunks) {
    const { O, N } = hunkON(h);
    if (O.length === 0) {
      const at = Math.max(0, Math.min(h.a + d, cur.length));
      const atEnd = at === cur.length;
      const ins = N.map((e) => e.text);
      cur = [...cur.slice(0, at), ...ins, ...cur.slice(at)];
      if (atEnd) curFinal = !hunkNoEol(h);
      d += N.length;
      continue;
    }
    const m = findMatch(O, cur, strict);
    if (m === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let pos = m.positions[0]!;
    let best = Math.abs(pos - target);
    for (const p of m.positions) {
      const dd = Math.abs(p - target);
      if (dd < best) {
        best = dd;
        pos = p;
      }
    }
    const rep = renderN(N, cur, pos, O, m.tier);
    const touchesEnd = pos + O.length === cur.length;
    cur = [...cur.slice(0, pos), ...rep, ...cur.slice(pos + O.length)];
    if (touchesEnd) curFinal = !hunkNoEol(h);
    d += N.length - O.length;
  }
  return { lines: cur, final: curFinal };
}

function unifiedSectionEdit(sec: USection, strict: boolean): Edit {
  const oldP = sec.oldPath ?? sec.renameFrom ?? sec.diffA;
  const newP = sec.newPath ?? sec.renameTo ?? sec.diffB;
  const oldNull = oldP === undefined || oldP === '/dev/null';
  const newNull = newP === undefined || newP === '/dev/null';
  const isCreate = oldNull || sec.isCreate;
  const isDelete = !isCreate && (newNull || sec.isDelete);
  const isMove = !isCreate && !isDelete && oldP !== newP;
  if (isCreate) {
    const p = newP!;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const made: string[] = [];
      let noEol = false;
      for (const h of sec.hunks) {
        for (let k = 0; k < h.body.length; k += 1) {
          const l = h.body[k]!;
          if (l[0] === '+') {
            made.push(l.slice(1));
            const next = h.body[k + 1];
            noEol = next !== undefined && next[0] === '\\';
          }
        }
      }
      // noEol must describe the last `+` line: later `+` lines overwrite it, earlier ones do not.
      tree.now.set(p, made.length === 0 ? '' : made.join('\n') + (noEol ? '' : '\n'));
    };
  }
  if (isDelete) {
    const p = oldP!;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
    };
  }
  if (isMove) {
    const from = oldP!;
    const to = newP!;
    return (tree) => {
      if (!safe(from)) throw new Fail('unsafe', from);
      if (!safe(to)) throw new Fail('unsafe', to);
      const text = tree.get(from);
      if (text === null) throw new Fail('missing', from);
      if (tree.get(to) !== null) throw new Fail('exists', to);
      const { lines, br, final } = splitFile(text);
      const out = applyHunks(lines, final, sec.hunks, strict, from);
      tree.now.set(to, joinFile(out.lines, br, out.final));
      tree.now.set(from, null);
      tree.moves.push([from, to]);
    };
  }
  const p = oldP!;
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const text = tree.get(p);
    if (text === null) throw new Fail('missing', p);
    const { lines, br, final } = splitFile(text);
    const out = applyHunks(lines, final, sec.hunks, strict, p);
    tree.now.set(p, joinFile(out.lines, br, out.final));
  };
}

// ---------- Section 7: SEARCH/REPLACE blocks ----------

interface SRBlock {
  path: string;
  old: string[];
  nw: string[];
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: SRBlock[] = [];
  let i = 0;
  let prevReplace = -1;
  let prevPath: string | null = null;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevReplace; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let eq = -1;
    let k = searchIdx + 1;
    while (k < lines.length) {
      const t = lines[k]!.trimEnd();
      if (t === '=======') {
        eq = k;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
      k += 1;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    k = eq + 1;
    while (k < lines.length) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
      k += 1;
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    blocks.push({ path, old: lines.slice(searchIdx + 1, eq), nw: lines.slice(eq + 1, rep) });
    prevPath = path;
    prevReplace = rep;
    i = rep + 1;
  }
  return blocks.map((b) => srBlockEdit(b, strict));
}

function srBlockEdit(b: SRBlock, strict: boolean): Edit {
  return (tree) => {
    const p = b.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (b.old.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, b.nw.length === 0 ? '' : b.nw.join('\n') + '\n');
      return;
    }
    const text = tree.get(p);
    if (text === null) throw new Fail('missing', p);
    const { lines, br, final } = splitFile(text);
    const m = findMatch(b.old, lines, strict);
    if (m === null) throw new Fail('no-match', p);
    if (m.positions.length > 1) throw new Fail('ambiguous', p);
    const pos = m.positions[0]!;
    const rep = renderN(
      b.nw.map((t) => ({ text: t, oIndex: null })),
      lines,
      pos,
      b.old,
      m.tier,
    );
    const out = [...lines.slice(0, pos), ...rep, ...lines.slice(pos + b.old.length)];
    tree.now.set(p, joinFile(out, br, final));
  };
}

// ---------- Section 8: V4A patches ----------

interface VChunk {
  anchor: string | null;
  body: string[];
  eof: boolean;
}

function isVSectionStart(l: string): boolean {
  return l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const hdr = lines[i]!;
    if (blank(hdr)) {
      i += 1;
      continue;
    }
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (hdr.startsWith('*** Add File: ')) {
      kind = 'add';
      path = hdr.slice('*** Add File: '.length).trim();
    } else if (hdr.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = hdr.slice('*** Delete File: '.length).trim();
    } else if (hdr.startsWith('*** Update File: ')) {
      kind = 'update';
      path = hdr.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    // The section's lines run to the next section or `*** End Patch`; trailing blanks are not part of it.
    let j = i + 1;
    while (j < last && !isVSectionStart(lines[j]!)) j += 1;
    let end = j;
    while (end > i + 1 && blank(lines[end - 1]!)) end -= 1;
    const content = lines.slice(i + 1, end);
    // Patch line number (1-based) of content[c].
    const lineNo = (c: number): number => i + 2 + c;
    if (kind === 'add') {
      const made: string[] = [];
      for (let c = 0; c < content.length; c += 1) {
        const l = content[c]!;
        if (l === '') made.push('');
        else if (l[0] === '+') made.push(l.slice(1));
        else throw new Exit2(`error: parse ${lineNo(c)}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, made.length === 0 ? '' : made.join('\n') + '\n');
      });
    } else if (kind === 'delete') {
      if (content.length > 0) throw new Exit2(`error: parse ${lineNo(0)}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else {
      let k = 0;
      let moveTo: string | null = null;
      if (content[0] !== undefined && content[0].startsWith('*** Move to: ')) {
        moveTo = content[0].slice('*** Move to: '.length).trim();
        k = 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      while (k < content.length) {
        const l = content[k]!;
        if (l.startsWith('@@')) {
          cur = { anchor: l.slice(2).trim() === '' ? null : l.slice(2).trim(), body: [], eof: false };
          chunks.push(cur);
          k += 1;
        } else if (l === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${lineNo(k)}`);
          cur.eof = true;
          cur = null;
          k += 1;
        } else if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (cur === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${lineNo(k)}`);
            cur = { anchor: null, body: [], eof: false };
            chunks.push(cur);
          }
          cur.body.push(l);
          k += 1;
        } else {
          throw new Exit2(`error: parse ${lineNo(k)}`);
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${i + 1}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
    }
    i = j;
  }
  return edits;
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    if (moveTo !== null) {
      if (!safe(moveTo)) throw new Fail('unsafe', moveTo);
      if (tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    }
    const { lines, br, final } = splitFile(text);
    let cur = lines;
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        const at = findAnchor(chunk.anchor, cur, cursor, strict);
        if (at < 0) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      const { O, N } = hunkON({ a: 0, body: chunk.body });
      if (O.length === 0) {
        const at = chunk.eof ? cur.length : cursor;
        const ins = N.map((e) => e.text);
        cur = [...cur.slice(0, at), ...ins, ...cur.slice(at)];
        cursor = at + ins.length;
      } else {
        const m = findMatchFrom(O, cur, cursor, strict, chunk.eof);
        if (m === null) throw new Fail('no-match', path);
        const rep = renderN(N, cur, m.pos, O, m.tier);
        cur = [...cur.slice(0, m.pos), ...rep, ...cur.slice(m.pos + O.length)];
        cursor = m.pos + rep.length;
      }
    }
    const out = joinFile(cur, br, final);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

// ---------- Section 10: order and atomicity ----------

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
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Output rows, in byte order of the paths (a move sorts by its new path, and replaces its D and A lines).
  const rows: { key: string; text: string }[] = [];
  const moved = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.now.get(oldP) === null && tree.original(newP) === null && tree.now.get(newP) !== null) {
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      moved.add(oldP);
      moved.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort(byteCmp)) {
    if (moved.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteCmp(a.key, b.key));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const out = rows.map((r) => r.text);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
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
