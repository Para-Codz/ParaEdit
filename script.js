/* ==========================================================
   ParaEdit — Application Logic
   ========================================================== */

// ---------- Config & State ----------
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const state = {
  history: [],
  historyIdx: -1,
  maxHistory: 50,
  currentDNA: null,
  presets: JSON.parse(localStorage.getItem('paraedit_presets') || '[]'),
  recording: true,
  lastSnapshotTime: 0,
  compressorFile: null,
  compressorText: '',
};

const editor = document.getElementById('editor');

// ---------- Utilities ----------
function $(id) { return document.getElementById(id); }

function toast(msg, type = '') {
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  const icons = { success: '✓', error: '✕', warning: '⚠', '': 'ℹ' };
  t.innerHTML = `<span style="font-weight:700;font-size:16px">${icons[type] || icons['']}</span><span>${msg}</span>`;
  $('toastContainer').appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, 3200);
}

function showLoading(text = 'Processing...') {
  $('loadingText').textContent = text;
  $('loadingOverlay').classList.add('show');
}
function hideLoading() { $('loadingOverlay').classList.remove('show'); }

function showModal(title, desc, defaultValue = '') {
  return new Promise(resolve => {
    $('modalTitle').textContent = title;
    $('modalDesc').textContent = desc;
    $('modalInput').value = defaultValue;
    $('modalOverlay').classList.add('show');
    $('modalInput').focus();
    const cleanup = () => {
      $('modalOverlay').classList.remove('show');
      $('modalConfirm').onclick = null;
      $('modalCancel').onclick = null;
    };
    $('modalConfirm').onclick = () => { const v = $('modalInput').value; cleanup(); resolve(v); };
    $('modalCancel').onclick = () => { cleanup(); resolve(null); };
  });
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function readFileAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('FileReader failed for ' + file.name));
    reader.readAsArrayBuffer(file);
  });
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('FileReader failed for ' + file.name));
    reader.readAsText(file);
  });
}

// ---------- PAGE NAVIGATION ----------
function showPage(pageId) {
  document.querySelectorAll('.page-view, .compressor-page').forEach(p => p.classList.remove('active'));
  $(pageId).classList.add('active');
}

$('goCompressorBtn').addEventListener('click', () => showPage('compressorPage'));
$('goCompressorBtn2').addEventListener('click', () => showPage('compressorPage'));
$('compBackBtn').addEventListener('click', () => showPage('editorPage'));

// ---------- THEME ----------
const savedTheme = localStorage.getItem('paraedit_theme') || 'light';
document.body.setAttribute('data-theme', savedTheme);
$('themeBtn').addEventListener('click', () => {
  const cur = document.body.getAttribute('data-theme');
  const next = cur === 'light' ? 'dark' : 'light';
  document.body.setAttribute('data-theme', next);
  localStorage.setItem('paraedit_theme', next);
  toast(`Switched to ${next} mode`, 'success');
});

// ================================================================
//  FILE UPLOAD — EDITOR (FIXED & BULLETPROOF)
// ================================================================
const fileInput = $('fileInput');
const uploadBtn = $('uploadBtn');
const dropZone = $('dropZone');

// Method 1: Click the upload button
uploadBtn.addEventListener('click', function(e) {
  e.preventDefault();
  e.stopPropagation();
  fileInput.value = '';
  fileInput.click();
});

// Method 2: Click the drop zone
dropZone.addEventListener('click', function(e) {
  e.preventDefault();
  e.stopPropagation();
  fileInput.value = '';
  fileInput.click();
});

// Method 3: File input change
fileInput.addEventListener('change', function(e) {
  const file = this.files && this.files[0];
  if (file) {
    handleEditorFile(file);
  }
});

// Method 4: Drag and drop
;['dragover','dragenter'].forEach(evName => {
  dropZone.addEventListener(evName, function(e) {
    e.preventDefault();
    e.stopPropagation();
    this.classList.add('dragover');
  });
});
;['dragleave','drop'].forEach(evName => {
  dropZone.addEventListener(evName, function(e) {
    e.preventDefault();
    e.stopPropagation();
    this.classList.remove('dragover');
  });
});

dropZone.addEventListener('drop', function(e) {
  const dt = e.dataTransfer;
  if (dt && dt.files && dt.files.length > 0) {
    handleEditorFile(dt.files[0]);
  }
});

// Prevent browser default drop behavior globally
;['dragover','drop'].forEach(evName => {
  document.body.addEventListener(evName, function(e) {
    if (!e.target.closest('.drop-zone') && !e.target.closest('.comp-upload-zone')) {
      e.preventDefault();
    }
  });
});

