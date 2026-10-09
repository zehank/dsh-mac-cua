#!/usr/bin/env node
/**
 * dsh-cua — MCP server
 *
 * Exposes exactly two tools, mirroring the reference Computer Use plugin:
 *
 *   js        — run JavaScript in a persistent REPL with `sky` pre-injected
 *   js_reset  — discard REPL state and start clean
 *
 * The model drives every desktop action through those two tools rather than
 * through a wide,tool-per-action surface. The trade-off is deliberate: the tool
 * schema stays stable as capabilities grow, and each request carries the same
 * small tool definition.
 *
 * Wire format: newline-delimited JSON-RPC 2.0 over stdio (no Content-Length
 * framing) — this is what the MCP stdio transport uses.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PersistentRepl, preflight } = require('./repl.js');

const SUPPORTED_PROTOCOL_VERSIONS = [
  'DRAFT-2026-v1',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
  '2024-10-07',
];
const FALLBACK_PROTOCOL_VERSION = '2025-06-18';

const SERVER_NAME = 'dsh-cua';
const SERVER_VERSION = require('../package.json').version;

const repl = new PersistentRepl();

// --- Confirmation gate settings -------------------------------------------
// The gate follows the `cua-approval-gate` component's enable/disable switch in the
// settings UI (插件 -> cua -> 组件 -> 开关). Toggling it writes `disabled` to the
// profile's patch layer:
//   - disabled: false (enabled)  -> gate ON  (confirm before each write)
//   - disabled: true  (disabled) -> gate OFF (no confirmation)
// Re-read on every call so a change takes effect without restarting the harness.
const PROFILE_PATCH_PATH =
  process.env.DSH_CUA_PROFILE_PATCH || path.resolve(__dirname, '..', '..', '..', 'cordis.patch.yml');

/** Read the `disabled` flag of the `cua-approval-gate` entry; null when not present. */
function readComponentDisabled() {
  try {
    const text = fs.readFileSync(PROFILE_PATCH_PATH, 'utf8');
    const start = text.indexOf('- id: cua-approval-gate');
    if (start < 0) return null;
    // Bound the search to this entry so a later entry's field cannot match.
    const rest = text.slice(start + 1);
    const next = rest.search(/\n- /);
    const chunk = next < 0 ? rest : rest.slice(0, next);
    const m = chunk.match(/\bdisabled\s*:\s*(true|false)\b/);
    return m ? m[1] === 'true' : null;
  } catch {
    return null;
  }
}

function readApprovalEnabled() {
  // enabled (absent or disabled:false) -> gate on; disabled -> gate off.
  return readComponentDisabled() !== true;
}

function writeApprovalEnabled(enabled) {
  // Toggling the gate = toggling the component's `disabled` flag. The settings
  // UI reads this same patch entry, so the switch stays in sync.
  const value = enabled ? 'false' : 'true'; // gate on -> component enabled
  try {
    let text = fs.readFileSync(PROFILE_PATCH_PATH, 'utf8');
    const start = text.indexOf('- id: cua-approval-gate');
    if (start < 0) {
      text = text.replace(/\s*$/, '\n- id: cua-approval-gate\n  disabled: ' + value + '\n');
    } else {
      const lineStart = text.lastIndexOf('\n', start) + 1;
      const rest = text.slice(start + 1);
      const next = rest.search(/\n- /);
      const end = start + 1 + (next < 0 ? rest.length : next);
      let entry = text.slice(lineStart, end);
      if (/\bdisabled\s*:/.test(entry)) {
        entry = entry.replace(/\bdisabled\s*:\s*(true|false)\b/, 'disabled: ' + value);
      } else {
        entry = entry.replace(/(- id: cua-approval-gate\s*\n)/, '$1  disabled: ' + value + '\n');
      }
      text = text.slice(0, lineStart) + entry + text.slice(end);
    }
    fs.writeFileSync(PROFILE_PATCH_PATH, text);
    return true;
  } catch {
    return false;
  }
}

