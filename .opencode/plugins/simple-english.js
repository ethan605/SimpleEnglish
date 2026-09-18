/**
 * SimpleEnglish plugin for OpenCode.ai
 *
 * Registers the bundled skills directory via the config hook and injects the
 * ASD-STE100 writing rules into the first user message of each prompt build
 * via a message transform.
 *
 * This module exports ONLY the plugin function: opencode's legacy plugin
 * loader treats every module export as a plugin, so helpers live in
 * ./lib/extract-rules.js.
 */

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

import { buildBootstrap } from './lib/extract-rules.js';

// Bun (opencode's plugin runtime) supports __dirname in ESM, but Node does
// not; resolve from import.meta.url so the module works under both.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const skillsDir = path.resolve(__dirname, '..', '..', 'skills');
const promptPath = path.resolve(__dirname, '..', '..', 'prompts', 'system-prompt.md');

// Primary agents whose free-form prose replies must follow the STE rules.
// Gating is fail-closed: any agent not on this list (unknown, missing, or a
// subagent) means skip, never inject. Future custom primary agents must be
// added to this allowlist.
const PRIMARY_AGENTS = new Set(['build', 'plan']);

// Module-level cache for the bootstrap content. The prompt file does not
// change during a session, and the transform hook fires on every agent step,
// so the read + extract work must happen once.
let _bootstrapCache;

const getBootstrap = () => {
  if (_bootstrapCache !== undefined) return _bootstrapCache;
  let promptText = '';
  try {
    promptText = fs.readFileSync(promptPath, 'utf8');
  } catch {
    // Missing or unreadable: resolveRuleBlock falls back to the hardcoded ruleset.
  }
  _bootstrapCache = buildBootstrap(promptText);
  return _bootstrapCache;
};

// Parts this plugin injected into a live message array. Keyed by part object
// identity: a re-entry of the same in-memory array is a no-op, while a fresh
// array (new part objects) is injected again, which is intended because the
// hook fires on every prompt build. User-authored marker text must not
// suppress injection, so there is no string-marker guard.
const injectedBootstrapParts = new WeakSet();

export const SimpleEnglishPlugin = async () => ({
  // Register the bundled skills directory so OpenCode discovers the
  // simple-english skill without manual symlinks or config file edits.
  config: async (config) => {
    config.skills = config.skills || {};
    config.skills.paths = config.skills.paths || [];
    if (!config.skills.paths.includes(skillsDir)) {
      config.skills.paths.push(skillsDir);
    }
  },

  // Inject the STE bootstrap into the FIRST user message of the prompt array.
  // A user message (not a system message) avoids token bloat from repeated
  // system messages and multi-system-message model breakage.
  'experimental.chat.messages.transform': async (_input, output) => {
    const messages = output?.messages;
    if (!messages || messages.length === 0) return;

    // Resolve the agent from the LATEST user message, iterating from the end.
    // There is deliberately no session-to-agent map: it can go stale when an
    // internal agent (title, summary) writes the latest user-visible message.
    let agent;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].info?.role === 'user') {
        agent = messages[i].info?.agent;
        break;
      }
    }
    if (!agent || !PRIMARY_AGENTS.has(agent)) return;

    const firstUser = messages.find((m) => m.info?.role === 'user');
    if (!firstUser || !firstUser.parts || firstUser.parts.length === 0) return;

    // Idempotency: skip only if this plugin already injected a part into this
    // in-memory message.
    if (firstUser.parts.some((part) => injectedBootstrapParts.has(part))) return;

    const ref = firstUser.parts[0];
    const part = { ...ref, type: 'text', text: getBootstrap() };
    injectedBootstrapParts.add(part);
    firstUser.parts.unshift(part);
  },
});