// ---- The core handler (NO SIZE LIMIT) ----
async function handleEditorFile(file) {
  if (!file) {
    toast('No file selected.', 'error');
    return;
  }

  const ext = file.name.split('.').pop().toLowerCase();
  const supportedParsers = ['pdf', 'docx', 'doc', 'odt', 'txt'];
  const textFormats = ['txt', 'md', 'csv', 'json', 'xml', 'html', 'htm', 'rtf', 'log', 'ini', 'cfg', 'yaml', 'yml', 'sql', 'css', 'js'];

  showLoading('Reading ' + file.name + ' (' + formatBytes(file.size) + ')...');

  try {
    let html = '';

    if (ext === 'pdf') {
      html = await parsePDF(file);
    } else if (ext === 'docx' || ext === 'doc') {
      html = await parseDOCX(file);
    } else if (ext === 'odt') {
      html = await parseODT(file);
    } else if (textFormats.includes(ext)) {
      html = await parseTXT(file);
    } else {
      // Try reading as text anyway for unknown formats
      try {
        html = await parseTXT(file);
      } catch(innerErr) {
        throw new Error('Cannot read this file format (.'+ext+'). Try PDF, DOCX, or TXT.');
      }
    }

    if (!html || html.replace(/<[^>]*>/g, '').trim() === '') {
      throw new Error('The document appears empty or could not be parsed.');
    }

    // Success: push content to editor
    editor.innerHTML = html;
    $('fileStatus').textContent = file.name;
    $('filenameInput').value = file.name.replace(/\.[^.]+$/, '');
    updateStats();
    snapshot(true);

    // Show file info badge
    $('uploadFileName').textContent = file.name;
    $('uploadFileSize').textContent = formatBytes(file.size) + ' · ' + ext.toUpperCase();
    $('uploadFileInfo').classList.add('show');

    // Reset input so same file can be reloaded
    fileInput.value = '';

    toast('Loaded: ' + file.name, 'success');

  } catch (err) {
    console.error('Upload Error:', err);
    toast('Failed: ' + err.message, 'error');
    fileInput.value = '';
  } finally {
    hideLoading();
  }
}

// ---- Parsers ----
async function parsePDF(file) {
  const buf = await readFileAsArrayBuffer(file);
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  let html = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    let lastY = null;
    let paragraph = '';
    content.items.forEach(item => {
      if (lastY !== null && Math.abs(item.transform[5] - lastY) > 4) {
        if (paragraph.trim()) html += '<p>' + escapeHtml(paragraph.trim()) + '</p>';
        paragraph = '';
      }
      paragraph += item.str + ' ';
      lastY = item.transform[5];
    });
    if (paragraph.trim()) html += '<p>' + escapeHtml(paragraph.trim()) + '</p>';
    if (i < pdf.numPages) html += '<p><br></p>';
  }
  return html;
}

async function parseDOCX(file) {
  const buf = await readFileAsArrayBuffer(file);
  const result = await mammoth.convertToHtml({ arrayBuffer: buf });
  return result.value;
}

async function parseODT(file) {
  try {
    const text = await readFileAsText(file);
    if (text.includes('<text:p')) {
      const parser = new DOMParser();
      const xml = parser.parseFromString(text, 'application/xml');
      const paras = xml.getElementsByTagNameNS('*', 'p');
      let html = '';
      for (let p of paras) html += '<p>' + escapeHtml(p.textContent) + '</p>';
      return html;
    }
  } catch(e) {}
  // ODT is really a zip - try as text fallback
  const text = await readFileAsText(file);
  return text.split(/\n\n+/).map(p => '<p>' + escapeHtml(p).replace(/\n/g, '<br>') + '</p>').join('');
}

async function parseTXT(file) {
  const text = await readFileAsText(file);
  return text.split(/\n\n+/).map(p => '<p>' + escapeHtml(p).replace(/\n/g, '<br>') + '</p>').join('');
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------- TOOLBAR ----------
document.querySelectorAll('.tb-btn[data-cmd]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.execCommand(btn.dataset.cmd, false, null);
    editor.focus();
    updateToolbarState();
  });
});

$('fontFamily').addEventListener('change', e => {
  document.execCommand('fontName', false, e.target.value);
  editor.focus();
});
$('fontSize').addEventListener('change', e => {
  document.execCommand('fontSize', false, e.target.value);
  editor.focus();
});
$('blockFormat').addEventListener('change', e => {
  document.execCommand('formatBlock', false, e.target.value);
  editor.focus();
});
$('textColor').addEventListener('input', e => {
  document.execCommand('foreColor', false, e.target.value);
  editor.focus();
});
$('highlightColor').addEventListener('input', e => {
  document.execCommand('hiliteColor', false, e.target.value);
  editor.focus();
});

$('insertLinkBtn').addEventListener('click', async () => {
  const url = await showModal('Insert Link', 'Enter the URL:', 'https://');
  if (url) document.execCommand('createLink', false, url);
});

$('insertImageBtn').addEventListener('click', () => {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      document.execCommand('insertImage', false, ev.target.result);
    };
    reader.readAsDataURL(file);
  };
  input.click();
});

$('undoBtn').addEventListener('click', () => { document.execCommand('undo'); });
$('redoBtn').addEventListener('click', () => { document.execCommand('redo'); });

$('clearBtn').addEventListener('click', async () => {
  if (editor.textContent.trim() === '') return;
  const ok = await showModal('Clear Document', 'This will erase all content. Type "yes" to confirm:', '');
  if (ok && ok.toLowerCase() === 'yes') {
    editor.innerHTML = '';
    updateStats();
    snapshot(true);
    toast('Document cleared', 'warning');
  }
});

