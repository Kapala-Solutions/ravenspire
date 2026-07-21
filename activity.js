// activity.js — turn a raw tool event into a plain-English "what it's doing now".

// Humanize an MCP tool name like mcp__Claude_Browser__navigate -> "Browser: navigate"
function humanizeMcp(tool) {
  const parts = tool.split('__');
  const server = (parts[1] || '').replace(/_/g, ' ');
  const action = (parts[2] || '').replace(/_/g, ' ');
  if (server && action) return `${server}: ${action}`;
  return action || server || 'tool';
}

// tool + target -> phrase. `target` is a short summary the hook forwards
// (a file basename, a command snippet, a search pattern, a url, etc.).
function toolPhrase(tool, target) {
  const t = (tool || '').toLowerCase();
  const tgt = target ? ` ${target}` : '';
  if (tool && tool.startsWith('mcp__')) return humanizeMcp(tool);
  if (t === 'edit' || t === 'multiedit') return `Editing${tgt}`;
  if (t === 'write') return `Writing${tgt}`;
  if (t === 'read') return `Reading${tgt}`;
  if (t === 'notebookedit') return `Editing notebook${tgt}`;
  if (t === 'bash') return target ? `Running: ${target}` : 'Running a command';
  if (t === 'grep') return target ? `Searching for "${target}"` : 'Searching code';
  if (t === 'glob') return target ? `Finding ${target}` : 'Finding files';
  if (t === 'task' || t === 'agent') return 'Delegating to a subagent';
  if (t === 'webfetch') return target ? `Fetching ${target}` : 'Fetching a page';
  if (t === 'websearch') return target ? `Web search: ${target}` : 'Searching the web';
  if (t === 'todowrite') return 'Updating its plan';
  if (!tool) return 'Working';
  return `${tool}${tgt}`;
}

// Compose the activity line from state + last tool.
function describeActivity({ state, tool, target, hookEvent }) {
  const e = (hookEvent || '').toLowerCase();
  if (state === 'ended') return 'Session ended';
  if (state === 'waiting' || e.includes('notification')) return 'Waiting for your input';
  if (state === 'idle' || e === 'stop') return 'Waiting for you';
  if (e.includes('sessionstart')) return 'Starting up';
  if (e.includes('userpromptsubmit')) return 'Reading your message';
  // working: describe by the last tool used
  const isTool = e.includes('tooluse') || tool;
  if (isTool && tool) return toolPhrase(tool, target);
  return 'Thinking';
}

module.exports = { describeActivity, toolPhrase };
