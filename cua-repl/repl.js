/**
 * dsh-cua — persistent REPL
 *
 * Holds one long-lived V8 context across every `js` call, so variables survive
 * between invocations. That persistence is what lets the model build on a
 * previous observation instead of re-deriving everything each turn.
 *
 * Faithful to the reference design in one deliberate respect and one deliberate
 * divergence:
 *   - faithful: `globalThis.sky` is injected, and the API is reached through it
 *   - divergence: top-level `var` declarations are hoisted onto the global object.
 *     In a real Node REPL, `var x` lands on the global scope; inside the async
 *     wrapper used to support top-level `await`, it would otherwise die with the
 *     call. Hoisting preserves REPL semantics the model will expect.
 */

'use strict';

const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { sky, preflight, isTrusted } = require('../lib/sky.js');

// Write actions: methods that change system state and therefore require user
// approval when the confirmation gate is on. Read methods (get_app_state,
// list_apps, get_screenshot) are never gated.
const WRITE_METHODS = new Set([
  'click', 'drag', 'scroll', 'press_key', 'type_text', 'paste',
  'set_value', 'select_text', 'perform_secondary_action',
]);

const MAX_CAPTURED_CHARS = 200000;

class PersistentRepl {
  constructor() {
    this.context = null;
    this.emittedImages = [];
    this.captured = [];
    this.resetCount = 0;
    this._approveGateEnabled = true;  // confirmation required by default
    this._approveGatePassed = false;  // per-call approval, set before evaluate
    this._buildContext();
  }

  _buildContext() {
    const self = this;
    this.emittedImages = [];
    this.captured = [];

    const nodeRepl = {
      /**
       * Write text to the tool result. The reference API takes a single string;
       * objects must be stringified by the caller. We accept anything and
       * stringify objects, because silently receiving "[object Object]" is a
       * worse failure than being lenient.
       */
      write(value) {
        if (value === undefined || value === null) return;
        if (typeof value === 'string') {
          self.captured.push(value);
        } else {
          try {
            self.captured.push(JSON.stringify(value, null, 2));
          } catch {
            self.captured.push(String(value));
          }
        }
      },

      /**
       * Attach an image to the tool result. Accepts { bytes, mimeType } like the
       * reference API; the harness reads images back from a local file.
       */
      emitImage({ bytes, mimeType } = {}) {
        if (!bytes) return;
        let buf;
        if (Buffer.isBuffer(bytes)) buf = bytes;
        else if (bytes instanceof Uint8Array) buf = Buffer.from(bytes);
        else if (typeof bytes === 'string') buf = Buffer.from(bytes, 'base64');
        else return;

        const ext = (mimeType || 'image/png').includes('jpeg') ? 'jpg' : 'png';
        const dir = path.join(require('node:os').tmpdir(), 'dsh-cua-emitted');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `emit-${Date.now()}-${Math.floor(Math.random() * 10000)}.${ext}`);
        fs.writeFileSync(file, buf);
        self.emittedImages.push({ url: `file://${file}`, bytes: buf.length, mimeType: mimeType || 'image/png' });
      },
    };

    // Wrap the write methods so that, when the gate is enabled and the current
    // call has not been approved, any state-changing action throws instead of
    // running. Read methods are passed through untouched.
    const gatedSky = Object.create(null);
    for (const key of Object.keys(sky)) {
      if (WRITE_METHODS.has(key)) {
        const orig = sky[key];
        gatedSky[key] = async (...args) => {
          if (self._approveGateEnabled && !self._approveGatePassed) {
            throw new Error(
              `APPROVAL_REQUIRED: "sky.${key}(...)" is a write action and the confirmation gate is ON. ` +
              'Ask the user for approval (ask_user_question), then retry this exact js call with "approve": true.'
            );
          }
          return orig.apply(sky, args);
        };
      } else {
        gatedSky[key] = sky[key];
      }
    }

    const sandbox = {
      sky: gatedSky,
      nodeRepl,
      console: {
        log: (...args) => {
          self.captured.push(args.map((a) => {
            if (typeof a === 'string') return a;
            try { return JSON.stringify(a, null, 2); } catch { return String(a); }
          }).join(' '));
        },
        error: (...args) => {
          self.captured.push('[stderr] ' + args.map(String).join(' '));
        },
        warn: (...args) => {
          self.captured.push('[warn] ' + args.map(String).join(' '));
        },
      },
      Buffer,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      URL,
      TextEncoder,
      TextDecoder,
      JSON,
      Math,
      Date,
      Promise,
      Object,
      Array,
      String,
      Number,
      Boolean,
      Error,
      RegExp,
      Map,
      Set,
      Symbol,
      parseInt,
      parseFloat,
      isNaN,
      isFinite,
      encodeURIComponent,
      decodeURIComponent,
      structuredClone,
    };
    sandbox.globalThis = sandbox;
    this.context = vm.createContext(sandbox);

