import { Plugin } from '@opencode/plugin';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildBootstrap } from './lib/extract-rules.js';
import { readSkill } from './lib/read-skill.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(__dirname, '../../..');
const skillPath = path.join(repositoryRoot, 'skills', 'simple-english', 'SKILL.md');
const promptPath = path.join(repositoryRoot, 'prompts', 'system-prompt.md');
let cachedBootstrap;

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

function getBootstrap() {
  if (cachedBootstrap === undefined) {
    let promptText;
    try {
      promptText = fs.readFileSync(promptPath, 'utf8');
    } catch {
      console.warn('[simple-english] Could not read context prompt; using fallback rules.');
    }
    cachedBootstrap = buildBootstrap(promptText);
  }

  return cachedBootstrap;
}

function removeOwnedParts(messages, ownedParts) {
  if (!Array.isArray(messages)) return;

  const removedParts = new Set();
  for (const message of messages) {
    if (!message || message.role !== 'user' || !Array.isArray(message.content)) continue;

    for (let index = message.content.length - 1; index >= 0; index -= 1) {
      const part = message.content[index];
      if (part && typeof part === 'object' && ownedParts.has(part)) {
        message.content.splice(index, 1);
        removedParts.add(part);
      }
    }
  }

  for (const part of removedParts) ownedParts.delete(part);
}

export default Plugin.define({
  id: 'simple-english',
  async setup(ctx) {
    const ownedParts = new WeakSet();
    let skill;
    try {
      skill = readSkill(fs.readFileSync(skillPath, 'utf8'), skillPath);
    } catch (error) {
      console.warn(`[simple-english] Could not read skill at ${skillPath}: ${describeError(error)}`);
    }

    // Keep setup running after a read failure so later hook registrations can proceed.
    if (skill) {
      await ctx.skill.transform((editor) => {
        try {
          const existing = editor.get(skill.id);
          if (existing !== undefined) {
            if (existing.path !== skill.path) {
              console.warn(`[simple-english] Skipping skill from ${skill.path}; ${skill.id} already exists at ${existing.path}`);
              return;
            }
            editor.update(skill.id, (current) => Object.assign(current, skill));
            return;
          }

          editor.add({ ...skill });
        } catch (error) {
          console.warn(`[simple-english] Could not update skill in editor: ${describeError(error)}`);
        }
      });
    }

    await ctx.session.hook('context', async (event) => {
      const messages = event?.messages;
      removeOwnedParts(messages, ownedParts);

      if (typeof event?.agent !== 'string' || event.agent.length === 0) {
        console.warn('[simple-english] Cannot determine context eligibility: missing agent ID.');
        return;
      }
      if (typeof event?.sessionID !== 'string' || event.sessionID.length === 0) {
        console.warn('[simple-english] Cannot determine context eligibility: missing session ID.');
        return;
      }
      if (typeof ctx.agent.get !== 'function') {
        throw new TypeError('ctx.agent.get must be a function');
      }

      let agentResult;
      try {
        agentResult = await ctx.agent.get({ agentID: event.agent });
      } catch {
        console.warn('[simple-english] Cannot determine context eligibility: agent lookup failed.');
        return;
      }

      const agent = agentResult?.data;
      if (!agent || typeof agent !== 'object' || agent.id !== event.agent) {
        console.warn('[simple-english] Cannot determine context eligibility: agent is unknown.');
        return;
      }
      if (agent.mode === 'subagent') return;
      if (agent.mode !== 'primary' && agent.mode !== 'all') {
        console.warn('[simple-english] Cannot determine context eligibility: agent mode is unknown.');
        return;
      }
      if (typeof ctx.session.get !== 'function') {
        throw new TypeError('ctx.session.get must be a function');
      }

      let session;
      try {
        session = await ctx.session.get({ sessionID: event.sessionID });
      } catch {
        console.warn('[simple-english] Cannot determine context eligibility: session lookup failed.');
        return;
      }

      if (!session || typeof session !== 'object' || session.id !== event.sessionID) {
        console.warn('[simple-english] Cannot determine context eligibility: session is unknown.');
        return;
      }
      if (session.parentID !== undefined && session.parentID !== null) return;

      if (!Array.isArray(messages)) return;
      const firstUserMessage = messages.find((message) => message && message.role === 'user');
      if (!firstUserMessage || !Array.isArray(firstUserMessage.content)) return;

      const part = { type: 'text', text: getBootstrap() };
      firstUserMessage.content.unshift(part);
      ownedParts.add(part);
    });
  },
});