function updateToolbarState() {
  ['bold', 'italic', 'underline', 'strikeThrough', 'justifyLeft', 'justifyCenter', 'justifyRight', 'justifyFull', 'insertUnorderedList', 'insertOrderedList'].forEach(cmd => {
    const btn = document.querySelector('.tb-btn[data-cmd="'+cmd+'"]');
    if (btn) {
      try { btn.classList.toggle('active', document.queryCommandState(cmd)); } catch(e) {}
    }
  });
}

editor.addEventListener('keyup', updateToolbarState);
editor.addEventListener('mouseup', updateToolbarState);

// ---------- STATS ----------
function updateStats() {
  const text = editor.innerText || '';
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const chars = text.length;
  $('wordCount').textContent = words;
  $('charCount').textContent = chars;
  $('readTime').textContent = Math.max(1, Math.ceil(words / 220));
  $('paraCount').textContent = editor.querySelectorAll('p').length;
  $('sentCount').textContent = (text.match(/[.!?]+/g) || []).length;
  $('headCount').textContent = editor.querySelectorAll('h1, h2, h3, h4, h5, h6').length;
  $('imgCount').textContent = editor.querySelectorAll('img').length;
}

editor.addEventListener('input', () => {
  updateStats();
  scheduleSnapshot();
});

// ---------- TIME TRAVEL ----------
function snapshot(force = false) {
  const now = Date.now();
  if (!force && now - state.lastSnapshotTime < 1500) return;
  state.lastSnapshotTime = now;
  if (state.historyIdx < state.history.length - 1) {
    state.history = state.history.slice(0, state.historyIdx + 1);
  }
  state.history.push({
    html: editor.innerHTML,
    time: now,
    words: parseInt($('wordCount').textContent)
  });
  if (state.history.length > state.maxHistory) {
    state.history.shift();
  }
  state.historyIdx = state.history.length - 1;
  updateTimeline();
}

let snapshotTimer = null;
function scheduleSnapshot() {
  clearTimeout(snapshotTimer);
  snapshotTimer = setTimeout(() => snapshot(), 1200);
}

function updateTimeline() {
  const max = Math.max(0, state.history.length - 1);
  $('timeline').max = max;
  $('timeline').value = state.historyIdx;
  $('timeIdx').textContent = state.historyIdx + 1;
  $('timeMax').textContent = state.history.length;
  if (state.history.length > 0) {
    const s = state.history[state.historyIdx];
    const ago = Math.floor((Date.now() - s.time) / 1000);
    const agoText = ago < 60 ? ago+'s ago' : Math.floor(ago/60)+'m ago';
    $('timeMeta').textContent = s.words + ' words · ' + agoText;
  }
}

$('timeline').addEventListener('input', e => {
  const idx = parseInt(e.target.value);
  if (state.history[idx]) {
    state.recording = false;
    editor.innerHTML = state.history[idx].html;
    state.historyIdx = idx;
    updateStats();
    updateTimeline();
    setTimeout(() => state.recording = true, 100);
  }
});

setInterval(updateTimeline, 30000);

// ---------- STYLE DNA ----------
function analyzeDNA(text) {
  text = text.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
  const words = text.split(/\s+/).filter(w => w.length > 0);
  const avgSentenceLen = sentences.length ? words.length / sentences.length : 0;
  const avgWordLen = words.length ? words.reduce((a,w) => a + w.length, 0) / words.length : 0;
  const formalWords = ['therefore', 'however', 'furthermore', 'moreover', 'consequently', 'nevertheless', 'thus', 'whereas', 'pursuant', 'regarding', 'shall', 'hereby'];
  const casualWords = ['gonna', 'wanna', 'yeah', 'cool', 'awesome', 'stuff', 'thing', 'kinda', 'like', 'just', "i'm", "you're", "it's"];
  const lower = ' ' + text.toLowerCase() + ' ';
  let formalScore = 0, casualScore = 0;
  formalWords.forEach(w => { const m = lower.match(new RegExp('\\b'+w+'\\b', 'g')); if (m) formalScore += m.length; });
  casualWords.forEach(w => { const m = lower.match(new RegExp('\\b'+w+'\\b', 'g')); if (m) casualScore += m.length; });
  const emotionalWords = ['amazing', 'wonderful', 'terrible', 'love', 'hate', 'beautiful', 'fantastic', 'awful'];
  const analyticalWords = ['data', 'analysis', 'research', 'study', 'evidence', 'results', 'method', 'conclusion'];
  let emoScore = 0, anaScore = 0;
  emotionalWords.forEach(w => { const m = lower.match(new RegExp('\\b'+w+'\\b', 'g')); if (m) emoScore += m.length; });
  analyticalWords.forEach(w => { const m = lower.match(new RegExp('\\b'+w+'\\b', 'g')); if (m) anaScore += m.length; });
  const complexity = Math.min(100, Math.round((avgSentenceLen * 1.5) + (avgWordLen * 8)));
  const formality = Math.max(0, Math.min(100, 50 + (formalScore - casualScore) * 8));
  let tone = 'Neutral';
  if (anaScore > emoScore && formality > 55) tone = 'Analytical';
  else if (formality > 70) tone = 'Professional';
  else if (emoScore > anaScore && formality < 50) tone = 'Expressive';
  else if (formality < 35) tone = 'Casual';
  else if (avgSentenceLen > 20) tone = 'Academic';
  else tone = 'Conversational';
  const exclamations = (text.match(/!/g) || []).length;
  const questions = (text.match(/\?/g) || []).length;
  return {
    avgSentenceLen: Math.round(avgSentenceLen * 10) / 10,
    avgWordLen: Math.round(avgWordLen * 10) / 10,
    complexity, formality, tone, exclamations, questions,
    sentenceCount: sentences.length, wordCount: words.length,
    fingerprint: [
      Math.min(1, avgSentenceLen / 30), Math.min(1, avgWordLen / 8),
      complexity / 100, formality / 100, Math.min(1, emoScore / 5),
      Math.min(1, anaScore / 5), Math.min(1, exclamations / 10), Math.min(1, questions / 10)
    ]
  };
}

