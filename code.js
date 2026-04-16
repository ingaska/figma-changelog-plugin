figma.showUI(__html__, { width: 620, height: 600, title: 'Changelog Generator' });

figma.ui.onmessage = (msg) => {
  if (msg.type === 'generate') {
    try {
      const { text, html } = generateChangelog(msg.library);
      figma.ui.postMessage({ type: 'result', text, html });
    } catch (e) {
      figma.ui.postMessage({ type: 'error', message: e.message });
    }

  } else if (msg.type === 'generate-template') {
    generateTemplate(msg.majorCount, msg.minorCount)
      .then(() => figma.ui.postMessage({ type: 'template-done' }))
      .catch(function(e) {
        var msg = (e && e.message) ? e.message : (e ? String(e) : 'Unknown error');
        console.error('[Changelog] Template error:', e);
        figma.ui.postMessage({ type: 'error', message: msg });
      });

  } else if (msg.type === 'goto-node') {
    try {
      var target = figma.getNodeById(msg.nodeId);
      if (target) {
        var ancestor = target;
        while (ancestor && ancestor.type !== 'PAGE') ancestor = ancestor.parent;
        if (ancestor && ancestor.type === 'PAGE' && ancestor !== figma.currentPage) {
          figma.currentPage = ancestor;
        }
        figma.currentPage.selection = [target];
        figma.viewport.scrollAndZoomIntoView([target]);
      }
    } catch (_) {}

  } else if (msg.type === 'open-url') {
    try { figma.openExternal(msg.url); } catch (_) {}

  } else if (msg.type === 'close') {
    figma.closePlugin();
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// READ HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

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

// Accept both original INSTANCE tasks and template-generated FRAME tasks
function findTaskNodes(node) {
  const results = [];
  function walk(n) {
    if (n.name === 'Task' && (n.type === 'INSTANCE' || n.type === 'FRAME' || n.type === 'COMPONENT')) {
      results.push(n);
      return;
    }
    if ('children' in n) n.children.forEach(walk);
  }
  walk(node);
  return results;
}

function findAllTextNodes(node) {
  const results = [];
  function walk(n) {
    if (n.type === 'TEXT') results.push(n);
    if ('children' in n) n.children.forEach(walk);
  }
  walk(node);
  return results;
}

function getText(node, layerName) {
  const found = descendantByName(node, layerName);
  if (!found || found.type !== 'TEXT') return '';
  return (found.characters || '').trim();
}

// Convert a HyperlinkTarget to a URL string.
// URL type  → value as-is.
// NODE type → figma.com URL when fileKey is available; null otherwise.
function hyperlinkToUrl(h) {
  if (!h) return null;
  if (h.type === 'URL') return h.value;
  if (h.type === 'NODE') {
    var fileKey = figma.fileKey;
    if (!fileKey) return null;
    // Plugin API uses "142:75"; Figma URLs use "142-75"
    var nodeId = (h.value || '').replace(/:/g, '-');
    return 'https://www.figma.com/design/' + fileKey + '/' +
           encodeURIComponent(figma.root.name) + '?node-id=' + nodeId;
  }
  return null;
}

// Extract the raw node ID from a NODE-type HyperlinkTarget ('' otherwise).
// Used as fallback when figma.fileKey is unavailable (local plugin dev mode).
function hyperlinkNodeId(h) {
  return (h && h.type === 'NODE') ? (h.value || '') : '';
}

// Return the first HyperlinkTarget found on a text node, scanning
// char-by-char so a non-linked space never causes figma.mixed to hide the link.
function getFirstHyperlink(textNode) {
  try {
    var h = textNode.hyperlink;
    if (h && h.type) return h;
  } catch (_) {}
  var len = (textNode.characters || '').length;
  for (var i = 0; i < len; i++) {
    try {
      var h = textNode.getRangeHyperlink(i, i + 1);
      if (h && h.type) return h;
    } catch (_) {}
  }
  return null;
}

function getUrl(node, layerName) {
  const found = descendantByName(node, layerName);
  if (!found || found.type !== 'TEXT') return '';
  // 1. Figma hyperlink (set via "Add link" on the text layer)
  var h = getFirstHyperlink(found);
  if (h) return hyperlinkToUrl(h) || '';
  // 2. Text content is itself a URL (designer typed it directly)
  var text = (found.characters || '').trim();
  if (/^https?:\/\//.test(text)) return text;
  return '';
}

// Return the Figma node ID from a NODE-type hyperlink on a text layer.
// Returns '' when the link is a plain URL or when there is no hyperlink.
function getNodeId(node, layerName) {
  const found = descendantByName(node, layerName);
  if (!found || found.type !== 'TEXT') return '';
  var h = getFirstHyperlink(found);
  return h ? (hyperlinkNodeId(h) || '') : '';
}

// Walk a TEXT node character-by-character and return an HTML string where
// any Figma-hyperlinked ranges become <a> tags, and bare URLs in plain
// segments are also linkified.
function getDescriptionHtml(node, layerName) {
  const found = descendantByName(node, layerName);
  if (!found || found.type !== 'TEXT') return '';
  const chars = found.characters || '';
  if (!chars) return '';

  // Build [{text, url, nodeId}] segments grouping consecutive chars with same hyperlink
  const segments = [];
  var i = 0;
  while (i < chars.length) {
    var currentUrl = null;
    var currentNodeId = '';
    try {
      var h = found.getRangeHyperlink(i, i + 1);
      currentUrl    = hyperlinkToUrl(h);
      currentNodeId = currentUrl ? '' : hyperlinkNodeId(h);
    } catch (_) {}

    var j = i + 1;
    while (j < chars.length) {
      var nextUrl = null;
      var nextNodeId = '';
      try {
        var hj = found.getRangeHyperlink(j, j + 1);
        nextUrl    = hyperlinkToUrl(hj);
        nextNodeId = nextUrl ? '' : hyperlinkNodeId(hj);
      } catch (_) {}
      if (nextUrl !== currentUrl || nextNodeId !== currentNodeId) break;
      j++;
    }

    segments.push({ text: chars.slice(i, j), url: currentUrl, nodeId: currentNodeId });
    i = j;
  }

  // Render segments to HTML
  return segments.map(function(seg) {
    var inner = esc(seg.text).replace(/\n/g, '<br>');
    if (seg.url) {
      return '<a href="' + esc(seg.url) + '" target="_blank">' + inner + '</a>';
    }
    if (seg.nodeId) {
      // NODE link without fileKey: navigate within Figma when clicked
      return '<a class="node-link" data-node-id="' + esc(seg.nodeId) + '">' + inner + '</a>';
    }
    return linkify(seg.text);
  }).join('');
}

// ═══════════════════════════════════════════════════════════════════════════════
// TASK EXTRACTION
// ═══════════════════════════════════════════════════════════════════════════════

// Plain-text version of a description: hyperlinked spans become "text (URL)".
function getDescriptionText(node, layerName) {
  const found = descendantByName(node, layerName);
  if (!found || found.type !== 'TEXT') return '';
  const chars = found.characters || '';
  if (!chars) return chars;
  const segments = [];
  var i = 0;
  while (i < chars.length) {
    var h = null;
    try { h = found.getRangeHyperlink(i, i + 1); if (h && !h.type) h = null; } catch (_) {}
    var j = i + 1;
    while (j < chars.length) {
      var hn = null;
      try { hn = found.getRangeHyperlink(j, j + 1); if (hn && !hn.type) hn = null; } catch (_) {}
      if ((h && hn && h.type === hn.type && h.value === hn.value) ||
          (!h && !hn)) { j++; } else { break; }
    }
    segments.push({ text: chars.slice(i, j), h });
    i = j;
  }
  return segments.map(function(seg) {
    if (!seg.h) return seg.text;
    var url = hyperlinkToUrl(seg.h);
    if (url) return seg.text + ' (' + url + ')';
    var nodeId = hyperlinkNodeId(seg.h);
    return nodeId ? seg.text + ' [figma node: ' + nodeId + ']' : seg.text;
  }).join('');
}

function extractTasks(sectionFrame) {
  const tasks = [];
  for (const node of findTaskNodes(sectionFrame)) {
    const title           = getText(node, 'Task Name');
    const description     = getText(node, 'Description');
    const descriptionText = getDescriptionText(node, 'Description');
    const descriptionHtml = getDescriptionHtml(node, 'Description');
    const jiraUrl         = getUrl(node, 'JiraLink');
    const figmaUrl        = getUrl(node, 'FigmaLink');
    // figmaNodeId: node ID for internal NODE links when figma.fileKey is unavailable
    const figmaNodeId     = figmaUrl ? '' : getNodeId(node, 'FigmaLink');
    if (!title) continue;
    tasks.push({ title, description, descriptionText, descriptionHtml, jiraUrl, figmaUrl, figmaNodeId });
  }
  return tasks;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DATE FORMATTING
// ═══════════════════════════════════════════════════════════════════════════════

const MONTHS     = { january:'Jan',february:'Feb',march:'Mar',april:'Apr',may:'May',june:'Jun',july:'Jul',august:'Aug',september:'Sep',october:'Oct',november:'Nov',december:'Dec' };
const MONTH_NUMS = { january:'01',february:'02',march:'03',april:'04',may:'05',june:'06',july:'07',august:'08',september:'09',october:'10',november:'11',december:'12' };

function parseDateText(raw) {
  const s = (raw || '').trim();
  const m = s.match(/(\d{1,2})\s+(\w+)\s+(\d{4})/i) || s.match(/(\w+)\s+(\d{1,2}),?\s+(\d{4})/i);
  if (!m) return { headerDate: s, bodyDate: s };
  let day, monthName, year;
  if (/^\d/.test(m[0])) { [, day, monthName, year] = m; }
  else                   { [, monthName, day, year] = m; }
  const key = monthName.toLowerCase();
  const d   = day.padStart(2, '0');
  return {
    headerDate: `${d}.${MONTH_NUMS[key] || '??'}.${year}`,
    bodyDate:   `${d} ${MONTHS[key] || monthName.slice(0,3)}, ${year}`,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHANGELOG FORMATTING
// ═══════════════════════════════════════════════════════════════════════════════

function esc(s) {
  return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// Escape HTML, then turn any bare https?:// URLs into clickable <a> tags.
// Newlines are preserved as <br> so multi-line descriptions render correctly.
function linkify(s) {
  var escaped = esc(s || '');
  // Replace URLs (already HTML-safe at this point — URLs don't contain &/</>)
  escaped = escaped.replace(/https?:\/\/[^\s<>"']+/g, function(url) {
    // Strip trailing punctuation that is unlikely to be part of the URL
    var trail = '';
    var m = url.match(/([.,;:!?)]+)$/);
    if (m) { trail = m[1]; url = url.slice(0, url.length - trail.length); }
    return '<a href="' + url + '" target="_blank">' + url + '</a>' + trail;
  });
  // Preserve line-breaks
  return escaped.replace(/\n/g, '<br>');
}

function taskToText(task) {
  const desc  = (task.descriptionText || task.description || '').trim();
  const jira  = task.jiraUrl  ? `🗂️ JIRA: ${task.jiraUrl.trim()}`   : '🗂️ JIRA';
  const figma = task.figmaUrl ? `🧩 Figma: ${task.figmaUrl.trim()}` : '🧩 Figma';
  return `${task.title}\n${desc}\n${jira}   ${figma}`;
}

function taskToHtml(task) {
  const jira = task.jiraUrl
    ? `<a href="${esc(task.jiraUrl)}" target="_blank">🗂️ JIRA</a>`
    : `<span>🗂️ JIRA</span>`;

  // figmaUrl → external link; figmaNodeId → navigate within Figma; neither → gray span
  const figmaLink = task.figmaUrl
    ? `<a href="${esc(task.figmaUrl)}" target="_blank">🧩 Figma</a>`
    : task.figmaNodeId
      ? `<a class="node-link" data-node-id="${esc(task.figmaNodeId)}">🧩 Figma</a>`
      : `<span>🧩 Figma</span>`;

  const descHtml = task.descriptionHtml || linkify(task.description);
  return `<div class="task">
    <div class="task-title">${esc(task.title)}</div>
    <div class="task-desc">${descHtml}</div>
    <div class="task-links">${jira}${figmaLink}</div>
  </div>`;
}

function formatChangelog(version, rawDate, library, majorTasks, minorTasks) {
  const { headerDate, bodyDate } = parseDateText(rawDate);
  const lib = (library || '').trim() || 'UFC';
  const div = `<div class="divider"></div>`;

  let text = `Stable Update! ${lib} {Library} Stable ${version} (${headerDate})\nRelease Date:  ${bodyDate}\n`;
  let html  = `<div class="header"><div class="release-title">Stable Update! ${esc(lib)} &#123;Library&#125; Stable ${esc(version)} (${esc(headerDate)})</div><div class="release-date">Release Date: ${esc(bodyDate)}</div></div>`;

  if (majorTasks.length > 0) {
    text += `\n\n🔥 Major Updates:\n\n\n`;
    text += majorTasks.map(taskToText).join('\n\n________________________________________________\n\n\n');
    text += '\n\n________________________________________________\n';
    html += `<div class="section-title">🔥 Major Updates:</div>` + majorTasks.map(taskToHtml).join(div) + div;
  }
  if (minorTasks.length > 0) {
    text += `\n\n💅 Minor Changes:\n\n\n`;
    text += minorTasks.map(taskToText).join('\n\n\n');
    html += `<div class="section-title">💅 Minor Changes:</div>` + minorTasks.map(taskToHtml).join('');
  }

  return { text, html };
}

// ═══════════════════════════════════════════════════════════════════════════════
// GENERATE CHANGELOG (read from selected frame)
// ═══════════════════════════════════════════════════════════════════════════════

function generateChangelog(library) {
  const selection = figma.currentPage.selection;
  if (selection.length === 0) throw new Error('Select a release frame first (e.g. "3.4.0").');

  const root    = selection[0];
  const version = root.name;

  let rawDate = '';
  const titleFrame = descendantByName(root, 'Title');
  if (titleFrame) {
    for (const t of findAllTextNodes(titleFrame)) {
      const c = (t.characters || '').trim();
      if (/\d{1,2}\s+[a-z]+\s+\d{4}/i.test(c) && !/\d+\.\d+\.\d+/.test(c)) { rawDate = c; break; }
    }
  }
  if (!rawDate) rawDate = new Date().toLocaleDateString('en-GB', { day:'numeric', month:'long', year:'numeric' });

  const majorFrame = descendantByName(root, 'Major');
  const minorFrame = descendantByName(root, 'Minor');
  const majorTasks = majorFrame ? extractTasks(majorFrame) : [];
  const minorTasks = minorFrame ? extractTasks(minorFrame) : [];

  if (majorTasks.length === 0 && minorTasks.length === 0) {
    const kids = 'children' in root ? root.children.map(c=>`"${c.name}"(${c.type})`).join(', ') : 'none';
    throw new Error(`No tasks found.\nFrame "${root.name}" children: ${kids}\n"Major": ${majorFrame ? findTaskNodes(majorFrame).length+' task(s)' : 'NOT FOUND'}\n"Minor": ${minorFrame ? findTaskNodes(minorFrame).length+' task(s)' : 'NOT FOUND'}`);
  }

  return formatChangelog(version, rawDate, library, majorTasks, minorTasks);
}

// ═══════════════════════════════════════════════════════════════════════════════
// GENERATE TEMPLATE  (creates a new artboard matching node 61:47 exactly)
// ═══════════════════════════════════════════════════════════════════════════════

async function generateTemplate(majorCount, minorCount) {
  majorCount = majorCount || 1;
  minorCount = minorCount || 3;

  // Load fonts — Inter is always available in Figma Desktop
  try {
    await Promise.all([
      figma.loadFontAsync({ family: 'Inter', style: 'Regular' }),
      figma.loadFontAsync({ family: 'Inter', style: 'Medium' }),
      figma.loadFontAsync({ family: 'Inter', style: 'Semi Bold' }),
      figma.loadFontAsync({ family: 'Inter', style: 'Bold' }),
    ]);
  } catch (fontErr) {
    throw new Error('Font load failed: ' + String(fontErr));
  }

  // ── Colour tokens (from node 61:47) ──────────────────────────────────────────
  var C = {
    white:        { r:1,    g:1,    b:1    },
    black:        { r:0,    g:0,    b:0    },
    darkGray:     { r:0.20, g:0.20, b:0.20 },   // date text
    sectionLabel: { r:0.36, g:0.37, b:0.41 },   // section label text
    taskBg:       { r:0.92, g:0.93, b:0.96 },   // Task card background
    taskHeader:   { r:0.23, g:0.42, b:0.83 },   // Task card header (blue)
    placeholder:  { r:0.88, g:0.88, b:0.90 },   // screenshot placeholder rect
    linkColor:    { r:0.09, g:0.46, b:0.82 },   // JIRA / Figma link text
  };

  // ── Find existing "Task" component anywhere in the file ──────────────────────
  var taskComponent = figma.root.findOne(function(n) {
    return n.type === 'COMPONENT' && n.name === 'Task';
  });

  // ── Helpers ───────────────────────────────────────────────────────────────────

  function mkText(name, chars, opts) {
    opts = opts || {};
    var t = figma.createText();
    t.name           = name;
    t.fontName       = { family: 'Inter', style: opts.style || 'Regular' };
    t.fontSize       = opts.size !== undefined ? opts.size : 36;
    t.characters     = chars;
    var color        = opts.color   !== undefined ? opts.color   : C.black;
    var opacity      = opts.opacity !== undefined ? opts.opacity : 1;
    t.fills          = [{ type: 'SOLID', color: color, opacity: opacity }];
    t.textAutoResize = 'HEIGHT';
    return t;
  }

  // VERTICAL frames: counter axis (width) must be FIXED so children can FILL horizontally.
  // HORIZONTAL frames: counter axis (height) uses AUTO so it hugs content height.
  function mkFrame(name, opts) {
    opts = opts || {};
    var f = figma.createFrame();
    f.name  = name;
    f.fills = opts.bg ? [{ type: 'SOLID', color: opts.bg }] : [];
    if (opts.radius) f.cornerRadius = opts.radius;
    if (opts.layout) {
      var isVert              = opts.layout === 'VERTICAL';
      f.layoutMode            = opts.layout;
      f.primaryAxisSizingMode = opts.primarySizing || 'AUTO';
      f.counterAxisSizingMode = isVert ? 'FIXED' : 'AUTO';
      f.resize(opts.w !== undefined ? opts.w : 1200, 100);
      f.itemSpacing   = opts.gap !== undefined ? opts.gap : 0;
      f.paddingTop    = opts.pt  !== undefined ? opts.pt  : (opts.pad || 0);
      f.paddingBottom = opts.pb  !== undefined ? opts.pb  : (opts.pad || 0);
      f.paddingLeft   = opts.pl  !== undefined ? opts.pl  : (opts.pad || 0);
      f.paddingRight  = opts.pr  !== undefined ? opts.pr  : (opts.pad || 0);
      if (opts.primaryAlign) f.primaryAxisAlignItems = opts.primaryAlign;
      if (opts.counterAlign) f.counterAxisAlignItems = opts.counterAlign;
    }
    return f;
  }

  // Append child then make it fill the parent's width (for children of VERTICAL frames)
  function appendFill(parent, child) {
    parent.appendChild(child);
    try { child.layoutSizingHorizontal = 'FILL'; } catch (_) {}
  }

  // ── Task card ─────────────────────────────────────────────────────────────────
  // Uses the real "Task" component instance if found; falls back to a plain frame.

  function createTask() {
    if (taskComponent) {
      return taskComponent.createInstance();
    }
    // Fallback: plain frame matching the real Task component's layer structure
    var task = mkFrame('Task', { bg: C.taskBg, layout:'VERTICAL', gap:24, pb:32, radius:16, w:1200 });

    var hdr = mkFrame('Header', { bg: C.taskHeader, layout:'HORIZONTAL', pt:12, pb:12, pl:24, pr:24, primaryAlign:'SPACE_BETWEEN', w:1200 });
    var taskName = mkText('Task Name', '[TAG] Task title', { style:'Bold', size:36, color: C.white });
    appendFill(hdr, taskName);
    var contrib = figma.createEllipse();
    contrib.name  = 'Contributor';
    contrib.fills = [{ type: 'SOLID', color: C.white, opacity: 0.4 }];
    contrib.resize(80, 80);
    hdr.appendChild(contrib);
    task.appendChild(hdr);

    var content = mkFrame('Content', { layout:'VERTICAL', pl:20, pr:20, gap:24, w:1200 });
    var desc = mkText('Description', 'Describe what was changed in this task...', { size:36, color: C.black, opacity: 0.80 });
    appendFill(content, desc);
    var links = mkFrame('Links', { layout:'HORIZONTAL', gap:11, counterAlign:'CENTER' });
    links.appendChild(mkText('JiraLink',  'JIRA',  { style:'Bold', size:36, color: C.linkColor }));
    links.appendChild(mkText('FigmaLink', 'Figma', { style:'Bold', size:36, color: C.linkColor }));
    content.appendChild(links);
    appendFill(task, content);
    return task;
  }

  // ── Title block ───────────────────────────────────────────────────────────────
  // Matches node 61:47 structure:
  //   Title (HORIZONTAL, pb=32)
  //     Frame 10 (VERTICAL, w=1106)
  //       Date   – Inter Semi Bold 48px, dark gray
  //       Frame 9 (VERTICAL, gap=32)
  //         Version – Inter Medium 128px, black

  var today      = new Date();
  var MONTHS_LC  = ['january','february','march','april','may','june','july','august','september','october','november','december'];
  var dateStr    = today.getDate() + ' ' + MONTHS_LC[today.getMonth()] + ' ' + today.getFullYear();

  var frame9 = mkFrame('Frame 9', { layout:'VERTICAL', gap:32, w:1106 });
  appendFill(frame9, mkText('Version', 'Stable Version x.x.x', { style:'Medium', size:128, color: C.black }));

  var frame10 = mkFrame('Frame 10', { layout:'VERTICAL', w:1106 });
  appendFill(frame10, mkText('Date', dateStr, { style:'Semi Bold', size:48, color: C.darkGray }));
  frame10.appendChild(frame9);

  // Title frame: HORIZONTAL, pb=32. Frame 10 sits on the left at its own width (1106).
  var titleBlock = mkFrame('Title', { layout:'HORIZONTAL', pb:32, w:3500 });
  titleBlock.appendChild(frame10);

  // ── Section factory ───────────────────────────────────────────────────────────
  // Each section matches node 61:47: HORIZONTAL, FIXED 3500px, SPACE_BETWEEN
  //   Col 1 – label text (1005 wide, Inter Medium 128px, section-label colour)
  //   Col 2 – screenshot placeholder rectangle (780 × 675)
  //   Col 3 – task cards stacked vertically (1200 wide)

  function createSection(name, labelStr, count) {
    var sec = mkFrame(name, {
      layout:        'HORIZONTAL',
      primarySizing: 'FIXED',
      w:             3500,
      gap:           200,
      primaryAlign:  'SPACE_BETWEEN',
    });

    // Col 1 — label
    var col1 = mkFrame(name + ' Label', { layout:'VERTICAL', counterAlign:'CENTER', w:1005 });
    appendFill(col1, mkText(name + ' Label Text', labelStr, { style:'Medium', size:128, color: C.sectionLabel }));
    sec.appendChild(col1);

    // Col 2 — screenshot / image placeholder
    var screen = figma.createRectangle();
    screen.name         = 'Screen';
    screen.fills        = [{ type: 'SOLID', color: C.placeholder }];
    screen.cornerRadius = 16;
    screen.resize(780, 675);
    sec.appendChild(screen);

    // Col 3 — task cards
    var col3 = mkFrame(name + ' Tasks', { layout:'VERTICAL', gap:24, w:1200 });
    for (var i = 0; i < count; i++) {
      col3.appendChild(createTask());
    }
    sec.appendChild(col3);

    return sec;
  }

  // ── Main frame ────────────────────────────────────────────────────────────────
  // Matches node 61:47: 4012 wide, white, cornerRadius=128, padding=256, gap=32

  var main = figma.createFrame();
  main.name                  = 'x.x.x';
  main.layoutMode            = 'VERTICAL';
  main.primaryAxisSizingMode = 'AUTO';
  main.counterAxisSizingMode = 'FIXED';
  main.resize(4012, 100);
  main.itemSpacing           = 32;
  main.paddingTop            = 256;
  main.paddingBottom         = 256;
  main.paddingLeft           = 256;
  main.paddingRight          = 256;
  main.fills                 = [{ type: 'SOLID', color: C.white }];
  main.cornerRadius          = 128;

  appendFill(main, titleBlock);
  appendFill(main, createSection('Major', 'New features\nand major\nupdates', majorCount));
  appendFill(main, createSection('Minor', 'Minor changes\nand fixes',         minorCount));

  // ── Place in canvas & select ──────────────────────────────────────────────────

  main.x = figma.viewport.center.x - main.width  / 2;
  main.y = figma.viewport.center.y - main.height / 2;
  figma.currentPage.appendChild(main);
  figma.currentPage.selection = [main];
  figma.viewport.scrollAndZoomIntoView([main]);
}
