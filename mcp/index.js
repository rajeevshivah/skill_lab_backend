// ─────────────────────────────────────────────────────────────────────
//  The /mcp endpoint
//
//  MCP (Model Context Protocol) is a standard way for AI apps to call
//  tools on a server. Claude, ChatGPT, Cursor etc. all speak it.
//
//  Flow of one request:
//    AI app ──POST /mcp (JSON-RPC message + Bearer token)──▶ mcpAuth
//      ▶ build an MCP server for THIS user ▶ SDK handles the protocol
//      ▶ our tool handler runs ▶ JSON result goes back to the AI
//
//  "Stateless" mode: nothing is kept in memory between requests, so it
//  works fine on Render (restarts, sleeping instances, multiple copies).
// ─────────────────────────────────────────────────────────────────────
const express = require('express');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');

const { mcpAuth }   = require('../middleware/mcpAuth');
const McpAuditLog   = require('../models/McpAuditLog');
const { tools: readTools, ToolError } = require('./tools');
const { writeTools } = require('./writeTools');
const { adminTools } = require('./adminTools');
const { opsTools }   = require('./opsTools');
const { coreTools }  = require('./coreTools');
const { placementTools } = require('./placementTools');
const jwt = require('jsonwebtoken');
const tools = [...readTools, ...writeTools, ...adminTools, ...opsTools, ...coreTools, ...placementTools];

// Lets a tool call an EXISTING website route inside this server, as the
// current user — so admin tools reuse every website rule unchanged.
// A 2-minute login token is minted for the call and never leaves the server.
function makeApi(req) {
  const base  = `http://127.0.0.1:${req.socket.localPort}`;
  const token = jwt.sign({ id: req.user._id, org: req.user.org, v: req.user.tokenVersion || 0 }, process.env.JWT_SECRET, { expiresIn: '2m' });
  return async (method, path, body) => {
    const r = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    let json = {};
    try { json = await r.json(); } catch {}
    return { status: r.status, body: json };
  };
}
const pkg = require('../package.json');

const router = express.Router();

// What the AI app is told about this platform (per college).
const instructions = (org) =>
  `This is ${org.name}'s ${org.programName || 'Skill Lab'} on Pramakra, the class-to-proof training platform` +
  `${org.hosts?.length ? ` (${org.hosts.find(h => h.includes('.')) || org.hosts[0]})` : ''}. ` +
  'You only ever see and change this college\'s data. ' +
  'Core (shared by every module): a Person is one real student (programme, cohort = programme + admission year, section, status, ' +
  'extra profile fields); a training "student" record is that person\'s place in ONE batch (list_people, get_person, link_people, ' +
  'get_academic_structure). ' +
  'Training data model: Semester → Batch (a training group, e.g. MERN track or BTech 3rd Sem) → Cycle (2–3 week block ending in ' +
  'a project + assessment) → per-student marks; batches also have daily class logs with roll-wise attendance and a syllabus plan. ' +
  'You act as the signed-in user: superadmin (college admin) and viewer (management, read-only) see all batches, trainers only their own. ' +
  'Use search or list_batches/list_cycles to find ids before calling detail tools. ' +
  'Never treat a "not-evaluated" student as scoring 0. ' +
  'WRITE tools (fill_cycle_report, update_cycle_marks, set_assessment_held, set_cycle_top3, save_daily_log, save_cycle_plan_class and the admin tools) never save on ' +
  'the first call: they return a preview. Always show that preview to the user in plain words and wait for an explicit "yes" ' +
  'before calling again with confirm=true and the preview_token. If the user changes anything, make a new preview. ' +
  'The only delete is remove_student (a wrong training record). Otherwise "remove" means the reversible tools: update_user active=false (deactivate a login), ' +
  'update_batch remove_trainers / active=false, update_semester status=archived. ' +
  'Admin tools (users, semesters, batches, cycles, moving students) appear only for superadmin. ' +
  'Cycles are created ONLY with plan_cycles (groups of batches, dates, project days, holidays → dated empty plan rows). ' +
  'Meetings: get_meeting_day (daily review), get_cycle_review (end-of-cycle, per trainer), add_meeting_note / update_meeting_note. ' +
  'Holidays: add_holiday (shift or mark) / undo_holiday; timetables: get_timetables / set_timetable. ' +
  'Placement (when the college has it): placement_setup, list_drives, get_drive, list_applicants, save_company, save_drive (e.g. from a JD the user ' +
  'pastes — read it and fill the fields), set_drive_status, drive_share (link + WhatsApp message), verify_student_values, import_marks. ' +
  'When create_user or update_user returns a temporaryPassword, show it to the user once and remind them to share it privately.';