function renderDNA(dna) {
  if (!dna) return;
  const colors = ['#6366f1', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#3b82f6', '#ef4444', '#14b8a6'];
  const bars = document.querySelectorAll('#dnaStrip .dna-bar');
  bars.forEach((bar, i) => {
    const v = dna.fingerprint[i] || 0;
    bar.style.background = colors[i];
    bar.style.opacity = 0.3 + v * 0.7;
  });
  const statValues = document.querySelectorAll('#dnaStats .value');
  statValues[0].textContent = dna.tone;
  statValues[1].textContent = dna.complexity + '%';
  statValues[2].textContent = dna.avgSentenceLen + ' w';
  statValues[3].textContent = dna.formality + '%';
}

$('dnaAnalyzeBtn').addEventListener('click', () => {
  const text = editor.innerText.trim();
  if (!text) { toast('Add some text to analyze', 'warning'); return; }
  state.currentDNA = analyzeDNA(text);
  renderDNA(state.currentDNA);
  toast('Style DNA extracted: ' + state.currentDNA.tone, 'success');
});

$('extractDNABtn').addEventListener('click', () => $('dnaAnalyzeBtn').click());

$('dnaSaveBtn').addEventListener('click', async () => {
  if (!state.currentDNA) { toast('Analyze first to extract DNA', 'warning'); return; }
  const name = await showModal('Save Style Preset', 'Give your style a memorable name:', state.currentDNA.tone + ' Style');
  if (!name) return;
  state.presets.push({ name, dna: state.currentDNA, created: Date.now() });
  localStorage.setItem('paraedit_presets', JSON.stringify(state.presets));
  renderPresets();
  toast('Preset "'+name+'" saved', 'success');
});

function renderPresets() {
  const list = $('presetList');
  if (!state.presets.length) {
    list.innerHTML = '<div class="preset-empty">No presets yet. Analyze a document and save your first style!</div>';
    return;
  }
  list.innerHTML = '';
  state.presets.forEach((p, i) => {
    const el = document.createElement('div');
    el.className = 'preset-item';
    el.innerHTML = '<div class="dot"></div><div class="name">'+escapeHtml(p.name)+'<div style="font-size:10px;color:var(--text-soft);font-weight:400">'+p.dna.tone+' · '+p.dna.formality+'% formal</div></div><button class="del" data-i="'+i+'" title="Delete">✕</button>';
    el.addEventListener('click', e => {
      if (e.target.classList.contains('del')) return;
      state.currentDNA = p.dna;
      renderDNA(p.dna);
      toast('Loaded preset "'+p.name+'"', 'success');
    });
    el.querySelector('.del').addEventListener('click', e => {
      e.stopPropagation();
      state.presets.splice(i, 1);
      localStorage.setItem('paraedit_presets', JSON.stringify(state.presets));
      renderPresets();
      toast('Preset deleted', 'warning');
    });
    list.appendChild(el);
  });
}
renderPresets();

$('applyDNABtn').addEventListener('click', () => {
  if (!state.currentDNA) { toast('Extract a DNA first or load a preset', 'warning'); return; }
  applyDNAToEditor(state.currentDNA);
});

function applyDNAToEditor(dna) {
  const text = editor.innerText.trim();
  if (!text) { toast('Add text first to apply style', 'warning'); return; }
  const fontMap = {
    'Professional': 'Georgia, serif', 'Academic': '"Times New Roman", serif',
    'Analytical': 'Inter, sans-serif', 'Conversational': 'Inter, sans-serif',
    'Expressive': 'Georgia, serif', 'Casual': 'Verdana, sans-serif', 'Neutral': 'Inter, sans-serif'
  };
  const font = fontMap[dna.tone] || 'Inter, sans-serif';
  const paras = editor.querySelectorAll('p, div');
  paras.forEach(p => {
    p.style.fontFamily = font;
    if (dna.formality > 60) { p.style.textAlign = 'justify'; p.style.textIndent = '1.5em'; }
    else { p.style.textAlign = 'left'; p.style.textIndent = '0'; }
    p.style.lineHeight = dna.complexity > 60 ? '1.85' : '1.65';
  });
  editor.style.fontFamily = font;
  if (dna.avgSentenceLen < 12) {
    paras.forEach(p => {
      const sentences = p.innerText.split(/(?<=[.!?])\s+/);
      if (sentences.length > 3) {
        const chunks = [];
        for (let i = 0; i < sentences.length; i += 2) chunks.push(sentences.slice(i, i + 2).join(' '));
        p.innerHTML = chunks.map(c => escapeHtml(c)).join('<br><br>');
      }
    });
  }
  updateStats();
  snapshot(true);
  toast('Applied '+dna.tone+' style DNA to document', 'success');
}

$('blendDNABtn').addEventListener('click', async () => {
  if (state.presets.length < 2) { toast('Need at least 2 saved presets to blend', 'warning'); return; }
  const a = state.presets[state.presets.length - 1].dna;
  const b = state.presets[state.presets.length - 2].dna;
  const blended = {
    avgSentenceLen: (a.avgSentenceLen + b.avgSentenceLen) / 2,
    avgWordLen: (a.avgWordLen + b.avgWordLen) / 2,
    complexity: Math.round((a.complexity + b.complexity) / 2),
    formality: Math.round((a.formality + b.formality) / 2),
    tone: 'Blended (' + a.tone + ' × ' + b.tone + ')',
    exclamations: 0, questions: 0, sentenceCount: 0, wordCount: 0,
    fingerprint: a.fingerprint.map((v, i) => (v + b.fingerprint[i]) / 2)
  };
  state.currentDNA = blended;
  renderDNA(blended);
  toast('Blended: ' + a.tone + ' × ' + b.tone, 'success');
});

// ---------- FOCUS AI CLEANER ----------
$('cleanerBtn').addEventListener('click', () => {
  const text = editor.innerText;
  if (!text.trim()) { toast('Nothing to clean', 'warning'); return; }
  showLoading('Cleaning document...');
  setTimeout(() => {
    const cleaned = focusClean(text);
    editor.innerHTML = cleaned;
    updateStats();
    snapshot(true);
    hideLoading();
    toast('Document cleaned and structured', 'success');
  }, 600);
});

function focusClean(text) {
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.replace(/page \d+ of \d+/gi, '');
  text = text.replace(/^\s*\d+\s*$/gm, '');
  text = text.replace(/[•◦▪►▼◆■]/g, '-');
  text = text.replace(/-{3,}/g, '');
  text = text.replace(/_{3,}/g, '');
  text = text.replace(/\.{4,}/g, '...');
  const paragraphs = text.split(/\n\n+/).map(p => p.trim()).filter(p => p.length > 0);
  let html = '';
  paragraphs.forEach(p => {
    const lines = p.split(/\n/).map(l => l.trim()).filter(l => l);
    if (lines.length === 1) {
      const line = lines[0];
      if (line.length < 80 && !line.endsWith('.') && !line.endsWith(',')) {
        if (line === line.toUpperCase() && line.length > 3) { html += '<h2>'+escapeHtml(toTitleCase(line))+'</h2>'; return; }
        if (/^(chapter|section|part|introduction|conclusion|summary|abstract)/i.test(line)) { html += '<h2>'+escapeHtml(line)+'</h2>'; return; }
        if (line.length < 50 && line.split(' ').length < 8 && /^[A-Z]/.test(line)) { html += '<h3>'+escapeHtml(line)+'</h3>'; return; }
      }
    }
    const isBulletList = lines.every(l => /^[-*]\s/.test(l));
    const isNumberedList = lines.every(l => /^\d+[.\)]\s/.test(l));
    if (isBulletList && lines.length > 1) { html += '<ul>' + lines.map(l => '<li>'+escapeHtml(l.replace(/^[-*]\s+/, ''))+'</li>').join('') + '</ul>'; return; }
    if (isNumberedList && lines.length > 1) { html += '<ol>' + lines.map(l => '<li>'+escapeHtml(l.replace(/^\d+[.\)]\s+/, ''))+'</li>').join('') + '</ol>'; return; }
    const joined = lines.join(' ').replace(/\s+/g, ' ').trim();
    if (joined) html += '<p>'+escapeHtml(joined)+'</p>';
  });
  return html || '<p>(empty)</p>';
}

