import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SimpleEnglishPlugin } from './simple-english.js';

const hooks = await SimpleEnglishPlugin();
const transform = hooks['experimental.chat.messages.transform'];

function makeMessages(agent) {
  return [
    { info: { role: 'user', agent }, parts: [{ type: 'text', text: 'first user message' }] },
    { info: { role: 'assistant', agent }, parts: [{ type: 'text', text: 'assistant reply' }] },
    { info: { role: 'user', agent }, parts: [{ type: 'text', text: 'latest user message' }] },
  ];
}

function firstUserMessage(messages) {
  return messages.find((m) => m.info.role === 'user');
}

function injectionCount(messages) {
  const firstUser = firstUserMessage(messages);
  if (!firstUser) return 0;
  return firstUser.parts.filter(
    (p) => p.type === 'text' && typeof p.text === 'string' && p.text.includes('<simple-english-rules>'),
  ).length;
}

test('injects the bootstrap into the first user message for the build agent', async () => {
  const messages = makeMessages('build');
  await transform(undefined, { messages });
  const firstUser = firstUserMessage(messages);
  assert.equal(injectionCount(messages), 1);
  assert.equal(firstUser.parts[0].type, 'text');
  assert.ok(firstUser.parts[0].text.includes('<simple-english-rules>'));
  assert.ok(firstUser.parts[0].text.includes('THE REPLY'));
  assert.ok(firstUser.parts[0].text.includes('take precedence'));
});

test('injects the bootstrap into the first user message for the plan agent', async () => {
  const messages = makeMessages('plan');
  await transform(undefined, { messages });
  assert.equal(injectionCount(messages), 1);
});

for (const agent of ['general', 'explore', 'reviewer']) {
  test(`skips injection for the ${agent} agent`, async () => {
    const messages = makeMessages(agent);
    await transform(undefined, { messages });
    assert.equal(injectionCount(messages), 0);
    assert.equal(firstUserMessage(messages).parts.length, 1);
  });
}

test('skips injection when the latest user message carries an unknown agent', async () => {
  const messages = makeMessages('build');
  messages[2].info.agent = 'title';
  await transform(undefined, { messages });
  assert.equal(injectionCount(messages), 0);
});

test('skips injection when the latest user message has no agent, even if the first has one', async () => {
  const messages = makeMessages('build');
  delete messages[2].info.agent;
  await transform(undefined, { messages });
  assert.equal(injectionCount(messages), 0);
});

test('skips injection when the array has no user message', async () => {
  const messages = [{ info: { role: 'assistant', agent: 'build' }, parts: [{ type: 'text', text: 'reply' }] }];
  await transform(undefined, { messages });
  assert.equal(injectionCount(messages), 0);
});

test('two fresh message arrays each receive exactly one injection', async () => {
  const first = makeMessages('build');
  const second = makeMessages('build');
  await transform(undefined, { messages: first });
  await transform(undefined, { messages: second });
  assert.equal(injectionCount(first), 1);
  assert.equal(injectionCount(second), 1);
});

test('a second transform on the same array is a no-op (WeakSet guard)', async () => {
  const messages = makeMessages('build');
  await transform(undefined, { messages });
  await transform(undefined, { messages });
  assert.equal(injectionCount(messages), 1);
  assert.equal(firstUserMessage(messages).parts.length, 2);
});

test('config hook registers the skills path, creating the array if absent', async () => {
  const hooksForConfig = await SimpleEnglishPlugin();
  const config = {};
  await hooksForConfig.config(config);
  assert.ok(Array.isArray(config.skills.paths));
  assert.equal(config.skills.paths.length, 1);
  assert.ok(config.skills.paths[0].endsWith('skills'));
});

test('config hook does not push a duplicate skills path', async () => {
  const hooksForConfig = await SimpleEnglishPlugin();
  const seed = {};
  await hooksForConfig.config(seed);
  const config = { skills: { paths: [...seed.skills.paths] } };
  await hooksForConfig.config(config);
  assert.equal(config.skills.paths.length, 1);
});
