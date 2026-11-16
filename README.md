# SwiftMark

A fast, dependency-free Markdown parser written from scratch, byte-compatible with marked 18.1.3 (CommonMark 0.31.2 + GFM 0.29).

[![make.fun](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/Indodegen/swiftmark/rank.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/Indodegen/swiftmark/reward.svg)](https://make.fun/bounty/markdown-render-speed-02)

## Run it

```sh
node main.ts
```

It reads `cases.json` from `MAKEFUN_INPUT_DIR` (default `/input`) and writes `html.json` to `MAKEFUN_OUTPUT_DIR` (default `/output`).

## How it works

`parse.js` is a single-file, zero-dependency parser:

- **Blocks** (`parseBlocks`): ATX/setext headings, fenced and indented code, blockquotes, lists (with lazy continuations and task items), tables, HTML blocks, thematic breaks, and link reference definitions.
- **Inline** (`inlineToHtml`): emphasis/strong with the CommonMark delimiter algorithm, links and images (inline, reference, collapsed, shortcut), autolinks (angle, `www.`, scheme, email), code spans, strikethrough, entities, and hard/soft breaks.
- **Correctness**: the parser is developed against the official scorer — all 680 CommonMark + GFM spec cases pass, and the 40 long practice documents are matched byte-for-byte against marked's output, including marked's quirks around tab expansion in blockquotes and lists, table empty rows from tab-only lines, lazy-continuation indentation, HTML-block trailing newlines, `<a>`-tag suppression of bare autolinks, tentative autolinks inside strikethrough in link text, and emphasis suppression across a run-span label and a later code span.
- **Speed**: `parse()` is stateless per call (no caching between calls, no module-level memo, no I/O, deterministic). The reference-definition collection pass is skipped entirely when the document cannot contain one (no `]:` in the source), and the `\r\n` normalisation is skipped when the source has no `\r`, so the common case is a single render pass.

## Layout

- `parse.js` — the parser (exports `parse(markdown)`).
- `main.ts` — the make.fun runner (reads `cases.json`, writes `html.json`).
- `LICENSE` — MIT.

Entered on [make.fun](https://make.fun/?ref=nh8nx71y&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
