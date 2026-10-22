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
const { tools, ToolError } = require('./tools');
const pkg = require('../package.json');

const router = express.Router();

const INSTRUCTIONS =
  'This is the SHEAT College Skill Lab platform (skilllab.sheat.ac.in). ' +
  'Data model: Semester → Batch (a training group, e.g. MERN track or BTech 3rd Sem) → Cycle (2–3 week block ending in ' +
  'a project + assessment) → per-student marks; batches also have daily class logs with roll-wise attendance and a syllabus plan. ' +
  'You act as the signed-in user: superadmin sees all batches, trainers only their own. ' +
  'All tools are read-only. Use search or list_batches/list_cycles to find ids before calling detail tools. ' +
  'Never treat a "not-evaluated" student as scoring 0.';

// Wraps a handler: runs it, writes an audit row, converts the result into
// the MCP response shape, and turns errors into readable tool errors.
function wrap(tool, req) {
  return async (args) => {
    const started = Date.now();
    let ok = true, errorMsg = '';
    try {
      const data = await tool.handler(args || {}, req.user);
      return {
        content: [{ type: 'text', text: JSON.stringify(data, null, 1) }],
        structuredContent: data,
      };
    } catch (err) {
      ok = false;
      // Our own ToolErrors are safe to show; anything else gets a generic message.
      errorMsg = err instanceof ToolError ? err.message : 'Something went wrong on the Skill Lab server.';
      if (!(err instanceof ToolError)) console.error(`[mcp] ${tool.name} failed:`, err);
      return { isError: true, content: [{ type: 'text', text: errorMsg }] };
    } finally {
      McpAuditLog.create({
        user: req.user._id, token: req.apiToken?._id, tokenName: req.apiToken?.name || '',
        tool: tool.name, args: JSON.stringify(args || {}).slice(0, 2000),
        ok, error: ok ? '' : errorMsg.slice(0, 500), durationMs: Date.now() - started,
      }).catch(e => console.error('[mcp] audit write failed:', e.message));
    }
  };
}

// A fresh MCP server per request, with every tool bound to this user.
function buildServer(req) {
  const server = new McpServer(
    { name: 'skilllab-sheat', title: 'SHEAT Skill Lab', version: pkg.version },
    { instructions: INSTRUCTIONS }
  );
  for (const tool of tools) {
    server.registerTool(tool.name, {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.input,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
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
