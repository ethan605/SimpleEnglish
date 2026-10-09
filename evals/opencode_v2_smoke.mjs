import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMP_PARENT = '/tmp/opencode';
const TIMEOUT_MS = 60_000;
const EXPECTED_VERSION = '2.0.25';
const REDACTED = '[REDACTED]';
const passwords = new Set();
let commandLogInvocation = 0;
const runRoot = createRunRoot();
const runLogDirectory = path.join(runRoot, 'logs');
mkdirSync(runLogDirectory, { recursive: true });

const { buildBootstrap } = await import(pathToFileURL(path.join(
  ROOT,
  '.opencode/plugins/simple-english/lib/extract-rules.js',
)).href);
const { readSkill } = await import(pathToFileURL(path.join(
  ROOT,
  '.opencode/plugins/simple-english/lib/read-skill.js',
)).href);
const canonicalPrompt = readFileSync(path.join(ROOT, 'prompts/system-prompt.md'), 'utf8');
const expectedBootstrap = buildBootstrap(canonicalPrompt);
const canonicalSkillText = readFileSync(path.join(ROOT, 'skills/simple-english/SKILL.md'), 'utf8');
const expectedSkill = readSkill(canonicalSkillText, path.join(ROOT, 'skills/simple-english/SKILL.md'));
const referencePaths = [...new Set([...expectedSkill.content.matchAll(/references\/[A-Za-z0-9._-]+\.md/g)]
  .map((match) => match[0]))].sort();

function createRunRoot() {
  mkdirSync(TEMP_PARENT, { recursive: true });
  return mkdtempSync(path.join(TEMP_PARENT, 'simple-english-v2-smoke-'));
}

