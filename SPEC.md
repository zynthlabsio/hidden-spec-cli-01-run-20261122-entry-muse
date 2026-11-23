# mend: the specification (version 1)

mend applies an edit that an AI model wrote to a tree of text files. Models write edits in four formats: a unified
diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as JSON.
Each format is read as this document says, and every file is changed or nothing is.

Every check runs `node main.ts [arguments]` once, in a fresh directory that holds the check's files, and compares
three things with what this document says: the exit code, everything written to standard output, and every file in
the directory afterwards (each path and its bytes). Standard error is never compared. The words MUST and the like
are not used: every sentence below is a requirement.

## 1. Invocation

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- The working directory is the root of the tree. Every path in a patch is relative to it.
- PATCH is the path of the patch file, relative to the working directory. When PATCH is absent or is `-`, the patch is
  read from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`, `v4a` or `json`; `auto`, the default,
  detects it (section 4).
- `--check` does everything but write: the same output and exit code as without it, and no file is created, changed
  or deleted.
- `--strict` matches lines exactly (tier 0 only, section 5).
- Options and PATCH may come in any order. `--` ends the options: every argument after it is a positional argument.
- A usage error is any of: an argument that starts with `-` and is not `-` and not one of the options above (before
  `--`), an option given twice, a `--format` value other than the five names, or more than one positional argument.

## 2. Output and exit codes

Standard output holds lines, each ended by a line feed (`\n`), and nothing else.

Exit 2, nothing written, exactly one line:

- `error: usage` on a usage error (section 1);
- `error: no-patch` when the PATCH file cannot be read;
- `error: format` when `--format=auto` detects no format (section 4);
- `error: parse <N>` when the patch cannot be read in its format, `<N>` the 1-based number of the patch line named in
  that format's section. A patch in which the reader finds no edit at all is `error: parse 1`.

They are tried in that order: a usage error wins over everything, and a parse error is reported before any file is
looked at.

Exit 1, nothing written: one line `error: <code> <path>` for each edit that failed, in the patch's order, then one line
`failed: <k> of <n> edits`, where k edits of the patch's n failed. The codes:

- `no-match`: the lines or text the edit replaces are not in the file;
- `ambiguous`: they are there more than once and the format gives no way to choose;
- `missing`: the edit changes, deletes or moves a file that does not exist;
- `exists`: the edit creates a file, or moves a file to a path, that exists;
- `unsafe`: a path of the edit is not a safe path (section 3); the line names the path as the patch wrote it, after
  any prefix section 6 removes.

The path on an error line is the path the failure concerns: the file that is missing, the path that exists, the file
in which the lines were not found.

Exit 0: the tree is written. One line for each path whose state changed, in byte order of the paths (UTF-8), then one
line `ok: <n> files`, or `ok: 1 file` when n is 1:

- `A <path>` a file that did not exist and now does;
- `D <path>` a file that existed and now does not;
- `M <path>` a file that existed and still does, with other bytes;
- `R <old> -> <new>` a file moved by a move edit (sections 6 and 8) that succeeded, when `<old>` existed before the
  patch and does not after it, and `<new>` did not exist before it and does after it. It replaces that pair's `D` and
  `A` lines and sorts by `<new>`.

A file whose bytes after the patch are its bytes before it is not listed. A patch that changes nothing prints only
`ok: 0 files`.

## 3. Files, lines and paths

- Files and patches are UTF-8 text.
- A path is safe when it is not empty, does not start with `/`, holds no `\`, and none of its `/`-separated segments
  is empty, `.` or `..`. Directories are created as files need them.
- A file's line break is CRLF (`\r\n`) when its first line feed follows a carriage return, and LF otherwise. Its lines
  are its text split at that break. It ends with a line break when its text ends with that break; that last, empty
  piece is not a line. An empty file has no lines and does not end with a line break, and a file of no lines is
  written empty.
- A changed file is written back with its own line break between its lines, and with a final one exactly when it ended
  with one before the edit, unless section 6 says otherwise for a unified hunk.
- A file an edit creates is written with LF breaks, and ends with a line break unless the edit's format says otherwise.
  A JSON `create` writes its `file_text` byte for byte.
- A patch's lines are its text split at `\n`, each with one trailing `\r` removed, and without the empty piece after a
  final `\n`. Patch line numbers count these lines from 1.

## 4. Detecting the format

With `--format=auto` the format is the first of these that holds, where a blank line is one that is empty or only
whitespace:

1. the first non-blank line, its surrounding whitespace removed, is `*** Begin Patch`: `v4a`;
2. the first non-whitespace character of the first non-blank line is `[` or `{`: `json`;
3. some line, its trailing whitespace removed, is `<<<<<<< SEARCH`: `search-replace`;
4. some line starts with `diff --git `, or some line starts with `--- ` and the line after it starts with `+++ `:
   `unified`.

Otherwise it is `error: format`. A format named with `--format` is read as that format whatever the text holds.

## 5. Matching lines

Unified hunks, SEARCH/REPLACE blocks and V4A chunks name old lines O (one or more) that are replaced by new lines N.
O is found in the file's current lines at the first of three tiers at which it occurs at least once:

- tier 0: every line equal;
- tier 1: every line equal once trailing spaces and tabs are removed from both;
- tier 2: every line equal once leading and trailing spaces and tabs are removed from both.

With `--strict` only tier 0 is tried. When O occurs at no tier the edit fails with `no-match`. An occurrence at a tier
is a position i where O's lines match the file's lines i, i+1, and so on; occurrences may overlap. Each format says
which occurrence it takes when there are several (sections 6 to 8).

N replaces the k matched lines. A context line (a line of both O and N in a unified hunk or a V4A chunk) is written as
the file's own matched line, never the patch's. At tier 2 every other line of N is re-indented: let F be the leading
spaces and tabs of the file's first matched line and P those of O's first line; a line of N that is not empty and not
only whitespace, and starts with P, has that P replaced by F; any other line is written as it is. At tiers 0 and 1 the
lines of N are written as they are.

## 6. Unified diffs

Sections. A section starts at a `diff --git a/<X> b/<Y>` line, or at a `--- ` line followed by a `+++ ` line that is
not already part of a section's header. Within a section, before its first hunk:

- `--- <path>` and `+++ <path>` name the old and new path. The path is the text after the four characters, up to the
  first tab, with surrounding spaces removed. `/dev/null` means no file. A leading `a/` or `b/` is removed from either.
- `rename from <path>` and `rename to <path>` name the old and new path when no `---`/`+++` pair does.
- `new file mode` makes the section a creation, `deleted file mode` a deletion.
- the `diff --git` paths are used when nothing else names one.
- `index`, `old mode`, `new mode`, `similarity index`, `dissimilarity index` and `Index:` lines, and any other line, are
  ignored.

A `--- ` line not followed by a `+++ ` line, inside a section's header, is `error: parse <the line after it>`. A
`diff --git` line not of the form above is `error: parse <its line>`.

Hunks. A hunk starts at a line `@@ -A[,B] +C[,D] @@`, optionally followed by text; any other line starting with `@@` is
`error: parse <its line>`, and so is a hunk before any section. B and D are not used. The hunk's body is the lines
after the header that start with ` ` (context), `-` (old), `+` (new) or `\`, or are empty (an empty line is a context
line whose text is empty). The body ends at the first other line, at a `diff --git ` line, at a `--- ` line followed by
a `+++ ` line, or at the end of the patch; empty lines at the end of a body are not part of it. Outside bodies, lines
that are not part of a section header are ignored (prose, code fences).

The section's edit. The section is one edit:

- a creation (old path `/dev/null`, or `new file mode`): the new path does not exist (else `exists`); the file is the
  `+` lines of all its hunks, in order.
- a deletion (new path `/dev/null`, or `deleted file mode`): the old path exists (else `missing`); it is deleted, and its
  hunks are not read.
- a move (old and new path differ): the old path exists (else `missing`), the new path does not (else `exists`); the
  hunks are applied to the old file's lines and the result is written at the new path, the old path deleted.
- otherwise a change of the one path, which exists (else `missing`).

Applying hunks. The hunks of a section apply in order, each to the result of the ones before it. O is the hunk's
context and `-` lines, N its context and `+` lines, each in body order. Let d be the sum over this section's hunks
applied so far of (N's length minus O's length).

- When O is not empty, of the occurrences at the tier where O is found, the hunk takes the one whose 0-based position
  is nearest to A - 1 + d; of two equally near, the earlier.
- When O is empty, N is inserted after the first A + d lines (all of them when the file has fewer).
- A `\` line (as in `\ No newline at end of file`) refers to the body line before it. When a hunk's matched lines run
  to the end of the file (or, for an empty O, the insertion is at the end), the result ends with a line break unless
  a `\` line follows the hunk's last context or `+` line; when they do not, the file's final break stays as it was. A
  created file ends with a line break unless a `\` line follows its last `+` line.

Any failure of a hunk fails the section with that hunk's code, and the section changes nothing.

## 7. SEARCH/REPLACE blocks

A block is:

    <path>
    <<<<<<< SEARCH
    <old lines>
    =======
    <new lines>
    >>>>>>> REPLACE

The three marker lines are matched with their trailing whitespace removed. The path is the nearest line before the
`<<<<<<< SEARCH` line, and after the previous block's `>>>>>>> REPLACE` line (or the start of the patch), that is not
blank and, its surrounding whitespace removed, does not start with three backticks; the path is that line with
its surrounding whitespace removed. When there is no such line the
block takes the previous block's path; the first block with none is `error: parse <its SEARCH line>`. A SEARCH line
with no `=======` and then `>>>>>>> REPLACE` after it is `error: parse <the SEARCH line>`. Lines outside blocks are
otherwise ignored.

Each block is one edit, applied in order:

- old lines empty: the file is created with the new lines (else `exists`);
- otherwise the file exists (else `missing`), and the old lines occur at their tier exactly once, or the block fails
  with `ambiguous`; the new lines replace them.

## 8. V4A patches

    *** Begin Patch
    *** Add File: <path>
    +<line>
    *** Delete File: <path>
    *** Update File: <path>
    *** Move to: <new path>
    @@ <anchor>
     <context>
    -<old>
    +<new>
    *** End of File
    *** End Patch

The first non-blank line is `*** Begin Patch`, else `error: parse <that line>` (`error: parse 1` when there is none), and
the last non-blank line is `*** End Patch`, else `error: parse <the number of patch lines plus 1>`; both are compared
with their surrounding whitespace removed. Blank lines at the end of a section (before the next section or `*** End Patch`) are not part of it. Between them,
sections start at `*** Add File: `,
`*** Delete File: ` and `*** Update File: ` lines (the path is the rest of the line, its surrounding spaces removed).
Blank lines between sections are ignored. Any other line is `error: parse <its line>`:

- an Add File section's lines start with `+` (the rest is a line of the file) or are empty (an empty line of the file);
- a Delete File section has no lines;
- an Update File section may have `*** Move to: <path>` as its first line, then chunks. A chunk starts at an `@@` line
  (the text after `@@`, its surrounding spaces removed, is the chunk's anchor; an empty text is no anchor) or, for the
  first chunk, at a body line. Body lines start with ` `, `-` or `+`, or are empty (an empty context line). A `*** End of File` line ends a chunk and anchors it to the end of the
  file. An Update File section with no chunk and no `*** Move to:` is `error: parse <its Update File line>`.

Each section is one edit, applied in order:

- Add File: the path does not exist (else `exists`); the file is the section's lines, ended by a line break.
- Delete File: the path exists (else `missing`); it is deleted.
- Update File: the path exists (else `missing`); with Move to, the new path does not (else `exists`). The chunks apply
  in order, with a cursor that starts at line 0. A chunk with an anchor first finds the first line at or after the
  cursor equal to the anchor at the first tier where one is (section 5, both sides a single line), else `no-match`;
  the cursor moves past it. O is the chunk's context and `-` lines, N its context and `+` lines. The chunk takes the
  first occurrence of O at or after the cursor, at the first tier with one; an end-of-file chunk takes only an
  occurrence that ends at the file's last line. When O is empty, N is inserted at the cursor, or at the end of the file
  for an end-of-file chunk. The cursor then moves to just after the lines written. With Move to, the result is written
  at the new path and the old path deleted.

## 9. JSON edits

The patch is either one JSON array of edit objects, or JSON Lines: one edit object a line, blank lines ignored. In
array form any fault is `error: parse <the line where the array starts>`; in JSON Lines form a line that does not hold
one valid edit object is `error: parse <that line>`. An edit object has a string `path` and a `command`; keys other than
those below are ignored:

- `{"command": "create", "path", "file_text"}`: the file does not exist (else `exists`); it is written with
  `file_text`'s bytes.
- `{"command": "str_replace", "path", "old_str", "new_str"}`: `old_str` a non-empty string, `new_str` a string (absent
  is empty). The file exists (else `missing`). In a CRLF file, the file's text and both strings are read with every
  `\r\n` as `\n`, and the result is written back with `\r\n`. `old_str` occurs in the text exactly once (positions may
  overlap), else `no-match` or `ambiguous`; it is replaced by `new_str`. No tier applies: the match is exact.
- `{"command": "insert", "path", "insert_line", "new_str"}`: `insert_line` an integer, `new_str` a string. The file
  exists (else `missing`), and `insert_line` is from 0 to its number of lines (else `no-match`). `new_str`'s lines
  (split at `\n`, each with one trailing `\r` removed, without the empty piece after a final `\n`; an empty
  `new_str` has none) are inserted after
  line `insert_line` (0 is the top). The file's final break stays as it was.

A wrong command or a missing or mistyped key is a parse fault.

## 10. Order and atomicity

Edits apply in the patch's order to the tree as earlier edits left it: a file created, changed, moved or deleted by an
earlier edit is seen so by a later one. Every path an edit names is checked for safety before anything else about it.
A failed edit changes nothing, and the edits after it still run, so every failure is reported. When any edit failed,
no file is written (exit 1). When none failed, every change is written (exit 0), or with `--check` none is.
