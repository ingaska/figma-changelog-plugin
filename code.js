figma.showUI(__html__, { width: 620, height: 580, title: 'Changelog Generator' });

figma.ui.onmessage = (msg) => {
  if (msg.type === 'generate') {
    try {
      const { text, html } = generateChangelog(msg.library);
      figma.ui.postMessage({ type: 'result', text, html });
    } catch (e) {
      figma.ui.postMessage({ type: 'error', message: e.message });
    }
  } else if (msg.type === 'close') {
    figma.closePlugin();
  }
};

// ─── Node helpers ─────────────────────────────────────────────────────────────

// Find the first direct child with a given name
function childByName(node, name) {
  if (!('children' in node)) return null;
  return node.children.find(c => c.name === name) || null;
}

// Find the first descendant (any depth) with a given name
function descendantByName(node, name) {
  if (node.name === name) return node;
  if ('children' in node) {
    for (const c of node.children) {
      const found = descendantByName(c, name);
      if (found) return found;
    }
  }
  return null;
}

// Find all descendant INSTANCE nodes named "Task"
function findTaskInstances(node) {
  const results = [];
  function walk(n) {
    if (n.type === 'INSTANCE' && n.name === 'Task') {
      results.push(n);
      return; // don't recurse inside a task
    }
    if ('children' in n) n.children.forEach(walk);
  }
  walk(node);
  return results;
}

// Find all TEXT nodes matching a name predicate, recursively
function findAllTextNodes(node) {
  const results = [];
  function walk(n) {
    if (n.type === 'TEXT') results.push(n);
    if ('children' in n) n.children.forEach(walk);
  }
  walk(node);
  return results;
}

// Safely read text from a TEXT node by searching for a named descendant
function getText(node, layerName) {
  const found = descendantByName(node, layerName);
  if (!found || found.type !== 'TEXT') return '';
  return (found.characters || '').trim();
}

// Read the hyperlink URL from a TEXT node
// The URL lives on the node's style-level hyperlink (whole-text link)
function getUrl(node, layerName) {
  const found = descendantByName(node, layerName);
  if (!found || found.type !== 'TEXT') return '';
  try {
    // Try .hyperlink first (set when the entire text has one link)
    const h = found.hyperlink;
    if (h && h.type === 'URL') return h.value;
  } catch (_) {}
  try {
    // Fallback: getRangeHyperlink over the whole string
    const len = (found.characters || '').length;
    if (len > 0) {
      const h = found.getRangeHyperlink(0, len);
      if (h && h.type === 'URL') return h.value;
    }
  } catch (_) {}
  return '';
}

// ─── Task extraction ──────────────────────────────────────────────────────────

function extractTasks(sectionFrame) {
  const instances = findTaskInstances(sectionFrame);
  const tasks = [];

  for (const inst of instances) {
    const title       = getText(inst, 'Task Name');
    const description = getText(inst, 'Description');
    const jiraUrl     = getUrl(inst, 'JiraLink');
    const figmaUrl    = getUrl(inst, 'FigmaLink');

    if (!title) continue;
    tasks.push({ title, description, jiraUrl, figmaUrl });
  }

  return tasks;
}

// ─── Date formatting ──────────────────────────────────────────────────────────

const MONTHS = {
  january:'Jan', february:'Feb', march:'Mar', april:'Apr',
  may:'May', june:'Jun', july:'Jul', august:'Aug',
  september:'Sep', october:'Oct', november:'Nov', december:'Dec',
};
const MONTH_NUMS = {
  january:'01', february:'02', march:'03', april:'04',
  may:'05', june:'06', july:'07', august:'08',
  september:'09', october:'10', november:'11', december:'12',
};

function parseDateText(raw) {
  const s = (raw || '').trim();
  const m = s.match(/(\d{1,2})\s+(\w+)\s+(\d{4})/i)
         || s.match(/(\w+)\s+(\d{1,2}),?\s+(\d{4})/i);
  if (!m) return { headerDate: s, bodyDate: s };

  let day, monthName, year;
  if (/^\d/.test(m[0])) { [, day, monthName, year] = m; }
  else                   { [, monthName, day, year] = m; }

  const key   = monthName.toLowerCase();
  const short = MONTHS[key]      || monthName.slice(0, 3);
  const num   = MONTH_NUMS[key]  || '??';
  const d     = day.padStart(2, '0');

  return {
    headerDate: `${d}.${num}.${year}`,    // 05.03.2026
    bodyDate:   `${d} ${short}, ${year}`, // 05 Mar, 2026
  };
}

// ─── Changelog formatting ─────────────────────────────────────────────────────