function within(candidate, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function safeText(value) {
  let text = String(value);
  for (const password of passwords) {
    if (password) text = text.replaceAll(password, REDACTED);
  }
  return text
    .replace(/((?:proxy-)?authorization\s*:\s*basic\s+)\S+/gi, `$1${REDACTED}`)
    .replace(/(["']?(?:password|api[_-]?key|access[_-]?token)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, `$1${REDACTED}`)
    .replace(/(\bpassword\b.{0,24}?)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${REDACTED}`)
    .replace(/(\bopencode\s*:\s*)\S+/gi, `$1${REDACTED}`);
}

function fail(message) {
  throw new Error(safeText(message));
}

function insist(condition, message) {
  if (!condition) fail(message);
}

function assertChildEnvironment(environment, paths) {
  const expectedKeys = [
    'PATH', 'HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
    'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'LANG', 'LC_ALL',
  ];
  insist(isDeepStrictEqual(Object.keys(environment).sort(), expectedKeys.sort()), 'child environment key set differs from the fixed allowlist');
  insist(environment.PATH === (process.env.PATH || '/usr/local/bin:/usr/bin:/bin'), 'child PATH differs from the allowed parent PATH');
  insist(environment.HOME === paths.home, 'child HOME is not isolated');
  insist(environment.XDG_CONFIG_HOME === paths.xdgConfig, 'child XDG config path is not isolated');
  insist(environment.XDG_DATA_HOME === paths.xdgData, 'child XDG data path is not isolated');
  insist(environment.XDG_CACHE_HOME === paths.xdgCache, 'child XDG cache path is not isolated');
  insist(environment.XDG_STATE_HOME === paths.xdgState, 'child XDG state path is not isolated');
  insist(environment.LANG === 'C.UTF-8' && environment.LC_ALL === 'C.UTF-8', 'child locale differs from the fixed locale');
  insist(!Object.keys(environment).some((key) => key.startsWith('OPENCODE_')), 'child environment includes an OPENCODE variable');
  insist(!Object.keys(environment).some((key) => /(?:TOKEN|PASSWORD|SECRET|AUTH|API_KEY)/i.test(key)), 'child environment includes a credential or auth variable');
}

function childEnvironment(paths) {
  const environment = {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: paths.home,
    XDG_CONFIG_HOME: paths.xdgConfig,
    XDG_DATA_HOME: paths.xdgData,
    XDG_CACHE_HOME: paths.xdgCache,
    XDG_STATE_HOME: paths.xdgState,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
  };
  assertChildEnvironment(environment, paths);
  return environment;
}

function createPaths(label) {
  const root = path.join(runRoot, label);
  const paths = {
    root,
    home: path.join(root, 'home'),
    xdgConfig: path.join(root, 'xdg-config'),
    xdgData: path.join(root, 'xdg-data'),
    xdgCache: path.join(root, 'xdg-cache'),
    xdgState: path.join(root, 'xdg-state'),
    npmUserConfig: path.join(root, 'npmrc'),
    npmCache: path.join(root, 'npm-cache'),
  };
  for (const value of Object.values(paths)) {
    if (value !== root && value !== paths.npmUserConfig) mkdirSync(value, { recursive: true });
  }
  writeFileSync(paths.npmUserConfig, '');
  return paths;
}

function commandLogPath(paths, label, invocation) {
  assert(Number.isSafeInteger(invocation) && invocation > 0, 'command log invocation must be a positive safe integer');
  const routeName = path.basename(paths.root).replace(/[^A-Za-z0-9._-]/g, '-');
  const safeLabel = label.replace(/[^A-Za-z0-9._-]/g, '-');
  return path.join(runLogDirectory, `${routeName}-${String(invocation).padStart(3, '0')}-${safeLabel}.log`);
}

function assertCommandLogNamingContract() {
  const routeA = { root: path.join(runRoot, 'route-a-local') };
  const routeB = { root: path.join(runRoot, 'route-b-installed') };
  const logPaths = [
    commandLogPath(routeA, 'project-version', 1),
    commandLogPath(routeB, 'project-version', 2),
    commandLogPath(routeA, 'project-version', 3),
  ];
  assert.equal(new Set(logPaths).size, logPaths.length, 'command logs collided across routes or invocations');
  assert.deepEqual(logPaths.map((logPath) => path.basename(logPath)), [
    'route-a-local-001-project-version.log',
    'route-b-installed-002-project-version.log',
    'route-a-local-003-project-version.log',
  ]);
  for (const logPath of logPaths) insist(within(logPath, runLogDirectory), 'command log escaped the owned log directory');
}

function recordCommand(paths, label, command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: childEnvironment(paths),
    encoding: 'utf8',
    timeout: options.timeout ?? TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  const logPath = commandLogPath(paths, label, ++commandLogInvocation);
  const output = [
    `$ ${command} ${args.join(' ')}`,
    `exit: ${result.status ?? 'null'}`,
    result.error ? `error: ${result.error.message}` : '',
    'stdout:',
    result.stdout ?? '',
    'stderr:',
    result.stderr ?? '',
  ].filter(Boolean).join('\n');
  writeFileSync(logPath, `${safeText(output)}\n`);
  if (result.error || result.status !== 0) {
    fail(`${label} failed. Read sanitized output at ${logPath}`);
  }
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', logPath };
}

function listTreeEntries(root) {
  if (!existsSync(root)) return [];
  const entries = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    entries.push(entry.isDirectory() ? `${entry.name}/` : entry.name);
    if (entry.isDirectory()) {
      for (const child of listTreeEntries(entryPath)) entries.push(path.join(entry.name, child));
    }
  }
  return entries.sort();
}

function assertNoConfigFiles(root) {
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    insist(entry.name !== 'opencode.json' && entry.name !== 'opencode.jsonc', 'unexpected OpenCode config file in an isolated root');
    if (entry.isDirectory()) assertNoConfigFiles(entryPath);
  }
}

function assertNoAncestorSources(projectDir) {
  const sourceNames = ['.opencode', '.claude', '.agents', 'opencode.json', 'opencode.jsonc'];
  let current = path.dirname(projectDir);
  while (true) {
    for (const name of sourceNames) {
      insist(!existsSync(path.join(current, name)), 'recognized ambient ancestor configuration source can affect the fixture');
    }
    if (current === path.dirname(current)) break;
    current = path.dirname(current);
  }
}

function assertNoSeededRuntimeState(paths) {
  insist(readdirSync(paths.xdgData).length === 0, 'isolated XDG data root is not fresh');
  insist(readdirSync(paths.xdgState).length === 0, 'isolated XDG state root is not fresh');
  assertNoConfigFiles(paths.xdgConfig);
  insist(!existsSync(path.join(paths.home, '.claude')), 'isolated HOME contains a Claude config source');
  insist(!existsSync(path.join(paths.home, '.agents')), 'isolated HOME contains an agents config source');
}

function assertCleanCopiedPayload(projectDir) {
  for (const name of ['.git', 'node_modules', '.npmrc', '.claude', '.agents']) {
    insist(!existsSync(path.join(projectDir, name)), `copied package payload includes a forbidden source: ${name}`);
  }
}

function assertProjectSources(paths, projectDir, expectedPluginDir) {
  const configPath = path.join(projectDir, 'opencode.json');
  for (const name of ['.claude', '.agents', '.git', '.npmrc']) {
    insist(!existsSync(path.join(projectDir, name)), `unexpected project source exists: ${name}`);
  }
  if (path.basename(paths.root) === 'route-a-local') {
    const projectOpenCode = path.join(projectDir, '.opencode');
    const localPluginDir = path.join(projectOpenCode, 'plugins/simple-english');
    insist(!expectedPluginDir || path.resolve(expectedPluginDir) === localPluginDir, 'local plugin directory differs from the approved discovery path');
    insist(isDeepStrictEqual(listTreeEntries(projectOpenCode), listTreeEntries(path.join(ROOT, '.opencode'))), 'local .opencode tree differs from the approved package payload');
    assertNoConfigFiles(projectOpenCode);
  } else {
    insist(!existsSync(path.join(projectDir, '.opencode')), 'installed route project contains an ambient .opencode source');
  }
  insist(existsSync(configPath), 'temporary project opencode.json is missing');
  if (path.basename(paths.root) === 'route-a-local') {
    insist(existsSync(path.join(projectDir, 'node_modules')), 'local package dependencies were not installed in the copied project');
  } else {
    insist(!existsSync(path.join(projectDir, 'node_modules')), 'installed route project contains an unexpected node_modules directory');
  }
}

function assertPreStartIsolation(paths, projectDir, configText, expectedPluginDir, mockPort) {
  const environment = childEnvironment(paths);
  assertChildEnvironment(environment, paths);
  const tempRootPhysical = realpathSync(TEMP_PARENT);
  const runRootPhysical = realpathSync(paths.root);
  const projectPhysical = realpathSync(projectDir);
  insist(within(runRootPhysical, tempRootPhysical), 'owned run root is outside /tmp/opencode');
  insist(within(projectPhysical, runRootPhysical), 'temporary project is outside its owned run root');
  const checkedPluginDir = expectedPluginDir
    ?? (path.basename(paths.root) === 'route-a-local' ? path.join(projectDir, '.opencode/plugins/simple-english') : undefined);
  if (checkedPluginDir) {
    insist(within(realpathSync(checkedPluginDir), runRootPhysical), 'plugin directory is outside its owned run root');
  }
  assertNoAncestorSources(projectDir);
  assertProjectSources(paths, projectDir, expectedPluginDir);

  const configPath = path.join(projectDir, 'opencode.json');
  insist(readFileSync(configPath, 'utf8') === configText, 'project opencode.json is not byte-identical to the pinned fixture');
  const projectConfig = JSON.parse(configText);
  assertProbeConfiguration(projectConfig, expectedPluginDir, mockPort);

  const version = recordCommand(paths, `${path.basename(projectDir)}-version`, 'opencode', ['--version'], { cwd: projectDir });
  insist(version.stdout.trim() === `opencode v${EXPECTED_VERSION}`, `OpenCode version is not pinned to ${EXPECTED_VERSION}`);

  const debugPaths = recordCommand(paths, `${path.basename(projectDir)}-debug-paths`, 'opencode', ['debug', 'paths'], { cwd: projectDir });
  const parsedPaths = Object.fromEntries(debugPaths.stdout.trim().split('\n').map((line) => {
    const match = /^(\w+)\s+(\S.*?)\s*$/.exec(line);
    insist(match, 'cannot parse pinned OpenCode debug paths output');
    return [match[1], match[2]];
  }));
  const expectedPaths = {
    home: paths.home,
    config: path.join(paths.xdgConfig, 'opencode'),
    data: path.join(paths.xdgData, 'opencode'),
    cache: path.join(paths.xdgCache, 'opencode'),
    state: path.join(paths.xdgState, 'opencode'),
    bin: path.join(paths.xdgCache, 'opencode', 'bin'),
    log: path.join(paths.xdgData, 'opencode', 'log'),
    repos: path.join(paths.xdgData, 'opencode', 'repos'),
    db: path.join(paths.xdgData, 'opencode', 'opencode.db'),
    tmp: TEMP_PARENT,
  };
  for (const [name, expected] of Object.entries(expectedPaths)) {
    insist(parsedPaths[name] === expected, `OpenCode debug path ${name} escaped its owned input`);
  }
}

function assertProbeConfiguration(config, expectedPluginDir, mockPort) {
  const expectedKeys = ['$schema', 'model', 'providers', 'agents'];
  if (expectedPluginDir) expectedKeys.push('plugins');
  assert.deepEqual(Object.keys(config).sort(), expectedKeys.sort(), 'probe configuration keys differ from the pinned fixture');
  assert.equal(config.$schema, 'https://opencode.ai/config.json');
  assert.equal(config.model, 'probe/fake');
  assert.deepEqual(Object.keys(config.providers), ['probe']);
  const provider = config.providers.probe;
  assert.equal(provider.package, '@opencode/ai/providers/openai-compatible');
  assert.deepEqual(provider.settings, {
    baseURL: `http://127.0.0.1:${mockPort}/v1`,
    apiKey: 'probe-only',
  });
  const endpoint = new URL(provider.settings.baseURL);
  insist(endpoint.protocol === 'http:' && endpoint.hostname === '127.0.0.1' && endpoint.port, 'model endpoint is not an owned loopback endpoint');
  assert.deepEqual(Object.keys(provider.models), ['fake']);
  assert.deepEqual(provider.models.fake, {
    modelID: 'fake',
    name: 'Local probe',
    capabilities: { tools: true, input: ['text'], output: ['text'] },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 65536, input: 64000, output: 256 },
  });
  assert.deepEqual(config.agents, {
    think: { mode: 'primary', model: 'probe/fake', system: 'Reply OK without using tools.' },
    probe_all: { mode: 'all', model: 'probe/fake', system: 'Reply OK without using tools.' },
    probe_subagent: { mode: 'subagent', model: 'probe/fake', system: 'Reply OK without using tools.' },
    title: { model: 'probe/fake' },
  });
  if (expectedPluginDir) assert.deepEqual(config.plugins, [expectedPluginDir]);
}

function canonicalExpectedConfigInfo(configText) {
  const expected = structuredClone(JSON.parse(configText));
  const selections = [
    ['model', expected, 'model'],
    ['agents.think.model', expected.agents.think, 'model'],
    ['agents.probe_all.model', expected.agents.probe_all, 'model'],
    ['agents.probe_subagent.model', expected.agents.probe_subagent, 'model'],
    ['agents.title.model', expected.agents.title, 'model'],
  ];
  for (const [field, owner, key] of selections) {
    insist(owner[key] === 'probe/fake', `probe fixture selection differs at ${field}`);
    owner[key] = { providerID: 'probe', model: 'fake' };
  }
  return expected;
}

function configInfoMatches(actualInfo, expectedInfo) {
  return isDeepStrictEqual(actualInfo, expectedInfo);
}

function assertConfigInfoComparatorContract(configText) {
  const canonicalExpected = canonicalExpectedConfigInfo(configText);
  const normalizedSelections = [
    canonicalExpected.model,
    canonicalExpected.agents.think.model,
    canonicalExpected.agents.probe_all.model,
    canonicalExpected.agents.probe_subagent.model,
    canonicalExpected.agents.title.model,
  ];
  for (const selection of normalizedSelections) {
    insist(isDeepStrictEqual(selection, { providerID: 'probe', model: 'fake' }), 'canonical expected model selection differs from pinned normalization');
  }
  insist(configInfoMatches(structuredClone(canonicalExpected), canonicalExpected), 'canonical exact config-info self-check rejected the unchanged expected fixture');

  const mutations = [
    ['root model providerID', (info) => { info.model.providerID = 'not-probe'; }],
    ['all-agent model ID', (info) => { info.agents.probe_all.model.model = 'not-fake'; }],
    ['provider package', (info) => { info.providers.probe.package = 'unexpected-provider'; }],
    ['provider baseURL', (info) => { info.providers.probe.settings.baseURL = 'http://127.0.0.2:1/v1'; }],
    ['unexpected top-level property', (info) => { info.unexpected = true; }],
    ['unapproved model variant', (info) => { info.agents.think.model.variant = 'high'; }],
  ];
  for (const [name, mutate] of mutations) {
    const changed = structuredClone(canonicalExpected);
    mutate(changed);
    insist(!configInfoMatches(changed, canonicalExpected), `config-info equality self-check accepted mutation: ${name}`);
  }
}

function probeConfiguration(mockPort, installedPluginDir) {
  const config = {
    $schema: 'https://opencode.ai/config.json',
    model: 'probe/fake',
    providers: {
      probe: {
        package: '@opencode/ai/providers/openai-compatible',
        settings: { baseURL: `http://127.0.0.1:${mockPort}/v1`, apiKey: 'probe-only' },
        models: {
          fake: {
            modelID: 'fake', name: 'Local probe',
            capabilities: { tools: true, input: ['text'], output: ['text'] },
            cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
            limit: { context: 65536, input: 64000, output: 256 },
          },
        },
      },
    },
    agents: {
      think: { mode: 'primary', model: 'probe/fake', system: 'Reply OK without using tools.' },
      probe_all: { mode: 'all', model: 'probe/fake', system: 'Reply OK without using tools.' },
      probe_subagent: { mode: 'subagent', model: 'probe/fake', system: 'Reply OK without using tools.' },
      title: { model: 'probe/fake' },
    },
  };
  if (installedPluginDir) config.plugins = [installedPluginDir];
  return config;
}

function copyPayload(destination) {
  mkdirSync(destination, { recursive: true });
  for (const entry of ['package.json', 'package-lock.json', '.opencode', 'prompts', 'skills']) {
    cpSync(path.join(ROOT, entry), path.join(destination, entry), { recursive: true });
  }
}

function startLocalProvider() {
  const captures = [];
  const unexpectedPosts = [];
  const otherGets = [];
  const server = createServer(async (request, response) => {
    const requestPath = new URL(request.url, 'http://127.0.0.1').pathname;
    if (request.method === 'GET' && requestPath === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        object: 'list',
        data: [{ id: 'fake', object: 'model', created: 0, owned_by: 'probe' }],
      }));
      return;
    }
    if (request.method === 'POST' && requestPath === '/v1/chat/completions') {
      let rawBody = '';
      for await (const chunk of request) rawBody += chunk;
      let body;
      try {
        body = JSON.parse(rawBody);
      } catch {
        unexpectedPosts.push({ method: request.method, path: request.url, error: 'invalid JSON' });
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'invalid JSON' }));
        return;
      }
      captures.push({ body, capturedAt: Date.now() });
      if (body.model !== 'fake') {
        unexpectedPosts.push({ method: request.method, path: request.url, model: body.model });
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'unexpected model' }));
        return;
      }
      const id = `chatcmpl-local-${captures.length}`;
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      response.write(`data: ${JSON.stringify({
        id, object: 'chat.completion.chunk', created: 0, model: 'fake',
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      })}\n\n`);
      response.write(`data: ${JSON.stringify({
        id, object: 'chat.completion.chunk', created: 0, model: 'fake',
        choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: null }],
      })}\n\n`);
      response.write(`data: ${JSON.stringify({
        id, object: 'chat.completion.chunk', created: 0, model: 'fake',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      })}\n\n`);
      response.end('data: [DONE]\n\n');
      return;
    }
    if (request.method === 'POST') {
      unexpectedPosts.push({ method: request.method, path: request.url });
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    if (request.method === 'GET') otherGets.push(request.url);
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'not found' }));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve({
        server,
        port: server.address().port,
        captures,
        unexpectedPosts,
        otherGets,
      });
    });
  });
}

