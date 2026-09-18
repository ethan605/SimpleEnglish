import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'url';
import path from 'path';

import {
  FALLBACK_CONTEXT,
  PREAMBLE,
  buildBootstrap,
  resolveRuleBlock,
  ruleBlock,
  stripFrontmatter,
  wrapRuleBlock,
} from './extract-rules.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_PROMPT = path.resolve(__dirname, '..', '..', '..', 'prompts', 'system-prompt.md');

const SYNTHETIC_PAGE = [
  '# Standalone system prompt',
  '',
  'For harnesses without SKILL.md support: paste this block into your system prompt.',
  '',
  '---',
  '',
  'RULE BLOCK LINE ONE.',
  'THE REPLY lives here too.',
  '',
  '---',
  '',
  '## Word-budget version (~60 tokens)',
  '',
  '> Short variant.',
].join('\n');

test('removes YAML frontmatter with LF or CRLF line endings', () => {
  assert.equal(stripFrontmatter('---\nname: x\n---\nBody'), 'Body');
  assert.equal(stripFrontmatter('---\r\nname: x\r\n---\r\nBody'), 'Body');
});

test('ruleBlock returns only the text between the two horizontal rules', () => {
  const block = ruleBlock(SYNTHETIC_PAGE);
  assert.ok(block.includes('RULE BLOCK LINE ONE.'));
  assert.ok(block.includes('THE REPLY'));
  assert.ok(!block.includes('Standalone system prompt'), 'the page title leaked');
  assert.ok(!block.includes('Word-budget'), 'the word-budget section leaked');
  assert.ok(!block.includes('paste this block'), 'the packaging paragraph leaked');
});

test('the shipped prompt extracts the rule block only', () => {
  const content = readFileSync(REPO_PROMPT, 'utf8');
  const block = resolveRuleBlock(content);
  assert.ok(block.includes('THE REPLY'));
  assert.ok(!block.includes('Standalone system prompt'), 'the page title leaked');
  assert.ok(!block.includes('Word-budget'), 'the word-budget section leaked');
  assert.ok(!block.includes('paste this block'), 'the packaging paragraph leaked');
});

test('empty or missing prompt text falls back to the upstream fallback ruleset', () => {
  assert.equal(resolveRuleBlock(''), FALLBACK_CONTEXT);
  assert.equal(resolveRuleBlock(undefined), FALLBACK_CONTEXT);
  assert.ok(FALLBACK_CONTEXT.includes('SIMPLE ENGLISH SKILL ACTIVE AUTOMATICALLY'));
});

test('PREAMBLE states the precedence carve-outs and the subagent exemption', () => {
  assert.ok(PREAMBLE.includes('take precedence'));
  assert.ok(PREAMBLE.includes('free-form prose replies'));
  assert.ok(PREAMBLE.includes('delegated subagent task'));
});

test('wrapRuleBlock encloses the block verbatim inside the markers after the preamble', () => {
  const block = 'RULE ONE.\nRULE TWO.';
  const wrapped = wrapRuleBlock(block);
  assert.ok(wrapped.startsWith(PREAMBLE));
  const inner = wrapped.slice(
    wrapped.indexOf('<simple-english-rules>'),
    wrapped.indexOf('</simple-english-rules>'),
  );
  assert.ok(inner.includes('<simple-english-rules>'));
  assert.ok(wrapped.endsWith('</simple-english-rules>'));
  assert.ok(wrapped.includes(`<simple-english-rules>\n${block}\n</simple-english-rules>`));
});

test('buildBootstrap uses the extracted block from the shipped prompt, verbatim', () => {
  const content = readFileSync(REPO_PROMPT, 'utf8');
  const bootstrap = buildBootstrap(content);
  const expected = resolveRuleBlock(content);
  assert.ok(bootstrap.includes(`<simple-english-rules>\n${expected}\n</simple-english-rules>`));
});

test('buildBootstrap wraps the fallback ruleset when no prompt text is readable', () => {
  const bootstrap = buildBootstrap('');
  assert.ok(bootstrap.includes(`<simple-english-rules>\n${FALLBACK_CONTEXT}\n</simple-english-rules>`));
});