function toTitleCase(s) { return s.toLowerCase().replace(/\b\w/g, c => c.toUpperCase()); }

// ---------- FOCUS MODE ----------
$('focusModeBtn').addEventListener('click', () => {
  document.body.classList.toggle('focus-mode');
  const on = document.body.classList.contains('focus-mode');
  toast(on ? 'Focus mode on — press again to exit' : 'Focus mode off', 'success');
});

// ---------- EXPORT ----------
document.querySelectorAll('.export-btn').forEach(btn => {
  btn.addEventListener('click', () => exportAs(btn.dataset.format));
});

$('quickExportBtn').addEventListener('click', () => exportAs('pdf'));

async function exportAs(format) {
  const filename = ($('filenameInput').value || 'document').trim();
  if (!editor.innerText.trim()) { toast('Nothing to export', 'warning'); return; }
  showLoading('Exporting as '+format.toUpperCase()+'...');
  try {
    if (format === 'txt') exportTXT(filename);
    else if (format === 'html') exportHTML(filename);
    else if (format === 'docx') exportDOCX(filename);
    else if (format === 'odt') exportODT(filename);
    else if (format === 'pdf') await exportPDF(filename);
    toast('Downloaded '+filename+'.'+format, 'success');
  } catch (err) {
    console.error(err);
    toast('Export failed: '+err.message, 'error');
  } finally {
    hideLoading();
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
}

function exportTXT(filename) {
  const text = editor.innerText;
  downloadBlob(new Blob([text], { type: 'text/plain' }), filename + '.txt');
}

function exportHTML(filename) {
  const html = '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>'+escapeHtml(filename)+'</title><style>body{font-family:Inter,sans-serif;max-width:780px;margin:40px auto;padding:0 20px;line-height:1.7}</style></head><body>'+editor.innerHTML+'</body></html>';
  downloadBlob(new Blob([html], { type: 'text/html' }), filename + '.html');
}

function exportDOCX(filename) {
  const html = '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>'+editor.innerHTML+'</body></html>';
  const blob = window.htmlDocx.asBlob(html);
  downloadBlob(blob, filename + '.docx');
}

function exportODT(filename) {
  const text = editor.innerText;
  const paras = text.split(/\n+/).map(p => p.trim()).filter(p => p);
  const body = paras.map(p => '<text:p>'+escapeXml(p)+'</text:p>').join('');
  const xml = '<?xml version="1.0" encoding="UTF-8"?><office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:mimetype="application/vnd.oasis.opendocument.text" office:version="1.2"><office:body><office:text>'+body+'</office:text></office:body></office:document>';
  downloadBlob(new Blob([xml], { type: 'application/vnd.oasis.opendocument.text' }), filename + '.odt');
}

function escapeXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

async function exportPDF(filename) {
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({ unit: 'pt', format: 'a4' });
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const margin = 50;
  const maxWidth = pageWidth - margin * 2;
  let y = margin;
  const nodes = editor.children.length ? Array.from(editor.children) : [editor];
  for (const node of nodes) {
    const tag = node.tagName ? node.tagName.toLowerCase() : 'p';
    let fontSize = 11;
    let fontStyle = 'normal';
    if (tag === 'h1') { fontSize = 22; fontStyle = 'bold'; }
    else if (tag === 'h2') { fontSize = 18; fontStyle = 'bold'; }
    else if (tag === 'h3') { fontSize = 15; fontStyle = 'bold'; }
    else if (tag === 'blockquote') { fontSize = 11; fontStyle = 'italic'; }
    pdf.setFontSize(fontSize);
    pdf.setFont('helvetica', fontStyle);
    const text = node.innerText || node.textContent || '';
    if (!text.trim()) { y += fontSize * 0.5; continue; }
    const lines = pdf.splitTextToSize(text, maxWidth);
    for (const line of lines) {
      if (y + fontSize > pageHeight - margin) { pdf.addPage(); y = margin; }
      pdf.text(line, margin, y);
      y += fontSize * 1.4;
    }
    y += fontSize * 0.5;
  }
  pdf.save(filename + '.pdf');
}

// ================================================================
//  COMPRESSOR PAGE LOGIC
// ================================================================
const compUploadZone = $('compUploadZone');
const compFileInput = $('compFileInput');
const compUploadBtn = $('compUploadBtn');

// Method 1: Click the main upload button
compUploadBtn.addEventListener('click', function(e) {
  e.preventDefault();
  e.stopPropagation();
  compFileInput.value = '';
  compFileInput.click();
});

// Method 2: Click the drop zone
compUploadZone.addEventListener('click', function(e) {
  e.preventDefault();
  e.stopPropagation();
  compFileInput.value = '';
  compFileInput.click();
});

// Method 3: File input change
compFileInput.addEventListener('change', function() {
  const file = this.files && this.files[0];
  if (file) {
    processCompressorFile(file);
    setTimeout(() => { compFileInput.value = ''; }, 100);
  }
});

// Method 4: Drag and drop
;['dragover','dragenter'].forEach(evName => {
  compUploadZone.addEventListener(evName, function(e) {
    e.preventDefault();
    e.stopPropagation();
    this.classList.add('dragover');
  });
});
;['dragleave','drop'].forEach(evName => {
  compUploadZone.addEventListener(evName, function(e) {
    e.preventDefault();
    e.stopPropagation();
    this.classList.remove('dragover');
  });
});

compUploadZone.addEventListener('drop', function(e) {
  const dt = e.dataTransfer;
  if (dt && dt.files && dt.files.length > 0) {
    processCompressorFile(dt.files[0]);
  }
});

// Reset / Compress Another
$('compResetBtn').addEventListener('click', function() {
  $('compResult').classList.remove('show');
  $('compLoadedInfo').classList.remove('show');
  state.compressorFile = null;
  state.compressorText = '';
  compFileInput.value = '';
  toast('Ready for another file', 'success');
});

async function processCompressorFile(file) {
  if (!file) return;

  state.compressorFile = file;
  const ext = file.name.split('.').pop().toLowerCase();

  // Show progress
  $('compResult').classList.add('show');
  $('compProgress').classList.add('show');
  const bar = $('compProgressBar');
  bar.style.width = '10%';

  $('compFileTypeBadge').textContent = ext.toUpperCase().substring(0, 4);
  $('compFileName').textContent = file.name;
  $('compFileMeta').textContent = formatBytes(file.size) + ' · ' + ext.toUpperCase() + ' Document';
  $('compOrigSize').textContent = formatBytes(file.size);
  $('compNewSize').textContent = '...';
  $('compSaved').textContent = '...';
  $('compOutputName').value = file.name.replace(/\.[^.]+$/, '') + '_compressed';

  // Show loaded file info
  $('compLoadedName').textContent = file.name;
  $('compLoadedSize').textContent = formatBytes(file.size) + ' · ' + ext.toUpperCase();
  $('compLoadedInfo').classList.add('show');

  showLoading('Compressing ' + file.name + ' (' + formatBytes(file.size) + ')...');

  // Use setTimeout to let the UI render before heavy work
  await new Promise(r => setTimeout(r, 50));

  try {
    bar.style.width = '30%';

    // Extract text from file — NO SIZE LIMIT
    let rawText = '';
    if (ext === 'pdf') {
      const buf = await readFileAsArrayBuffer(file);
      bar.style.width = '40%';
      const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
      const totalPages = pdf.numPages;
      for (let i = 1; i <= totalPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        content.items.forEach(item => { rawText += item.str + ' '; });
        rawText += '\n\n';
        // Update progress per page
        bar.style.width = (40 + Math.round((i / totalPages) * 30)) + '%';
      }
    } else if (ext === 'docx' || ext === 'doc') {
      const buf = await readFileAsArrayBuffer(file);
      bar.style.width = '40%';
      const result = await mammoth.extractRawText({ arrayBuffer: buf });
      rawText = result.value;
      bar.style.width = '60%';
    } else {
      // Read ANY other format as text
      rawText = await readFileAsText(file);
      bar.style.width = '60%';
    }

    if (!rawText || rawText.trim().length === 0) {
      throw new Error('No text content found in this file.');
    }

    // Compress: strip redundant whitespace, noise, normalize
    let compressed = rawText;
    compressed = compressed.replace(/\r\n/g, '\n');
    compressed = compressed.replace(/\r/g, '\n');
    compressed = compressed.replace(/[ \t]+/g, ' ');
    compressed = compressed.replace(/\n{3,}/g, '\n\n');
    compressed = compressed.replace(/^\s+$/gm, '');
    compressed = compressed.replace(/page\s*\d+\s*(of\s*\d+)?/gi, '');
    compressed = compressed.replace(/^\s*\d+\s*$/gm, '');
    compressed = compressed.replace(/-{3,}/g, '');
    compressed = compressed.replace(/_{3,}/g, '');
    compressed = compressed.replace(/={3,}/g, '');
    compressed = compressed.replace(/~{3,}/g, '');
    compressed = compressed.replace(/\*{3,}/g, '');
    compressed = compressed.replace(/\.{4,}/g, '...');
    compressed = compressed.replace(/\n{3,}/g, '\n\n');
    compressed = compressed.trim();

    state.compressorText = compressed;

    bar.style.width = '90%';

    const originalSize = file.size;
    const compressedSize = new Blob([compressed]).size;
    const savedPercent = originalSize > 0 ? Math.round((1 - compressedSize / originalSize) * 100) : 0;
    const displaySaved = Math.max(0, savedPercent);

    $('compOrigSize').textContent = formatBytes(originalSize);
    $('compNewSize').textContent = formatBytes(compressedSize);
    $('compSaved').textContent = displaySaved + '%';

    bar.style.width = '100%';
    setTimeout(() => $('compProgress').classList.remove('show'), 600);

    // Build download buttons
    const grid = $('compDownloadGrid');
    grid.innerHTML = '';
    const formats = [
      { fmt: 'pdf', label: 'PDF', icon: '📕' },
      { fmt: 'docx', label: 'DOCX', icon: '📘' },
      { fmt: 'txt', label: 'TXT', icon: '📄' },
      { fmt: 'html', label: 'HTML', icon: '🌐' },
      { fmt: 'odt', label: 'ODT', icon: '📗' },
      { fmt: 'md', label: 'Markdown', icon: '📝' },
    ];

    formats.forEach(f => {
      const btn = document.createElement('button');
      btn.className = 'comp-dl-btn';
      btn.innerHTML = '<span style="font-size:26px">'+f.icon+'</span><span class="dl-format">'+f.label+'</span><span class="dl-size">'+formatBytes(compressedSize)+'</span>';
      btn.addEventListener('click', () => downloadCompressed(f.fmt));
      grid.appendChild(btn);
    });

    toast('Compression complete! Saved '+displaySaved+'%', 'success');

  } catch(err) {
    console.error('Compressor error:', err);
    toast('Compression failed: '+err.message, 'error');
    $('compProgress').classList.remove('show');
  } finally {
    hideLoading();
  }
}

function downloadCompressed(format) {
  const text = state.compressorText;
  if (!text) { toast('No compressed data available. Upload a file first.', 'error'); return; }

  const baseName = ($('compOutputName').value || 'compressed').trim();

  if (format === 'txt') {
    downloadBlob(new Blob([text], { type: 'text/plain' }), baseName+'.txt');
  } else if (format === 'md') {
    let md = '';
    text.split(/\n\n+/).forEach(p => {
      p = p.trim();
      if (!p) return;
      if (p.length < 60 && !p.endsWith('.') && !p.endsWith(',') && p.length > 3) {
        md += '## ' + p + '\n\n';
      } else {
        md += p + '\n\n';
      }
    });
    downloadBlob(new Blob([md], { type: 'text/markdown' }), baseName+'.md');
  } else if (format === 'html') {
    const htmlContent = '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>'+escapeHtml(baseName)+'</title><style>body{font-family:Inter,-apple-system,sans-serif;max-width:780px;margin:40px auto;padding:0 20px;line-height:1.7;color:#1a1d29}p{margin:0 0 14px}</style></head><body>'+text.split(/\n\n+/).map(p => '<p>'+escapeHtml(p)+'</p>').join('')+'</body></html>';
    downloadBlob(new Blob([htmlContent], { type: 'text/html' }), baseName+'.html');
  } else if (format === 'docx') {
    const htmlContent = '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>'+text.split(/\n\n+/).map(p => '<p>'+escapeHtml(p)+'</p>').join('')+'</body></html>';
    const blob = window.htmlDocx.asBlob(htmlContent);
    downloadBlob(blob, baseName+'.docx');
  } else if (format === 'odt') {
    const paras = text.split(/\n+/).map(p => p.trim()).filter(p => p);
    const body = paras.map(p => '<text:p>'+escapeXml(p)+'</text:p>').join('');
    const xml = '<?xml version="1.0" encoding="UTF-8"?><office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:mimetype="application/vnd.oasis.opendocument.text" office:version="1.2"><office:body><office:text>'+body+'</office:text></office:body></office:document>';
    downloadBlob(new Blob([xml], { type: 'application/vnd.oasis.opendocument.text' }), baseName+'.odt');
  } else if (format === 'pdf') {
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ unit: 'pt', format: 'a4' });
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const margin = 50;
    const maxWidth = pageWidth - margin * 2;
    let y = margin;
    pdf.setFontSize(11);
    pdf.setFont('helvetica', 'normal');
    const lines = pdf.splitTextToSize(text, maxWidth);
    for (const line of lines) {
      if (y + 16 > pageHeight - margin) { pdf.addPage(); y = margin; }
      pdf.text(line, margin, y);
      y += 16;
    }
    pdf.save(baseName+'.pdf');
  }

  toast('Downloaded '+baseName+'.'+format, 'success');
}