function withTimeout(promise, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function closeHttpServer(server) {
  if (!server.listening) return Promise.resolve();
  return withTimeout(
    new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
    TIMEOUT_MS,
    'timed out closing local provider',
  );
}

function parsePassword(text) {
  const patterns = [
    /\bpassword\b(?:\s+for\s+basic\s+auth)?(?:\s*[:=]\s*|\s+)["']?([^\s"'`]+)/i,
    /["']password["']\s*:\s*["']([^"']+)["']/i,
    /\bopencode\s*[:\t ]+([A-Za-z0-9._~+/=-]{8,})\b/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match && match[1] && match[1].length >= 8) {
      passwords.add(match[1]);
      return match[1];
    }
  }
  return undefined;
}

function completeServerLogLines(serverState) {
  return [serverState.stdout, serverState.stderr]
    .flatMap((text) => text.split(/\r?\n/).slice(0, -1))
    .join('\n');
}

function startOpenCode(paths, cwd, port) {
  const child = spawn('opencode', ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd,
    env: childEnvironment(paths),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const state = { child, stdout: '', stderr: '', password: undefined };
  const append = (name, chunk) => {
    state[name] = `${state[name]}${chunk.toString('utf8')}`.slice(-2_000_000);
    state.password ??= parsePassword(completeServerLogLines(state));
  };
  child.stdout.on('data', (chunk) => append('stdout', chunk));
  child.stderr.on('data', (chunk) => append('stderr', chunk));
  return state;
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return withTimeout(
    new Promise((resolve) => child.once('exit', resolve)),
    timeoutMs,
    'timed out waiting for OpenCode server process',
  );
}

async function stopOpenCode(state) {
  if (!state || state.child.exitCode !== null || state.child.signalCode !== null) return;
  state.child.kill('SIGTERM');
  try {
    await waitForExit(state.child, 10_000);
  } catch {
    state.child.kill('SIGKILL');
    await waitForExit(state.child, TIMEOUT_MS);
  }
}

function hostClient(serverState, port) {
  const baseUrl = `http://127.0.0.1:${port}`;
  function authHeader() {
    insist(serverState.password, 'OpenCode server did not expose its generated Basic auth password');
    return `Basic ${Buffer.from(`opencode:${serverState.password}`).toString('base64')}`;
  }
  return {
    async request(method, route, body, timeoutMs = TIMEOUT_MS) {
      const boundedTimeout = Math.max(1, Math.min(TIMEOUT_MS, Math.floor(timeoutMs)));
      const response = await fetch(new URL(route, baseUrl), {
        method,
        headers: {
          authorization: authHeader(),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(boundedTimeout),
      });
      const text = await response.text();
      let data;
      let jsonParsed = true;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          jsonParsed = false;
        }
      }
      return { status: response.status, data, jsonParsed };
    },
  };
}

async function waitForServer(serverState, port) {
  const deadline = Date.now() + TIMEOUT_MS;
  let lastStatus = 'server has not started';
  while (Date.now() < deadline) {
    if (serverState.child.exitCode !== null) {
      fail(`OpenCode server exited with ${serverState.child.exitCode} before readiness`);
    }
    serverState.password ??= parsePassword(completeServerLogLines(serverState));
    if (serverState.password) {
      try {
        const response = await hostClient(serverState, port).request('GET', '/openapi.json');
        if (response.status === 200 && response.data?.openapi) return response.data;
        lastStatus = `GET /openapi.json returned ${response.status}`;
      } catch (error) {
        lastStatus = safeText(error.message);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  fail(`OpenCode server did not become ready within ${TIMEOUT_MS} ms (${lastStatus})`);
}

function assertOpenApiContracts(openapi) {
  const contracts = [
    { path: '/api/config', method: 'get', operationId: 'config.get', status: '200', deepLocation: true },
    { path: '/api/provider/{providerID}', method: 'get', operationId: 'provider.get', status: '200', deepLocation: true },
    { path: '/api/plugin', method: 'get', operationId: 'plugin.list', status: '200', deepLocation: true },
    { path: '/api/skill', method: 'get', operationId: 'skill.list', status: '200', deepLocation: true },
    { path: '/api/session', method: 'post', operationId: 'session.create', status: '200', fields: ['location', 'agent', 'model', 'parentID'] },
    { path: '/api/session/{sessionID}/prompt', method: 'post', operationId: 'session.prompt', status: '200', fields: ['text'] },
    { path: '/api/session/{sessionID}/agent', method: 'post', operationId: 'session.switchAgent', status: '204', fields: ['agent'] },
    { path: '/api/location/reload', method: 'post', operationId: 'location.reload', status: '204' },
    { path: '/api/experimental/session/{sessionID}/wait', method: 'post', operationId: 'experimental.session.wait', status: '204' },
  ];
  for (const contract of contracts) {
    const operation = openapi.paths?.[contract.path]?.[contract.method];
    insist(operation, `pinned OpenAPI operation is missing: ${contract.method.toUpperCase()} ${contract.path}`);
    assert.equal(operation.operationId, contract.operationId, `OpenAPI operation ID changed for ${contract.path}`);
    insist(Object.hasOwn(operation.responses ?? {}, contract.status), `pinned OpenAPI response ${contract.status} is missing for ${contract.path}`);
    if (contract.deepLocation) {
      insist(operation.parameters?.some((parameter) => parameter.name === 'location' && parameter.style === 'deepObject' && parameter.explode === true),
        `pinned deep-object location query is missing for ${contract.path}`);
    }
    if (contract.fields) {
      const schema = operation.requestBody?.content?.['application/json']?.schema;
      insist(operation.requestBody?.required === true && schema?.type === 'object', `pinned JSON request body is missing for ${contract.path}`);
      for (const field of contract.fields) {
        insist(Object.hasOwn(schema.properties ?? {}, field), `pinned request field ${field} is missing for ${contract.path}`);
      }
    } else {
      insist(!operation.requestBody, `unexpected request body in pinned contract for ${contract.path}`);
    }
  }
}

async function findAvailablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitUntil(predicate, description) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  fail(`timed out waiting for ${description}`);
}

function queryForLocation(projectDir) {
  return new URLSearchParams({ 'location[directory]': projectDir }).toString();
}

function providerNotFoundResponse(providerID = 'probe') {
  return {
    status: 404,
    jsonParsed: true,
    data: { _tag: 'ProviderNotFoundError', providerID, message: 'provider is not registered yet' },
  };
}

function providerSuccessResponse(projectDir, mockPort, overrides = {}) {
  return {
    status: 200,
    jsonParsed: true,
    data: {
      location: { directory: projectDir },
      data: {
        id: overrides.id ?? 'probe',
        package: '@opencode/ai/providers/openai-compatible',
        settings: { baseURL: overrides.baseURL ?? `http://127.0.0.1:${mockPort}/v1` },
      },
    },
  };
}

function readinessTestClock() {
  let currentTime = 0;
  const sleeps = [];
  return {
    now: () => currentTime,
    sleeps,
    elapsed: () => currentTime,
    async sleep(milliseconds) {
      sleeps.push(milliseconds);
      currentTime += milliseconds;
    },
  };
}

async function expectReadinessFailure(run, expectedMessage) {
  let failure;
  try {
    await run();
  } catch (error) {
    failure = error;
  }
  insist(failure instanceof Error, 'readiness self-check expected a failure');
  insist(failure.message === expectedMessage, 'readiness self-check received an unexpected failure class');
}

function isProbeNotFoundResponse(response) {
  const body = response?.data;
  return response?.jsonParsed === true
    && body !== null
    && typeof body === 'object'
    && !Array.isArray(body)
    && isDeepStrictEqual(Object.keys(body).sort(), ['_tag', 'message', 'providerID'])
    && body._tag === 'ProviderNotFoundError'
    && body.providerID === 'probe'
    && typeof body.message === 'string';
}

async function waitForProviderReadiness({
  request,
  serverIsAlive,
  now = Date.now,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  timeoutMs = TIMEOUT_MS,
}) {
  const budget = Math.min(TIMEOUT_MS, timeoutMs);
  if (!Number.isFinite(budget) || budget <= 0) fail('provider readiness timeout budget is invalid');
  const deadline = now() + budget;

  while (true) {
    if (!serverIsAlive()) fail('owned OpenCode server exited during provider readiness');
    let remaining = deadline - now();
    if (remaining <= 0) fail('timed out waiting for probe provider registration');

    let response;
    try {
      response = await request(remaining);
    } catch {
      fail('GET /api/provider/probe failed during provider readiness');
    }
    if (!serverIsAlive()) fail('owned OpenCode server exited during provider readiness');
    remaining = deadline - now();
    if (remaining <= 0) fail('timed out waiting for probe provider registration');
    if (!response || typeof response.status !== 'number') fail('provider readiness returned an invalid HTTP result');
    if (response.status === 200) return response;
    if (response.status !== 404) fail(`GET /api/provider/probe returned HTTP ${response.status} during provider readiness`);
    if (response.jsonParsed !== true) fail('provider readiness 404 response was not valid JSON');
    if (!isProbeNotFoundResponse(response)) fail('provider readiness 404 was not the exact ProviderNotFoundError for probe');

    const waitMilliseconds = Math.min(100, remaining);
    if (waitMilliseconds <= 0) fail('timed out waiting for probe provider registration');
    try {
      await sleep(waitMilliseconds);
    } catch {
      fail('provider readiness wait failed');
    }
  }
}

function assertProviderResponse(providerResponse, projectDir, mockPort) {
  insist(providerResponse.status === 200, 'GET /api/provider/probe did not return HTTP 200');
  insist(providerResponse.jsonParsed === true, 'provider response was not valid JSON');
  insist(providerResponse.data?.location?.directory === projectDir, 'provider response location differs from the owned project');
  const providerInfo = providerResponse.data?.data;
  insist(providerInfo?.id === 'probe', 'provider response id differs from probe');
  insist(providerInfo?.package === '@opencode/ai/providers/openai-compatible', 'provider response package differs from the pinned fixture');
  insist(providerInfo?.settings?.baseURL === `http://127.0.0.1:${mockPort}/v1`, 'provider response baseURL differs from the loopback fixture');
  const endpoint = new URL(providerInfo.settings.baseURL);
  insist(endpoint.protocol === 'http:' && endpoint.hostname === '127.0.0.1' && endpoint.port === String(mockPort), 'provider response endpoint is not the exact loopback fixture');
}

async function assertProviderReadinessSelfChecks() {
  const projectDir = '/tmp/opencode/provider-readiness-self-check/project';
  const mockPort = 41873;
  const validResponse = providerSuccessResponse(projectDir, mockPort);

  const delayedClock = readinessTestClock();
  const delayedResponses = [providerNotFoundResponse(), providerNotFoundResponse(), validResponse];
  const delayedTimeouts = [];
  let delayedRequestCount = 0;
  const delayed = await waitForProviderReadiness({
    request: async (remaining) => {
      delayedTimeouts.push(remaining);
      return delayedResponses[delayedRequestCount++];
    },
    serverIsAlive: () => true,
    now: delayedClock.now,
    sleep: delayedClock.sleep,
    timeoutMs: 1000,
  });
  assertProviderResponse(delayed, projectDir, mockPort);
  assert.equal(delayedRequestCount, 3, 'delayed registry self-check did not make exactly three requests');
  assert.deepEqual(delayedTimeouts, [1000, 900, 800], 'provider request timeouts did not use the remaining deadline');
  assert.deepEqual(delayedClock.sleeps, [100, 100], 'provider registry polling interval exceeded 100 ms');

  const absentClock = readinessTestClock();
  let absentRequestCount = 0;
  await expectReadinessFailure(() => waitForProviderReadiness({
    request: async () => {
      absentRequestCount += 1;
      return providerNotFoundResponse();
    },
    serverIsAlive: () => true,
    now: absentClock.now,
    sleep: absentClock.sleep,
    timeoutMs: 250,
  }), 'timed out waiting for probe provider registration');
  assert.equal(absentRequestCount, 3, 'permanent absence did not stop at the shortened deadline');
  assert.equal(absentClock.elapsed(), 250, 'permanent absence exceeded its single deadline');
  assert.ok(absentClock.sleeps.every((milliseconds) => milliseconds <= 100), 'permanent absence used an overlong polling interval');

  for (const status of [401, 500]) {
    let requestCount = 0;
    await expectReadinessFailure(() => waitForProviderReadiness({
      request: async () => {
        requestCount += 1;
        return { status, jsonParsed: true, data: {} };
      },
      serverIsAlive: () => true,
      now: () => 0,
      sleep: async () => {},
      timeoutMs: 1000,
    }), `GET /api/provider/probe returned HTTP ${status} during provider readiness`);
    assert.equal(requestCount, 1, `HTTP ${status} readiness failure was retried`);
  }

  for (const response of [
    { status: 404, jsonParsed: true, data: { _tag: 'NotFound', message: 'route not found' } },
    providerNotFoundResponse('another-provider'),
  ]) {
    let requestCount = 0;
    await expectReadinessFailure(() => waitForProviderReadiness({
      request: async () => {
        requestCount += 1;
        return response;
      },
      serverIsAlive: () => true,
      now: () => 0,
      sleep: async () => {},
      timeoutMs: 1000,
    }), 'provider readiness 404 was not the exact ProviderNotFoundError for probe');
    assert.equal(requestCount, 1, 'unexpected 404 shape was retried');
  }

  for (const [response, expectedMessage] of [
    [providerSuccessResponse(projectDir, mockPort, { id: 'another-provider' }), 'provider response id differs from probe'],
    [providerSuccessResponse(projectDir, mockPort, { baseURL: 'https://example.invalid/v1' }), 'provider response baseURL differs from the loopback fixture'],
  ]) {
    let requestCount = 0;
    const ready = await waitForProviderReadiness({
      request: async () => {
        requestCount += 1;
        return response;
      },
      serverIsAlive: () => true,
      now: () => 0,
      sleep: async () => {},
      timeoutMs: 1000,
    });
    let strictFailure;
    try {
      assertProviderResponse(ready, projectDir, mockPort);
    } catch (error) {
      strictFailure = error;
    }
    insist(strictFailure instanceof Error && strictFailure.message === expectedMessage, 'mismatched 200 did not fail the strict provider gate');
    assert.equal(requestCount, 1, 'mismatched 200 response was retried');
  }

  let networkRequestCount = 0;
  await expectReadinessFailure(() => waitForProviderReadiness({
    request: async () => {
      networkRequestCount += 1;
      throw new Error('synthetic private network detail');
    },
    serverIsAlive: () => true,
    now: () => 0,
    sleep: async () => {},
    timeoutMs: 1000,
  }), 'GET /api/provider/probe failed during provider readiness');
  assert.equal(networkRequestCount, 1, 'network failure was retried');

  let parseRequestCount = 0;
  await expectReadinessFailure(() => waitForProviderReadiness({
    request: async () => {
      parseRequestCount += 1;
      return { status: 404, jsonParsed: false };
    },
    serverIsAlive: () => true,
    now: () => 0,
    sleep: async () => {},
    timeoutMs: 1000,
  }), 'provider readiness 404 response was not valid JSON');
  assert.equal(parseRequestCount, 1, 'unparseable 404 response was retried');
}

function providerPostCounts(provider) {
  return { captures: provider.captures.length, unexpectedPosts: provider.unexpectedPosts.length };
}

function assertNoProviderPostsSince(provider, expectedCounts) {
  const currentCounts = providerPostCounts(provider);
  insist(currentCounts.captures === expectedCounts.captures && currentCounts.unexpectedPosts === expectedCounts.unexpectedPosts,
    'provider POST occurred before source and endpoint gates passed');
}

function assertProviderPostBoundaryContract() {
  const provider = { captures: [{}], unexpectedPosts: [] };
  const baseline = providerPostCounts(provider);
  assertNoProviderPostsSince(provider, baseline);
  provider.unexpectedPosts.push({});
  let failure;
  try {
    assertNoProviderPostsSince(provider, baseline);
  } catch (error) {
    failure = error;
  }
  insist(failure instanceof Error && failure.message === 'provider POST occurred before source and endpoint gates passed',
    'provider-post boundary self-check did not reject a new POST');
}

async function assertRuntimeConfigSources(client, paths, projectDir, configText, expectedPluginDir, mockPort, provider, serverState) {
  const providerPostsBeforeGate = providerPostCounts(provider);
  const configResponse = await client.request('GET', `/api/config?${queryForLocation(projectDir)}`);
  insist(configResponse.status === 200, 'GET /api/config did not return HTTP 200');
  const entries = configResponse.data;
  insist(Array.isArray(entries), 'GET /api/config response is not a direct Config.Entry array');
  insist(entries.every((entry) => entry?.type === 'document' || entry?.type === 'directory'), 'GET /api/config returned an unknown source type');

  const documents = entries.filter((entry) => entry.type === 'document');
  insist(documents.length === 1, 'GET /api/config did not return exactly one project document');
  const configPath = path.join(projectDir, 'opencode.json');
  insist(typeof documents[0].path === 'string' && path.resolve(documents[0].path) === configPath, 'GET /api/config document path is not the owned project file');
  const expectedConfig = canonicalExpectedConfigInfo(configText);
  insist(configInfoMatches(documents[0].info, expectedConfig), 'GET /api/config document info differs from the normalized exact probe fixture');
  if (expectedPluginDir) {
    insist(Array.isArray(documents[0].info.plugins) && documents[0].info.plugins.length === 1 && documents[0].info.plugins[0] === expectedPluginDir,
      'Route B project document does not contain only the explicit installed plugin directory');
  } else {
    insist(!Object.hasOwn(documents[0].info, 'plugins'), 'Route A document contains an explicit plugin entry');
  }

  const expectedDirectories = [path.join(paths.xdgConfig, 'opencode')];
  const projectOpenCode = path.join(projectDir, '.opencode');
  if (existsSync(projectOpenCode)) expectedDirectories.push(projectOpenCode);
  const directories = entries.filter((entry) => entry.type === 'directory');
  insist(directories.length === expectedDirectories.length, 'GET /api/config returned an unexpected directory source count');
  for (const expectedDirectory of expectedDirectories) {
    insist(directories.filter((entry) => typeof entry.path === 'string' && path.resolve(entry.path) === expectedDirectory).length === 1,
      'GET /api/config directory source is outside the exact owned allowlist');
  }
  insist(entries.length === documents.length + directories.length, 'GET /api/config returned an unclassified source');

  const providerRoute = `/api/provider/probe?${queryForLocation(projectDir)}`;
  const providerResponse = await waitForProviderReadiness({
    request: (remaining) => client.request('GET', providerRoute, undefined, remaining),
    serverIsAlive: () => serverState.child.exitCode === null && serverState.child.signalCode === null,
  });
  assertProviderResponse(providerResponse, projectDir, mockPort);
  assertNoProviderPostsSince(provider, providerPostsBeforeGate);
}

async function getLocationList(client, endpoint, projectDir) {
  const result = await client.request('GET', `${endpoint}?${queryForLocation(projectDir)}`);
  assert.equal(result.status, 200, `GET ${endpoint} must return 200`);
  assert.equal(result.data.location?.directory, projectDir, `${endpoint} returned another project location`);
  insist(Array.isArray(result.data.data), `${endpoint} response did not wrap its data array`);
  return result.data.data;
}

async function assertPluginRegistration(client, projectDir, pluginDir, shouldExist = true) {
  const plugins = await getLocationList(client, '/api/plugin', projectDir);
  const expectedEntrypoint = path.join(pluginDir, 'index.js');
  const matching = plugins.filter((plugin) => plugin.id === 'simple-english' || plugin.source?.path === expectedEntrypoint);
  if (!shouldExist) {
    assert.equal(matching.length, 0, 'simple-english plugin remained registered after reload');
    return;
  }
  assert.equal(matching.length, 1, 'expected one simple-english plugin registration');
  assert.equal(matching[0].id, 'simple-english');
  assert.equal(matching[0].source?.type, 'local');
  assert.equal(path.resolve(matching[0].source?.path), path.resolve(expectedEntrypoint), 'plugin source path differs from the expected entrypoint');
  assert.equal(matching[0].state?.status, 'active', 'simple-english plugin did not load successfully');
  assert.equal(Object.hasOwn(matching[0].state ?? {}, 'error'), false, 'active plugin reports a load error');
}

async function assertSkillRegistration(client, projectDir, skillPath, shouldExist = true) {
  const skills = await getLocationList(client, '/api/skill', projectDir);
  const matching = skills.filter((skill) => skill.id === 'simple-english');
  if (!shouldExist) {
    assert.equal(matching.length, 0, 'simple-english skill remained registered after reload');
    return;
  }
  assert.equal(matching.length, 1, 'expected one simple-english skill');
  const skill = matching[0];
  assert.equal(skill.name, expectedSkill.name);
  assert.equal(skill.description, expectedSkill.description);
  assert.equal(path.resolve(skill.path), path.resolve(skillPath), 'skill path is not the canonical absolute path');
  assert.equal(skill.content, expectedSkill.content, 'registered skill body differs from the canonical body');
  assert.ok(referencePaths.length > 0, 'canonical skill has no reference links');
  const skillDirectory = path.dirname(skillPath);
  for (const reference of referencePaths) {
    const referencePath = path.resolve(skillDirectory, reference);
    insist(within(referencePath, skillDirectory), `skill reference escapes the canonical skill directory: ${reference}`);
    insist(existsSync(referencePath), `canonical skill reference does not resolve: ${referencePath}`);
    insist(readFileSync(referencePath, 'utf8').length > 0, `canonical skill reference is empty: ${referencePath}`);
  }
}

async function createSession(client, projectDir, agent, parentID) {
  const body = {
    location: { directory: projectDir },
    agent,
    model: { providerID: 'probe', id: 'fake' },
    ...(parentID === undefined ? {} : { parentID }),
  };
  const result = await client.request('POST', '/api/session', body);
  assert.equal(result.status, 200, 'POST /api/session must return 200');
  insist(result.data?.data?.id, 'POST /api/session did not return .data.id');
  if (parentID !== undefined) assert.equal(result.data.data.parentID, parentID, 'child session did not retain its parentID');
  return result.data.data;
}

function markerLabel(marker) {
  return marker.startsWith('probe-user-authored-marker:') ? 'probe-user-authored-marker' : marker;
}

async function promptAndWait(client, sessionID, marker) {
  const label = markerLabel(marker);
  const prompt = await client.request('POST', `/api/session/${sessionID}/prompt`, { text: marker });
  assert.equal(prompt.status, 200, `prompt admission failed for ${label}`);
  insist(prompt.data?.data, `prompt admission did not return .data for ${label}`);
  const wait = await client.request('POST', `/api/experimental/session/${sessionID}/wait`);
  assert.equal(wait.status, 204, `session wait did not complete for ${label}`);
}

function messageText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (typeof part === 'string') return part;
    return typeof part?.text === 'string' ? part.text : '';
  }).join('');
}

function userMessageTexts(capture) {
  return (capture.body?.messages ?? [])
    .filter((message) => message?.role === 'user')
    .map((message) => messageText(message.content));
}

function allRequestText(capture) {
  return (capture.body?.messages ?? []).map((message) => messageText(message?.content)).join('\n');
}

function firstUserText(capture) {
  return userMessageTexts(capture)[0] ?? '';
}

function occurrences(text, needle) {
  if (!needle) return 0;
  return text.split(needle).length - 1;
}

function requestsForMarker(captures, marker) {
  return captures.filter((capture) => allRequestText(capture).includes(marker));
}

async function assertInjectedForMarker(provider, marker, expectedOccurrences = 1) {
  const label = markerLabel(marker);
  await waitUntil(() => requestsForMarker(provider.captures, marker).length > 0, `model request for ${label}`);
  const matching = requestsForMarker(provider.captures, marker);
  const injected = matching.filter((capture) => occurrences(firstUserText(capture), expectedBootstrap) === expectedOccurrences);
  assert.equal(injected.length, 1, `expected one primary model request with ${expectedOccurrences} bootstrap occurrence(s) for ${label}`);
  assert.ok(firstUserText(injected[0]).startsWith(expectedBootstrap), `bootstrap was not prepended to first-user content for ${label}`);
  assert.equal(injected[0].body.model, 'fake', `request for ${label} selected a non-fixture model`);
  for (const capture of matching) {
    assert.equal(capture.body.model, 'fake', `auxiliary request for ${label} selected a non-fixture model`);
    if (capture !== injected[0]) {
      insist(occurrences(firstUserText(capture), expectedBootstrap) < expectedOccurrences,
        `an auxiliary request duplicated the bootstrap for ${label}`);
    }
  }
}

async function assertExcludedForMarker(provider, marker) {
  const label = markerLabel(marker);
  await waitUntil(() => requestsForMarker(provider.captures, marker).length > 0, `excluded model request for ${label}`);
  const matching = requestsForMarker(provider.captures, marker);
  insist(matching.length > 0, `no provider request included the marker ${label}`);
  for (const capture of matching) {
    assert.equal(capture.body.model, 'fake', `request for ${label} selected a non-fixture model`);
    assert.equal(occurrences(firstUserText(capture), expectedBootstrap), 0, `excluded request received SimpleEnglish rules for ${label}`);
  }
}

const AUXILIARY_TITLE_SYSTEM_PREFIX = 'You are a title generator. You output ONLY a thread title. Nothing else.';

function isAuxiliaryTitleRequest(capture) {
  return (capture.body?.messages ?? [])
    .some((message) => message?.role === 'system' && messageText(message.content).startsWith(AUXILIARY_TITLE_SYSTEM_PREFIX));
}

function assertTitleClassifierContract() {
  const auxiliaryTitle = {
    body: {
      messages: [
        { role: 'system', content: 'You are a title generator. You output ONLY a thread title. Nothing else.' },
        { role: 'user', content: 'probe-primary-1' },
      ],
    },
  };
  const primaryMentioningTitle = {
    body: {
      messages: [
        { role: 'system', content: 'The title service uses a separate request for conversation titles.' },
        { role: 'user', content: 'probe-primary-1' },
      ],
    },
  };
  insist(isAuxiliaryTitleRequest(auxiliaryTitle), 'title classifier missed the pinned auxiliary title request');
  insist(!isAuxiliaryTitleRequest(primaryMentioningTitle), 'title classifier treated an ordinary primary instruction as an auxiliary request');
}

function assertNoUnexpectedPosts(provider, routeName) {
  assert.deepEqual(provider.unexpectedPosts, [], `${routeName} sent unexpected provider POST requests`);
  for (const capture of provider.captures) {
    assert.equal(capture.body.model, 'fake', `${routeName} sent a model request for another model`);
  }
}

async function assertTitleExcluded(provider, capturesBeforeTitlePrompt, marker) {
  const relevant = provider.captures.slice(capturesBeforeTitlePrompt);
  const titleRequests = relevant.filter(isAuxiliaryTitleRequest);
  assert.equal(titleRequests.length, 1, `OpenCode did not issue exactly one distinguishable auxiliary title request for ${marker}`);
  for (const capture of titleRequests) {
    assert.ok(allRequestText(capture).includes(marker), 'auxiliary title request did not include its scenario marker');
    assert.equal(capture.body.model, 'fake', 'auxiliary title request did not use the local fake model');
    assert.equal(occurrences(firstUserText(capture), expectedBootstrap), 0, 'auxiliary title request received the SimpleEnglish bootstrap');
  }
}

function writeProjectConfig(projectDir, config) {
  const text = `${JSON.stringify(config, null, 2)}\n`;
  writeFileSync(path.join(projectDir, 'opencode.json'), text);
  return text;
}

function diagnosticsForProvider(provider) {
  return {
    captures: provider.captures.map((capture) => ({
      model: capture.body.model,
      messages: capture.body.messages,
      stream: capture.body.stream,
    })),
    unexpectedPosts: provider.unexpectedPosts,
    otherGets: provider.otherGets,
  };
}

function persistRouteLogs(routeName, paths, serverState, provider, error) {
  const parts = [
    `route: ${routeName}`,
    `error: ${error ? safeText(error.stack ?? error.message) : 'none'}`,
    `stdout:\n${serverState?.stdout ?? ''}`,
    `stderr:\n${serverState?.stderr ?? ''}`,
    `provider:\n${JSON.stringify(provider ? diagnosticsForProvider(provider) : {}, null, 2)}`,
  ];
  const routeLog = path.join(runLogDirectory, `${routeName}-live.log`);
  writeFileSync(routeLog, `${safeText(parts.join('\n\n'))}\n`);
  writeFileSync(path.join(paths.root, 'route-result.json'), JSON.stringify({
    route: routeName,
    failed: Boolean(error),
    error: error ? safeText(error.stack ?? error.message) : null,
    log: routeLog,
  }, null, 2));
}

async function runScenarios(client, projectDir, pluginDir, skillPath, provider) {
  await assertPluginRegistration(client, projectDir, pluginDir);
  await assertSkillRegistration(client, projectDir, skillPath);

  const primary = await createSession(client, projectDir, 'think');
  const firstPromptCaptureStart = provider.captures.length;
  await promptAndWait(client, primary.id, 'probe-primary-1');
  await assertInjectedForMarker(provider, 'probe-primary-1');
  await assertTitleExcluded(provider, firstPromptCaptureStart, 'probe-primary-1');

  await promptAndWait(client, primary.id, 'probe-primary-2');
  await assertInjectedForMarker(provider, 'probe-primary-2');

  const userAuthoredMarker = `probe-user-authored-marker:${expectedBootstrap}`;
  const markerSession = await createSession(client, projectDir, 'think');
  await promptAndWait(client, markerSession.id, userAuthoredMarker);
  await assertInjectedForMarker(provider, userAuthoredMarker, 2);

  const allAgentSession = await createSession(client, projectDir, 'probe_all');
  await promptAndWait(client, allAgentSession.id, 'probe-all-1');
  await assertInjectedForMarker(provider, 'probe-all-1');

  const switchedSession = await createSession(client, projectDir, 'think');
  const switchResult = await client.request('POST', `/api/session/${switchedSession.id}/agent`, { agent: 'probe_subagent' });
  assert.equal(switchResult.status, 204, 'active-agent switch must return 204');
  await promptAndWait(client, switchedSession.id, 'probe-subagent-1');
  await assertExcludedForMarker(provider, 'probe-subagent-1');

  const parent = await createSession(client, projectDir, 'think');
  const child = await createSession(client, projectDir, 'think', parent.id);
  await promptAndWait(client, child.id, 'probe-child-1');
  await assertExcludedForMarker(provider, 'probe-child-1');
  assertNoUnexpectedPosts(provider, path.basename(projectDir));
}

async function runLifecycle(client, paths, projectDir, pluginDir, skillPath, mockPort, initialConfigText, provider, serverState) {
  const disabledConfig = probeConfiguration(mockPort);
  const disabledConfigText = writeProjectConfig(projectDir, disabledConfig);
  assertPreStartIsolation(paths, projectDir, disabledConfigText, undefined, mockPort);
  const disabledReload = await client.request('POST', '/api/location/reload');
  assert.equal(disabledReload.status, 204, 'location reload without explicit plugin must return 204');
  await assertRuntimeConfigSources(client, paths, projectDir, disabledConfigText, undefined, mockPort, provider, serverState);
  await assertPluginRegistration(client, projectDir, pluginDir, false);
  await assertSkillRegistration(client, projectDir, skillPath, false);

  const disabledSession = await createSession(client, projectDir, 'think');
  await promptAndWait(client, disabledSession.id, 'probe-reload-disabled-1');
  await assertExcludedForMarker(provider, 'probe-reload-disabled-1');

  writeFileSync(path.join(projectDir, 'opencode.json'), initialConfigText);
  assertPreStartIsolation(paths, projectDir, initialConfigText, pluginDir, mockPort);
  const restoredReload = await client.request('POST', '/api/location/reload');
  assert.equal(restoredReload.status, 204, 'location reload after restoring explicit plugin must return 204');
  await assertRuntimeConfigSources(client, paths, projectDir, initialConfigText, pluginDir, mockPort, provider, serverState);
  await assertPluginRegistration(client, projectDir, pluginDir);
  await assertSkillRegistration(client, projectDir, skillPath);

  const restoredSession = await createSession(client, projectDir, 'think');
  await promptAndWait(client, restoredSession.id, 'probe-reload-restored-1');
  await assertInjectedForMarker(provider, 'probe-reload-restored-1');
}

async function runRoute(routeName, explicitInstalledPlugin) {
  const paths = createPaths(routeName);
  const projectDir = path.join(paths.root, 'project');
  const provider = await startLocalProvider();
  let serverState;
  let routeError;
  try {
    if (routeName === 'route-a-local') {
      copyPayload(projectDir);
      assertCleanCopiedPayload(projectDir);
    } else {
      mkdirSync(projectDir, { recursive: true });
    }
    const pluginDir = explicitInstalledPlugin
      ? path.resolve(explicitInstalledPlugin)
      : path.join(projectDir, '.opencode/plugins/simple-english');
    const skillPath = explicitInstalledPlugin
      ? path.join(path.dirname(path.dirname(path.dirname(pluginDir))), 'skills/simple-english/SKILL.md')
      : path.join(projectDir, 'skills/simple-english/SKILL.md');
    const config = probeConfiguration(provider.port, explicitInstalledPlugin ? pluginDir : undefined);
    assertProbeConfiguration(config, explicitInstalledPlugin ? pluginDir : undefined, provider.port);
    const configText = writeProjectConfig(projectDir, config);
    assertConfigInfoComparatorContract(configText);
    if (!explicitInstalledPlugin) {
      recordCommand(paths, 'route-a-root-npm-ci', 'npm', [
        'ci', '--no-audit', '--no-fund',
        `--userconfig=${paths.npmUserConfig}`, `--cache=${paths.npmCache}`,
      ], { cwd: projectDir });
    }
    assertNoSeededRuntimeState(paths);
    assertPreStartIsolation(paths, projectDir, configText, explicitInstalledPlugin ? pluginDir : undefined, provider.port);

    const port = await findAvailablePort();
    serverState = startOpenCode(paths, projectDir, port);
    const openapi = await waitForServer(serverState, port);
    assertOpenApiContracts(openapi);
    const client = hostClient(serverState, port);
    assertNoProviderPostsSince(provider, { captures: 0, unexpectedPosts: 0 });
    await assertRuntimeConfigSources(
      client,
      paths,
      projectDir,
      configText,
      explicitInstalledPlugin ? pluginDir : undefined,
      provider.port,
      provider,
      serverState,
    );
    await runScenarios(client, projectDir, pluginDir, skillPath, provider);
    if (explicitInstalledPlugin) {
      await runLifecycle(client, paths, projectDir, pluginDir, skillPath, provider.port, configText, provider, serverState);
    }
    assertNoUnexpectedPosts(provider, routeName);
    return {
      routeName,
      projectDir,
      pluginDir,
      skillPath,
    };
  } catch (error) {
    routeError = error;
    throw error;
  } finally {
    await stopOpenCode(serverState);
    await closeHttpServer(provider.server);
    persistRouteLogs(routeName, paths, serverState, provider, routeError);
  }
}

function verifyInstalledPackage(paths, packagePrefix, pluginDir) {
  const installedPackage = path.join(packagePrefix, 'node_modules/simple-english');
  const installedIndexPath = path.join(pluginDir, 'index.js');
  const source = "import assert from 'node:assert/strict'; const {default:p}=await import('simple-english'); assert.equal(p.id,'simple-english'); assert.equal(typeof p.setup,'function')";
  const importResult = recordCommand(paths, 'route-b-node-package-main', process.execPath, ['--input-type=module', '-e', source], { cwd: packagePrefix });
  insist(!importResult.stderr.trim(), 'Node package-main import emitted a warning or error');
  const dependencyResolutionSource = [
    "import { createRequire } from 'node:module';",
    "import { fileURLToPath } from 'node:url';",
    `const installedIndexPath = ${JSON.stringify(installedIndexPath)};`,
    "const sdkPath = fileURLToPath(import.meta.resolve('@opencode/plugin'));",
    "const yamlPath = createRequire(installedIndexPath).resolve('yaml');",
    'console.log(JSON.stringify({ sdkPath, yamlPath }));',
  ].join(' ');
  const resolutionResult = recordCommand(paths, 'route-b-dependency-resolution', process.execPath,
    ['--input-type=module', '-e', dependencyResolutionSource], { cwd: packagePrefix });
  insist(!resolutionResult.stderr.trim(), 'installed dependency resolution emitted a warning or error');
  const resolvedDependencies = JSON.parse(resolutionResult.stdout);
  const dependencyRoot = realpathSync(path.join(packagePrefix, 'node_modules'));
  const sdkPath = realpathSync(resolvedDependencies.sdkPath);
  const yamlPath = realpathSync(resolvedDependencies.yamlPath);
  insist(within(sdkPath, dependencyRoot), `installed SDK resolved outside the owned dependency tree: ${sdkPath}`);
  insist(within(yamlPath, dependencyRoot), `installed YAML resolved outside the owned dependency tree: ${yamlPath}`);
  insist(existsSync(installedPackage), 'installed npm package directory is missing');
  return { installedPackage, installedIndexPath, sdkPath, yamlPath };
}

function assertPasswordParserContract() {
  for (const [line, expected] of [
    ['server password smoke-basic-auth-fixture-123', 'smoke-basic-auth-fixture-123'],
    ['password: smoke-basic-auth-fixture-456', 'smoke-basic-auth-fixture-456'],
  ]) {
    const parsed = parsePassword(line);
    passwords.delete(expected);
    assert.equal(parsed, expected, 'generated Basic auth password log format was not recognized');
  }
}

async function main() {
  assertCommandLogNamingContract();
  assertPasswordParserContract();
  assertTitleClassifierContract();
  assertProviderPostBoundaryContract();
  await assertProviderReadinessSelfChecks();
  const routeA = await runRoute('route-a-local');
  const routeBPaths = createPaths('route-b-installed');
  const packageSource = path.join(routeBPaths.root, 'package-source');
  const packDirectory = path.join(routeBPaths.root, 'pack');
  const packagePrefix = path.join(routeBPaths.root, 'installed-prefix');
  mkdirSync(packDirectory, { recursive: true });
  mkdirSync(packagePrefix, { recursive: true });
  copyPayload(packageSource);
  recordCommand(routeBPaths, 'route-b-npm-pack', 'npm', [
    'pack', '--pack-destination', packDirectory,
    `--userconfig=${routeBPaths.npmUserConfig}`, `--cache=${routeBPaths.npmCache}`,
  ], { cwd: packageSource });
  const tarballs = readdirSync(packDirectory).filter((entry) => entry.endsWith('.tgz'));
  assert.equal(tarballs.length, 1, 'npm pack did not create exactly one package tarball');
  const tarballPath = path.join(packDirectory, tarballs[0]);
  recordCommand(routeBPaths, 'route-b-npm-install', 'npm', [
    'install', '--prefix', packagePrefix, tarballPath, '--no-audit', '--no-fund',
    `--userconfig=${routeBPaths.npmUserConfig}`, `--cache=${routeBPaths.npmCache}`,
  ], { cwd: routeBPaths.root });
  const installedPluginDir = path.join(packagePrefix, 'node_modules/simple-english/.opencode/plugins/simple-english');
  const installedPackageChecks = verifyInstalledPackage(routeBPaths, packagePrefix, installedPluginDir);
  const routeB = await runRoute('route-b-installed', installedPluginDir);

  console.log(`OpenCode v${EXPECTED_VERSION} smoke passed.`);
  console.log(`Route A: automatic local discovery, skill references, primary/all injection, exclusions, marker ownership, and reinjection (${routeA.projectDir}).`);
  console.log(`Route B: installed directory loading, package main, SDK/YAML resolution, and reload lifecycle (${routeB.projectDir}).`);
  console.log(`Node package main: ${installedPackageChecks.installedPackage}`);
  console.log(`Installed dependencies: @opencode/plugin -> ${installedPackageChecks.sdkPath}; yaml -> ${installedPackageChecks.yamlPath}`);
  console.log(`Sanitized route logs: ${runLogDirectory}`);
}

try {
  await main();
} catch (error) {
  const message = safeText(error.stack ?? error.message);
  writeFileSync(path.join(runLogDirectory, 'failure.log'), `${message}\n`);
  console.error(`OpenCode v2.0.25 smoke failed: ${safeText(error.message)}`);
  console.error(`Sanitized logs: ${runLogDirectory}`);
  process.exitCode = 1;
}