// Logs must never touch stdout — that channel carries protocol frames.
function log(message) {
  process.stderr.write(`[dsh-cua] ${message}\n`);
}

function readInstructions() {
  const dir = path.join(__dirname, '..', 'instructions');
  let text = '';
  for (const name of ['computer.md', 'computer-policy.md']) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) {
      text += fs.readFileSync(file, 'utf8') + '\n\n';
    }
  }
  return text.trim();
}

const INSTRUCTIONS = readInstructions();

const JS_DESCRIPTION = `Run JavaScript in a persistent REPL to control macOS desktop applications.

State persists across calls: variables declared in one \`js\` call are available in the next.
The \`sky\` API is already available — do NOT import it, it is injected as a global.
Top-level \`await\` is supported.

Reporting results:
  nodeRepl.write(string)   — append text to the tool result
  console.log(...)         — also captured into the tool result
  The value of the final expression is appended to the tool result automatically,
  so ending with \`await sky.get_app_state({ app })\` is usually enough.

Reading a screenshot (Screenshots come back as file:// URLs):
  const fs = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const state = await sky.get_app_state({ app: 'Finder' });
  if (state.screenshot) {
    await nodeRepl.emitImage({
      bytes: await fs.readFile(fileURLToPath(state.screenshot.url)),
      mimeType: 'image/png',
    });
  }

The workflow is always: read state -> act -> read state again.
Call get_app_state before acting, and again after, rather than assuming what changed.`;

const JS_RESET_DESCRIPTION =
  'Discard all JavaScript state and start a clean REPL context. ' +
  'Use it when a previous call left state you no longer want, ' +
  'or when a long task has finished and you want to release what it held.';