// ================================================================
//  MOBILE CTA BAR
// ================================================================
const mobileCtaBar = $('mobileCtaBar');
const mobileUploadBtn = $('mobileUploadBtn');
const mobileExportBtn = $('mobileExportBtn');
const mobileCompressBtn = $('mobileCompressBtn');

// Show/hide mobile CTA bar based on screen size
function updateMobileCta() {
  if (window.innerWidth <= 900) {
    mobileCtaBar.classList.add('active');
  } else {
    mobileCtaBar.classList.remove('active');
  }
}

// Initial check
updateMobileCta();
window.addEventListener('resize', updateMobileCta);

// Mobile Upload button
mobileUploadBtn.addEventListener('click', () => {
  fileInput.value = '';
  fileInput.click();
});

// Mobile Export button
mobileExportBtn.addEventListener('click', () => {
  const filename = ($('filenameInput').value || 'document').trim();
  if (!editor.innerText.trim()) {
    toast('Nothing to export', 'warning');
    return;
  }
  exportAs('pdf');
});

// Mobile Compress button
mobileCompressBtn.addEventListener('click', () => {
  showPage('compressorPage');
});

// ================================================================
//  TUTORIAL MODAL
// ================================================================
const tutorialOverlay = $('tutorialOverlay');
const tutorialCloseBtn = $('tutorialCloseBtn');
const tutorialSkipBtn = $('tutorialSkipBtn');
const tutorialStartBtn = $('tutorialStartBtn');

