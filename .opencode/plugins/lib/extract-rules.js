// Rule extraction and bootstrap assembly for the SimpleEnglish opencode plugin.
//
// prompts/system-prompt.md is a page for people: a title, a paragraph that
// says where to paste the block, the rule block between two "---" lines, then
// a word-budget variant. The model gets the rule block only. The extraction
// mirrors src/hooks/simple-english-activate.js so the Claude Code hook and the
// opencode plugin agree on what the rules are.

// Same short hardcoded fallback the upstream hook ships when the prompt file
// is missing or unreadable.
export const FALLBACK_CONTEXT = `SIMPLE ENGLISH SKILL ACTIVE AUTOMATICALLY

Apply ASD-STE100 Simplified Technical English to technical-writing tasks. Use short sentences, active voice, one term for one meaning, and conditions before commands. Do not change code, identifiers, commands, or quoted errors.`;

// Precedence preamble: what outranks the rules, and when the rules apply.
export const PREAMBLE = `SIMPLE ENGLISH RULES

Precedence: instructions from the system, plan-mode reminders, agent output contracts, mandated structures (plans, reviews, tables required by a workflow), code, commands, and safety warnings take precedence over the rules below. These rules govern only free-form prose replies to the user. A session executing a delegated subagent task ignores these rules unless the task itself is prose writing.`;

export function stripFrontmatter(content) {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

// The text between the first two "---" horizontal rules of the page, the rule
// block itself. Falls back to the whole content when no fence pair exists.
export function ruleBlock(content) {
  const fence = /^---[ \t]*\r?$/m;
  const first = content.search(fence);
  if (first === -1) {
    return content;
  }
  const rest = content.slice(first).replace(fence, '');
  const second = rest.search(fence);
  return second === -1 ? rest : rest.slice(0, second);
}

// The rule block for the model: extracted from the prompt page, or the
// fallback ruleset when no prompt text is readable.
export function resolveRuleBlock(promptText) {
  if (!promptText) {
    return FALLBACK_CONTEXT;
  }
  return ruleBlock(stripFrontmatter(promptText)).trim();
}

// The rule block stays byte-verbatim, enclosed in markers, preceded by the
// precedence preamble.
export function wrapRuleBlock(block) {
  return `${PREAMBLE}\n\n<simple-english-rules>\n${block}\n</simple-english-rules>`;
}

export function buildBootstrap(promptText) {
  return wrapRuleBlock(resolveRuleBlock(promptText));
}