const TOOLS = [
  {
    name: 'js',
    description: JS_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'JavaScript to evaluate in the persistent REPL.',
        },
        approve: {
          type: 'boolean',
          description:
            'Set true only after the user has approved a blocked write action ' +
            '(click/type/key/drag/paste/scroll/set_value/select_text/perform_secondary_action) ' +
            'via ask_user_question. Without it, write actions throw APPROVAL_REQUIRED when the gate is on.',
        },
      },
      required: ['code'],
      additionalProperties: false,
    },
  },
  {
    name: 'approval_mode',
    description:
      'Read or change the computer-use confirmation gate. When ON, the agent must ask ' +
      'the user for approval before every write action (click, type, key, drag, paste, ' +
      'scroll, set_value, select_text, perform_secondary_action). When OFF, write actions ' +
      'run without confirmation. The setting is persisted to disk.',
    inputSchema: {
      type: 'object',
      properties: {
        enabled: {
          type: 'boolean',
          description: 'Omit to read the current state. Pass true/false to change it (persisted).',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'js_reset',
    description: JS_RESET_DESCRIPTION,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

// ---------------------------------------------------------------------------
// JSON-RPC over stdio
// ---------------------------------------------------------------------------

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function callTool(name, args) {
  if (name === 'js') {
    const code = args && typeof args.code === 'string' ? args.code : '';
    // Apply the gate before evaluating: read the current toggle, then mark the
    // call approved only when the agent explicitly passes approve: true.
    repl.setApprovalGate(readApprovalEnabled(), !!(args && args.approve === true));
    const result = await repl.evaluate(code);
    if (!result.ok) {
      return { content: [{ type: 'text', text: result.error }], isError: true };
    }
    const content = [];
    const text = result.blank
      ? '(the call produced no output — use nodeRepl.write(...) or end with a value to return something)'
      : result.output;
    content.push({ type: 'text', text });
    for (const img of result.images) {
      content.push({ type: 'image', data: fs.readFileSync(img.url.replace('file://', '')).toString('base64'), mimeType: img.mimeType });
    }
    return { content };
  }

  if (name === 'approval_mode') {
    const value = args && args.enabled;
    if (value === true || value === false) {
      const persisted = writeApprovalEnabled(value);
      const now = readApprovalEnabled();
      return { content: [{ type: 'text', text:
        `电脑操作确认已${now ? '开启' : '关闭'}（${persisted ? '已持久化' : '仅本次生效，写入失败'}）。`
      }] };
    }
    const now = readApprovalEnabled();
    return { content: [{ type: 'text', text:
      `当前电脑操作确认：${now ? '开启' : '关闭'}。` +
      (now ? '每次写操作前会要求授权。' : '写操作直接执行，无需授权。')
    }] };
  }

  if (name === 'js_reset') {
    const { resetCount } = repl.reset();
    return { content: [{ type: 'text', text: `REPL state cleared (reset #${resetCount}).` }] };
  }

  return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
}

async function handle(message) {
  const { id, method, params } = message || {};

  // Notifications carry no id and expect no reply.
  if (id === undefined || id === null) {
    if (method === 'notifications/initialized') log('client initialized');
    return;
  }

  switch (method) {
    case 'initialize': {
      const requested = params && params.protocolVersion;
      const version = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : FALLBACK_PROTOCOL_VERSION;
      sendResult(id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: INSTRUCTIONS,
      });
      log(`initialize: protocolVersion=${version}`);
      return;
    }

    case 'ping':
      sendResult(id, {});
      return;

    case 'tools/list':
      sendResult(id, { tools: TOOLS });
      return;

    case 'tools/call': {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      try {
        sendResult(id, await callTool(name, args));
      } catch (err) {
        // A tool that throws is reported as a failed result, not a protocol error,
        // so the model sees the failure and can react to it.
        sendResult(id, {
          content: [{ type: 'text', text: `${err && err.message ? err.message : String(err)}` }],
          isError: true,
        });
      }
      return;
    }

    case 'resources/list':
      sendResult(id, { resources: [] });
      return;

    case 'prompts/list':
      sendResult(id, { prompts: [] });
      return;

    default:
      sendError(id, -32601, `Method not found: ${method}`);
  }
}

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

let buffer = '';

// Requests currently being handled. A client can close stdin immediately after
// writing (a script piping a couple of frames does exactly that), and exiting
// on 'end' without draining would drop the response the client is waiting for.
let inFlight = 0;
let stdinEnded = false;

function maybeExit() {
  if (!stdinEnded || inFlight > 0) return;
  log('stdin closed and all requests settled, exiting');
  process.exit(0);
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index).replace(/\r$/, '').trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;

    let message;
    try {
      message = JSON.parse(line);
    } catch (err) {
      log(`could not parse a frame as JSON: ${err.message}`);
      continue;
    }

    // Handle sequentially so REPL state stays consistent between calls.
    // A notification expects no reply, so it must not hold the process open.
    const expectsReply = message && message.id != null;
    if (expectsReply) inFlight += 1;

    Promise.resolve(handle(message))
      .catch((err) => {
        log(`handler error: ${err && err.stack ? err.stack : err}`);
        if (expectsReply) {
          sendError(message.id, -32603, String(err && err.message ? err.message : err));
        }
      })
      .finally(() => {
        if (expectsReply) {
          inFlight -= 1;
          maybeExit();
        }
      });
  }
});

process.stdin.on('end', () => {
  stdinEnded = true;
  maybeExit();
});

// Startup self-check goes to stderr only, so it never corrupts the protocol.
(async () => {
  try {
    const report = await preflight();
    if (!report.accessibility) {
      log('WARNING: accessibility access is not granted. Computer Use cannot operate.');
      log(report.guidance);
    } else if (!report.screenCapture) {
      log('note: screen capture is unavailable; running in text-only mode.');
      log(report.guidance);
    } else {
      log('ready: accessibility and screen capture available');
    }
  } catch (err) {
    log(`preflight failed: ${err && err.message ? err.message : err}`);
  }
})();