function esc(str) {
  return (str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Plain text version (for copying)
function taskToText(task) {
  const jira  = task.jiraUrl  ? `🗂️ JIRA`  : '🗂️ JIRA';
  const figma = task.figmaUrl ? `🧩 Figma` : '🧩 Figma';
  return `${task.title}\n${task.description}\n${jira}   ${figma}`;
}

// HTML version (for display with clickable links)
function taskToHtml(task) {
  const jira  = task.jiraUrl
    ? `<a href="${esc(task.jiraUrl)}" target="_blank">🗂️ JIRA</a>`
    : `<span>🗂️ JIRA</span>`;
  const figma = task.figmaUrl
    ? `<a href="${esc(task.figmaUrl)}" target="_blank">🧩 Figma</a>`
    : `<span>🧩 Figma</span>`;
  return `<div class="task">
    <div class="task-title">${esc(task.title)}</div>
    <div class="task-desc">${esc(task.description)}</div>
    <div class="task-links">${jira}&nbsp;&nbsp;&nbsp;${figma}</div>
  </div>`;
}

function formatChangelog(version, rawDate, library, majorTasks, minorTasks) {
  const { headerDate, bodyDate } = parseDateText(rawDate);
  const lib = (library || '').trim() || 'UFC';

  // ── Plain text (copy) ────────────────────────────────────────────────────
  let text = `Stable Update! ${lib} {Library} Stable ${version} (${headerDate})\n`;
  text    += `Release Date:  ${bodyDate}\n`;

  if (majorTasks.length > 0) {
    text += `\n\n🔥 Major Updates:\n\n\n`;
    text += majorTasks.map(taskToText).join('\n\n________________________________________________\n\n\n');
    text += '\n\n________________________________________________\n';
  }
  if (minorTasks.length > 0) {
    text += `\n\n💅 Minor Changes:\n\n\n`;
    text += minorTasks.map(taskToText).join('\n\n\n');
  }

  // ── HTML (display) ───────────────────────────────────────────────────────
  const divider = `<div class="divider">________________________________________________</div>`;

  let html = `<div class="header">
    <div class="release-title">Stable Update! ${esc(lib)} &#123;Library&#125; Stable ${esc(version)} (${esc(headerDate)})</div>
    <div class="release-date">Release Date: ${esc(bodyDate)}</div>
  </div>`;

  if (majorTasks.length > 0) {
    html += `<div class="section-title">🔥 Major Updates:</div>`;
    html += majorTasks.map(taskToHtml).join(divider);
    html += divider;
  }
  if (minorTasks.length > 0) {
    html += `<div class="section-title">💅 Minor Changes:</div>`;
    html += minorTasks.map(taskToHtml).join('');
  }

  return { text, html };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function generateChangelog(library) {
  const selection = figma.currentPage.selection;
  if (selection.length === 0) {
    throw new Error('Please select a release frame (e.g. "3.4.0") first.');
  }

  const root    = selection[0];
  const version = root.name;

  // ── Date ──────────────────────────────────────────────────────────────────
  let rawDate = '';
  const titleFrame = descendantByName(root, 'Title');
  if (titleFrame) {
    for (const t of findAllTextNodes(titleFrame)) {
      const c = (t.characters || '').trim();
      // Match "5 march 2026" — has a month word, not a version number
      if (/\d{1,2}\s+[a-z]+\s+\d{4}/i.test(c) && !/\d+\.\d+\.\d+/.test(c)) {
        rawDate = c;
        break;
      }
    }
  }
  if (!rawDate) rawDate = new Date().toLocaleDateString('en-GB', { day:'numeric', month:'long', year:'numeric' });

  // ── Tasks ─────────────────────────────────────────────────────────────────
  const majorFrame = descendantByName(root, 'Major');
  const minorFrame = descendantByName(root, 'Minor');

  const majorTasks = majorFrame ? extractTasks(majorFrame) : [];
  const minorTasks = minorFrame ? extractTasks(minorFrame) : [];

  // ── Debug info if nothing found ───────────────────────────────────────────
  if (majorTasks.length === 0 && minorTasks.length === 0) {
    const rootChildren = 'children' in root
      ? root.children.map(c => `"${c.name}"(${c.type})`).join(', ')
      : 'none';
    const majorInstances = majorFrame ? findTaskInstances(majorFrame).length : 0;
    const minorInstances = minorFrame ? findTaskInstances(minorFrame).length : 0;
    throw new Error(
      `No tasks found.\n\n` +
      `Frame: "${root.name}" children: ${rootChildren}\n` +
      `"Major" frame: ${majorFrame ? 'found' : 'NOT FOUND'} — ${majorInstances} Task instance(s)\n` +
      `"Minor" frame: ${minorFrame ? 'found' : 'NOT FOUND'} — ${minorInstances} Task instance(s)`
    );
  }

  const { text, html } = formatChangelog(version, rawDate, library, majorTasks, minorTasks);
  return { text, html };
}