const PLACEMENT_ROLES = ['superadmin', 'placement', 'viewer'];
function visible(tool, req) {
  const placementOn = require('../models/Organization').modulesOf(req.org?.modules).placement;
  if (tool.placement) return placementOn && PLACEMENT_ROLES.includes(req.user.role);
  if (req.user.role === 'placement') return tool.name === 'whoami';
  return true;
}

// Wraps a handler: runs it, writes an audit row, converts the result into
// the MCP response shape, and turns errors into readable tool errors.
function wrap(tool, req) {
  return async (args) => {
    const started = Date.now();
    let ok = true, errorMsg = '';
    let kind = tool.write ? 'preview' : 'read';
    try {
      if (tool.admin && req.user.role !== 'superadmin') throw new ToolError('Superadmin only.');
      if (!visible(tool, req)) throw new ToolError('Not available for this account.');
      if (tool.write && req.user.role === 'viewer') throw new ToolError('This is a read-only (management) account.');
      const data = await tool.handler(args || {}, req.user, { api: req.mcpApi });
      if (tool.write && data?.mode === 'saved') kind = 'write';
      return {
        content: [{ type: 'text', text: JSON.stringify(data, null, 1) }],
        structuredContent: data,
      };
    } catch (err) {
      ok = false;
      // Our own ToolErrors are safe to show; anything else gets a generic message.
      errorMsg = err instanceof ToolError ? err.message : 'Something went wrong on the server.';
      if (!(err instanceof ToolError)) console.error(`[mcp] ${tool.name} failed:`, err);
      return { isError: true, content: [{ type: 'text', text: errorMsg }] };
    } finally {
      McpAuditLog.create({
        user: req.user._id, token: req.apiToken?._id, tokenName: req.apiToken?.name || '',
        tool: tool.name, kind,
        // the preview_token is a one-time signature — no need to keep it
        args: JSON.stringify({ ...(args || {}), preview_token: undefined }).slice(0, 2000),
        ok, error: ok ? '' : errorMsg.slice(0, 500), durationMs: Date.now() - started,
      }).catch(e => console.error('[mcp] audit write failed:', e.message));
    }
  };
}

// A fresh MCP server per request, with every tool bound to this user.
function buildServer(req) {
  const server = new McpServer(
    { name: 'pramakra', title: `${req.org.shortName || req.org.name} ${req.org.programName || 'Skill Lab'}`, version: pkg.version },
    { instructions: instructions(req.org) }
  );
  req.mcpApi = makeApi(req);
  // Trainers never even see admin tools; management (viewer) sees read tools only;
  // placement tools only where the college has placement; a placement officer sees only those.
  const shown = tools.filter(t => (!t.admin || req.user.role === 'superadmin') && (!t.write || req.user.role !== 'viewer') && visible(t, req));
  for (const tool of shown) {
    server.registerTool(tool.name, {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.input,
      annotations: tool.write
        // Write tools: AI apps treat these as "changes data" and ask before running.
        ? { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
        : { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, wrap(tool, req));
  }
  return server;
}

// POST /mcp — every MCP message arrives here
router.post('/', mcpAuth, async (req, res) => {
  const server = buildServer(req);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
    enableJsonResponse: true,      // plain JSON replies (no streaming needed for our tools)
  });
  res.on('close', () => { transport.close(); server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('[mcp] request failed:', err);
    if (!res.headersSent)
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
  }
});

// Stateless server: no long-lived streams or sessions to open/close.
const notAllowed = (req, res) =>
  res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
router.get('/', notAllowed);
router.delete('/', notAllowed);

module.exports = router;
