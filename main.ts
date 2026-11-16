import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { parse } from './parse.js';

// SwiftMark runner: reads cases.json from MAKEFUN_INPUT_DIR and writes
// the rendered HTML array to MAKEFUN_OUTPUT_DIR/html.json.
//
// The input is an array of {id, markdown}; the output is a JSON array
// of HTML strings in the same order. Defaults match the make.fun
// harness (/input and /output). parse() is stateless per call, so the
// map is a plain sequential pass with no shared state between cases.
const inputDir = process.env.MAKEFUN_INPUT_DIR || '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR || '/output';

const cases = JSON.parse(readFileSync(inputDir + '/cases.json', 'utf8'));
const html = new Array(cases.length);
for (let k = 0; k < cases.length; k++) html[k] = parse(cases[k].markdown);

mkdirSync(outputDir, { recursive: true });
writeFileSync(outputDir + '/html.json', JSON.stringify(html));