function showTutorial() {
  // Check if tutorial has been seen before
  if (localStorage.getItem('paraedit_tutorial_seen') === 'true') {
    return;
  }
  tutorialOverlay.classList.add('show');
}

function hideTutorial() {
  tutorialOverlay.classList.remove('show');
  localStorage.setItem('paraedit_tutorial_seen', 'true');
}

// Show tutorial on first load (with a slight delay)
setTimeout(showTutorial, 800);

// Event listeners
tutorialCloseBtn.addEventListener('click', hideTutorial);
tutorialSkipBtn.addEventListener('click', hideTutorial);
tutorialStartBtn.addEventListener('click', hideTutorial);

// Close when clicking outside modal
tutorialOverlay.addEventListener('click', e => {
  if (e.target === tutorialOverlay) {
    hideTutorial();
  }
});

// ---------- MOBILE TOGGLE ----------
$('mobileSidebarBtn').addEventListener('click', () => {
  $('sidebar').classList.toggle('mobile-open');
});

document.addEventListener('click', e => {
  if (window.innerWidth > 900) return;
  if (!$('sidebar').contains(e.target) && !$('mobileSidebarBtn').contains(e.target)) {
    $('sidebar').classList.remove('mobile-open');
  }
});

// ---------- KEYBOARD SHORTCUTS ----------
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    exportAs('pdf');
  }
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'F') {
    e.preventDefault();
    $('focusModeBtn').click();
  }
  // Escape exits compressor or closes tutorial
  if (e.key === 'Escape') {
    if ($('compressorPage').classList.contains('active')) {
      showPage('editorPage');
    }
    if ($('tutorialOverlay').classList.contains('show')) {
      hideTutorial();
    }
  }
});

// ---------- INITIAL CONTENT ----------
editor.innerHTML = '';

updateStats();
snapshot(true);

setTimeout(() => toast('Welcome to ParaEdit! Upload a document to get started.', 'success'), 600);