    // Capture the context's own AsyncFunction constructor. Using the host
    // realm's constructor instead would compile bodies that resolve globals
    // against the host — where `sky`, `nodeRepl` and earlier calls' variables
    // do not exist.
    this.AsyncFunction = vm.runInContext('(async function () {}).constructor', this.context, { timeout: 5000 });
  }

  /**
   * Rewrite only *top-level* `var` declarations to `globalThis.<name> = ...`.
   *
   * Top-level `var` must survive into the next call to behave like a REPL, but
   * the code is compiled inside an async function, which would scope it to the
   * call. Rewriting is the fix for that.
   *
   * This is done with a small scanner rather than a regex, because a regex cannot
   * tell a declaration from these, and rewrote all of them:
   *
   *   function f() { var x = 1; }   ->  changed the variable's scope
   *   var s = "  var z = 3;";       ->  rewrote text inside a string literal
   *
   * Only depth-0 statements are touched, and string, template and comment spans
   * are skipped entirely. This is still not a parser — a `var` inside a regex
   * literal at top level would fool it — but it is exact for real code, and the
   * failure mode is a missed hoist rather than corrupted source.
   */
  _hoistVars(code) {
    let out = '';
    let depth = 0;
    let quote = null;
    let inTemplate = false;
    let inLineComment = false;
    let inBlockComment = false;
    // True while at the start of a top-level statement, where `var` declares.
    let atStatementStart = true;

    for (let i = 0; i < code.length; i++) {
      const ch = code[i];
      const next = code[i + 1];

      if (inLineComment) {
        out += ch;
        if (ch === '\n') { inLineComment = false; atStatementStart = true; }
        continue;
      }
      if (inBlockComment) {
        out += ch;
        if (ch === '*' && next === '/') { out += next; i++; inBlockComment = false; }
        continue;
      }
      if (quote) {
        out += ch;
        if (ch === '\\') { if (next !== undefined) { out += next; i++; } continue; }
        if (ch === quote) quote = null;
        continue;
      }
      if (inTemplate) {
        out += ch;
        if (ch === '\\') { if (next !== undefined) { out += next; i++; } continue; }
        if (ch === '`') inTemplate = false;
        continue;
      }

      if (ch === '/' && next === '/') { out += ch + next; i++; inLineComment = true; continue; }
      if (ch === '/' && next === '*') { out += ch + next; i++; inBlockComment = true; continue; }
      if (ch === '"' || ch === "'") { quote = ch; out += ch; atStatementStart = false; continue; }
      if (ch === '`') { inTemplate = true; out += ch; atStatementStart = false; continue; }

      if (ch === '{' || ch === '(' || ch === '[') { depth++; out += ch; atStatementStart = false; continue; }
      if (ch === '}' || ch === ')' || ch === ']') {
        depth--;
        out += ch;
        // A closing `}` at top level ends a block, after which a new statement
        // may begin (`function f() {...} f()`). Without this, a top-level `var`
        // following a block was never hoisted, so it did not survive the call.
        atStatementStart = ch === '}' && depth === 0;
        continue;
      }

      if (ch === ';' || ch === '\n') {
        out += ch;
        atStatementStart = depth === 0;
        continue;
      }
      if (/\s/.test(ch)) { out += ch; continue; }

      // A top-level statement beginning with `var` — rewrite the declaration.
      if (depth === 0 && atStatementStart && code.startsWith('var', i) &&
          !/[\w$]/.test(code[i - 1] || '') && !/[\w$]/.test(code[i + 3] || '')) {
        const rest = code.slice(i + 3);
        const m = rest.match(/^(\s+)([A-Za-z_$][\w$]*)\s*=/);
        if (m) {
          out += `globalThis.${m[2]} =`;
          i += 3 + m[0].length - 1;
          atStatementStart = false;
          continue;
        }
        // `var x;` with no initialiser: declare it on the global object so it
        // exists for later calls.
        const bare = rest.match(/^(\s+)([A-Za-z_$][\w$]*)\s*(?=[;\n]|$)/);
        if (bare) {
          out += `globalThis.${bare[2]}`;
          i += 3 + bare[0].length - 1;
          atStatementStart = false;
          continue;
        }
      }

      atStatementStart = false;
      out += ch;
    }
    return out;
  }

  /**
   * Report syntax errors at parse time so the model gets a clear message rather
   * than an opaque runtime failure.
   *
   * The check compiles as an async function, not a plain one: top-level `await`
   * is supported here, so validating with `new Function` would reject valid code
   * with a confusing "await is only valid in async functions" error.
   */
  _checkSyntax(code) {
    try {
      const AsyncFunction = (async function () {}).constructor;
      // eslint-disable-next-line no-new
      new AsyncFunction('__cuaReturn', code);
      return null;
    } catch (err) {
      return err;
    }
  }

  /**
   * Best-effort candidate for the code's final expression.
   *
   * This deliberately does not try to be a parser. It only slices off the text
   * after the last top-level statement separator; `new AsyncFunction` then does
   * the actual validation in `evaluate`, and a candidate that does not compile
   * is simply discarded. A wrong guess therefore costs nothing but a failed
   * compile — it can never change what the code does.
   */
  _tailExpressionCandidate(code) {
    const trimmed = code.replace(/\s+$/, '');
    if (!trimmed) return null;

    let depth = 0;
    let start = 0;
    let quote = null;
    let inTemplate = false;
    const topLevelSemicolons = [];

    for (let i = 0; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (quote) {
        if (ch === '\\') { i++; continue; }
        if (ch === quote) quote = null;
        continue;
      }
      if (inTemplate) {
        if (ch === '\\') { i++; continue; }
        if (ch === '`') inTemplate = false;
        continue;
      }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (ch === '`') { inTemplate = true; continue; }
      if (ch === '(' || ch === '[' || ch === '{') { depth++; continue; }
      if (ch === ')' || ch === ']' || ch === '}') {
        depth--;
        // A `}` that closes a top-level block ends a statement, so an expression
        // may follow it on the same line — `function f(){...} f()`,
        // `if (x) {...} y`. Treating that as one expression made the wrapper
        // `return (function f(){...} f())` fail to compile, and the completion
        // value was lost. A `}` inside brackets (`({k:1})`) does not qualify,
        // because depth is still above zero there.
        if (ch === '}' && depth === 0) start = i + 1;
        continue;
      }

      // A semicolon splits statements only at depth 0. Recording them lets the
      // guard below detect that the slice after the last split still contains a
      // separator — which is what happens for `function f(){...} f()`, where the
      // only semicolons are inside the braces.
      if (ch === ';') {
        if (depth === 0) { start = i + 1; topLevelSemicolons.push(i); }
        continue;
      }
      if (depth > 0) continue;
      // A newline only separates statements when it is a genuine statement
      // terminator. It is not one when the previous line ends with an operator
      // (`a +\n b`) or the next line continues the expression (`.method()`,
      // `)`, `,`). Getting this wrong truncates the tail and silently loses the
      // completion value, so both directions are checked.
      if (ch === '\n') {
        const before = trimmed.slice(0, i).replace(/\s+$/, '');
        const after = trimmed.slice(i + 1).match(/^\s*(\S)/);
        const prevChar = before.slice(-1);
        const continuesLeft = prevChar !== '' && /[+\-*/%&|^<>=,.(:[?!~]/.test(prevChar);
        const continuesRight = after ? /^[.+\-*/%&|?<>=),:\]]/.test(after[1]) : false;
        if (!continuesLeft && !continuesRight) start = i + 1;
      }
    }

    let tail = trimmed.slice(start).trim().replace(/;\s*$/, '').trim();
    if (!tail) return null;
    // A trailing operator means the expression is unfinished (likely a syntax
    // error the caller should see), so do not claim it as an expression.
    if (/[+\-*/%&|^<>=,.]$/.test(tail)) return null;

    // The candidate must be ONE expression. If a top-level semicolon sits inside
    // it, the scanner failed to find the statement boundary — `function f(){...}`
    // with no separator before `f()` is the case that matters — and returning it
    // produced `return (function f(){...} f());`, which does not compile, losing
    // the completion value. Braces alone are fine: `(() => 3)()` and
    // `function f(){...} f()` both contain them.
    // If a top-level semicolon sits inside `tail`, the boundary was missed and
    // the candidate spans statements; decline rather than emit source that will
    // not compile.
    if (topLevelSemicolons.some((pos) => pos >= start)) return null;

    return tail;
  }

