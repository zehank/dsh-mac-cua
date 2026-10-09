'use strict';

/**
 * dsh-mac-cua — Computer Use approval gate.
 *
 * This component exists only so Settings shows an enable/disable switch for it
 * (插件 -> cua -> 组件 -> 开关). That switch state IS the computer-use
 * confirmation gate: the MCP server (a separate component) reads this entry's
 * `disabled` flag from the profile patch and turns the gate on/off accordingly.
 *
 * The card title in Settings comes from ../locale/{en,zh}.json, which is only
 * read because the bundle patch references this file by its bare package
 * subpath (`dsh-mac-cua/lib/approval-gate.js`) rather than a relative path —
 * relative entries show the raw file URL instead.
 *
 * Do NOT add a Config field here — a `.volatile()` field would render a second,
 * confusing switch that competes with the enable/disable toggle.
 */

const { Service } = require('@deepseek-ai/cordis');

class CuaApprovalGateService extends Service {
  constructor(ctx) {
    super(ctx, 'cuaApprovalGate');
  }
}

module.exports = CuaApprovalGateService;
