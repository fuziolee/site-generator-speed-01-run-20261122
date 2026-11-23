# site-generator-speed-01-run-20261122

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/fuziolee/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/fuziolee/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A faster drop-in for make.fun's own makefun-site 1.0.0: it builds a static site
and returns exactly makefun-site's answer for every input — the output tree
(each page's `index.html`, the index and tag pages, `build-report.txt` and
each static file), byte for byte — at about 4x makefun-site's CPU time on the
practice set.

## How it is fast

The reference renders Markdown one character at a time (an HTML-escape regex
per character) and walks template trees with a scope-chain lookup per
variable. This rewrite instead:

- renders Markdown in a single pass with no token objects: a regex jumps to
  the next special character, plain runs are copied without escaping, and
  inline constructs (code spans, strong, emphasis, links) are resolved with
  index scans over the same segment — no slices, no recursion into copies;
- parses each template once and compiles it to a JavaScript function
  (direct property access, real `if`/`for`, string `+=`), with an interpreted
  fallback if code generation is unavailable in the runtime;
- memoizes `slugify` per `run()` (ASCII fast path: NFKD is the identity on
  ASCII) and caches link-path resolution per run — nothing is cached from one
  case to the next;
- splits each source's lines once and reuses them for front matter, Markdown
  and the word count, and counts words with a tight scan instead of
  materialising a word array.

Nothing is cached from one case to the next, and the build is pure: no clock,
no randomness, no locale, no environment.

## Correctness

On the kit's practice set the entry is identical to makefun-site 1.0.0 on all
3 cases, and it matches the reference on 375 additional fuzz cases (125
generated sets drawn with the kit's own generator, covering drafts, non-ASCII
titles, slug collisions, refused front matter, raw HTML, setext underlines,
underscores, links to drafts and missing files), 0 mismatches. The
interpreted fallback path is also identical on the practice set.

## Layout

- `solve.js` — the entry: `run(input)` returns makefun-site's answer.
- `main.ts` — the driver, identical to the house baseline's driver.