/**
   * Evaluate code, returning the captured output, the completion value, images
   * and a reset recommendation.
   *
   * The completion value — the value of the code's final expression — is
   * produced with a two-pass compile rather than by pattern-matching the source:
   *
   *   1. Compile the code as an async function body, appending
   *      `return (...last-expression...)`. This works whenever the tail is an
   *      expression, which is the common case.
   *   2. If that fails to compile, the tail is a declaration or a statement.
   *      Compile the code unchanged; a plain async body accepts it and produces
   *      no completion value, matching REPL behaviour.
   *
   * Letting the JavaScript parser decide removes a whole class of subtle bugs:
   * no hand-written scanner has to understand regex literals, template
   * interpolation, ASI edge cases, or object literals in tail position.
   */
  async evaluate(code) {
    if (typeof code !== 'string' || code.trim() === '') {
      return { ok: false, error: 'The `code` parameter must be a non-empty string of JavaScript.' };
    }

    this.captured = [];
    this.emittedImages = [];

    const hoisted = this._hoistVars(code);
    const syntaxError = this._checkSyntax(hoisted);
    if (syntaxError) {
      return { ok: false, error: `SyntaxError: ${syntaxError.message}`, phase: 'parse' };
    }

    // The function must be constructed *inside* the persistent context, so that
    // `sky`, `nodeRepl` and every variable declared by earlier calls resolve
    // against that context's global object rather than the host realm.
    //
    // The body is assembled by string concatenation rather than a template
    // literal on purpose: the code being compiled routinely contains backticks
    // and `${...}`, and interpolating it into a template would corrupt both.
    let fn = null;
    let executionError = null;

    const build = (expressionMode) => {
      // `await` on the IIFE matters: without it the outer async function
      // resolves to the inner Promise object rather than its value, and every
      // call would report a Promise instead of a result.
      const body = expressionMode
        ? `return await (async () => {\n${hoisted}\nreturn (${expressionMode});\n})();`
        : hoisted;
      return new this.AsyncFunction('__cuaReturn', body);
    };

    // Pass 1: treat the tail as an expression and return its value.
    const tail = this._tailExpressionCandidate(hoisted);
    if (tail) {
      try {
        fn = build(tail);
      } catch {
        fn = null;
      }
    }

    // Pass 2: run the code as-is, producing no completion value.
    if (fn === null) {
      try {
        fn = build(null);
      } catch (err) {
        return { ok: false, error: `SyntaxError: ${err.message}`, phase: 'parse' };
      }
    }

    let completion;
    try {
      completion = await fn(undefined);
    } catch (err) {
      executionError = err;
    }

    if (executionError) {
      return {
        ok: false,
        error: `${executionError && executionError.name ? executionError.name : 'Error'}: ` +
               `${executionError && executionError.message ? executionError.message : String(executionError)}`,
        phase: 'execute',
        output: this.captured.join('\n'),
      };
    }

    // Surface the completion value, which is how `await sky.get_app_state(...)`
    // on the last line reaches the model.
    let completionText = '';
    if (completion !== undefined) {
      if (typeof completion === 'string') {
        completionText = completion;
      } else {
        try {
          completionText = JSON.stringify(completion, null, 2);
        } catch {
          completionText = String(completion);
        }
      }
    }

    let output = this.captured.join('\n');
    if (completionText) {
      output = output ? `${output}\n${completionText}` : completionText;
    }
    if (output.length > MAX_CAPTURED_CHARS) {
      output = output.slice(0, MAX_CAPTURED_CHARS) +
        `\n… output truncated at ${MAX_CAPTURED_CHARS} characters`;
    }

    return {
      ok: true,
      output,
      images: this.emittedImages.slice(),
      blank: output.trim() === '' && this.emittedImages.length === 0,
    };
  }

  /**
   * Set the approval gate for the upcoming evaluation.
   * @param {boolean} enabled  Whether write actions require approval.
   * @param {boolean} approved Whether the current call has been approved.
   */
  setApprovalGate(enabled, approved) {
    this._approveGateEnabled = !!enabled;
    this._approveGatePassed = !!approved;
  }

  /** Discard all state and rebuild a clean context. */
  reset() {
    this._buildContext();
    this.resetCount += 1;
    // The rebuilt context already carries the gated `sky`; nothing to re-inject.
    return { resetCount: this.resetCount };
  }
}

module.exports = { PersistentRepl, sky, preflight, isTrusted };