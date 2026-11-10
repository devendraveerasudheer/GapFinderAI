const STORAGE_KEY = 'gapfinder-ai-workspace-v1';
const ACCOUNT_STORAGE_PREFIX = `${STORAGE_KEY}:`;
const LEGACY_MIGRATION_KEY = `${STORAGE_KEY}:migrated`;
const STOP_WORDS = new Set(('a an the and or but if then than of to in on at for from by with about as into through during before after above below up down is am are was were be been being have has had do does did can could should would will may might must this that these those it its their them they we you your our i me my he she his her what which who whom when where why how all any both each few more most other some such no nor not only own same so too very s t re ve ll d m out over under again further once here there new use used using based material materials according chapter section topic study student explain learning evaluate answer question concept'.split(/\s+/)));

const SEED_MATERIALS = [
  {
    id: 'seed-syllabus',
    name: 'Biology syllabus · Unit 3',
    ext: 'txt',
    kind: 'Syllabus',
    addedAt: 'Sample material',
    text: `Biology · Unit 3: Cell biology
Cell structure and function
Photosynthesis
Cellular respiration
Transport across membranes
Enzymes and reaction rates
`,
  },
  {
    id: 'seed-notes',
    name: 'Cell biology · Class notes',
    ext: 'txt',
    kind: 'Study notes',
    addedAt: 'Sample material',
    text: `        Cell structure and function. Cell structure and function depend on specialized organelles working together in each cell to carry out essential processes. The cell membrane controls what enters and leaves the cell. The nucleus contains genetic material and directs cell activities. Mitochondria are the main site of aerobic respiration, where energy is released from glucose.

Photosynthesis. Photosynthesis converts light energy into chemical energy stored in glucose. In plant cells, chlorophyll in the chloroplast absorbs light. Carbon dioxide and water are the raw materials, and glucose and oxygen are produced. Light intensity, carbon dioxide concentration, and temperature can limit the rate of photosynthesis.

Cellular respiration. Aerobic respiration releases energy from glucose using oxygen. It takes place mainly in the mitochondria and produces carbon dioxide and water. Anaerobic respiration releases less energy because glucose is only partially broken down.

Transport across membranes. Diffusion is the net movement of particles from a region of higher concentration to a region of lower concentration. Osmosis is the movement of water through a partially permeable membrane from a dilute solution to a more concentrated solution. Active transport moves particles against their concentration gradient and requires energy.

Enzymes and reaction rates. Enzymes are biological catalysts that speed up reactions without being used up. Each enzyme has an active site whose shape is complementary to its substrate. High temperatures can change the shape of the active site, so the substrate no longer fits. This is called denaturation.`,
  },
  {
    id: 'seed-paper',
    name: 'Biology · Practice questions',
    ext: 'txt',
    kind: 'Past paper',
    addedAt: 'Sample material',
    text: `Biology revision paper · Unit 3
Explain how temperature can affect the rate of an enzyme-controlled reaction. Your answer should refer to the active site and substrate.
Compare diffusion, osmosis, and active transport across a cell membrane.
Describe the energy conversion that occurs during photosynthesis and name the cell structure that absorbs light.
State where aerobic respiration mainly takes place and name one of its reactants.
`,
  },
];

const SEED_TOPICS = [
  { id: 'cell', name: 'Cell structure & function' },
  { id: 'photo', name: 'Photosynthesis' },
  { id: 'resp', name: 'Cellular respiration' },
  { id: 'transport', name: 'Membrane transport' },
  { id: 'enzyme', name: 'Enzymes & reaction rates' },
];

const DEFAULT_STATE = {
  studentName: 'Sam Student',
  materials: SEED_MATERIALS,
  topics: SEED_TOPICS,
  mastery: { cell: 82, photo: 48, resp: 67, transport: 58, enzyme: 39 },
  attempts: [
    { score: 68, total: 100, timestamp: Date.now() - 86400000 * 2, label: 'Topic check · Biology' },
    { score: 74, total: 100, timestamp: Date.now() - 86400000, label: 'Diagnostic · Unit 3' },
  ],
  topicHistory: [],
  planMinutes: 120,
  completedTasks: [],
  chat: [],
};

let state = loadState();
let activeEmail = '';
let activeRole = 'student';
let activeView = 'dashboard';
let authenticatedUser = null;
let authMode = 'login';
let loginRole = 'student';
let workspaceSaveTimeout;
let pendingLegacyWorkspaceMigration = '';
let currentTrackedPage = '';
let currentPageStartedAt = 0;
let pageTrackingReady = false;
let quizQuestions = [];
let quizIndex = 0;
let quizAnswers = [];
let quizSubmitted = false;
let quizLoading = false;
let quizEvaluations = [];
let groqStatus = { checked: false, serverAvailable: false, configured: false, model: '' };
let toastTimeout;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function apiMaterials() {
  return state.materials.map(({ id, name, kind, text }) => ({ id, name, kind, text }));
}

function invalidApiResponseMessage() {
  return 'The frontend received a non-JSON response instead of the GapFinder API. The Python backend is missing or not routed. For local use, start with .\\start.ps1; Vercel deployment requires a separately deployed and configured backend.';
}

async function apiRequest(path, payload, options = {}) {
  const response = await fetch(path, {
    method: options.method || 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
    credentials: 'same-origin',
    keepalive: Boolean(options.keepalive),
  });
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error(invalidApiResponseMessage());
  }
  if (!response.ok) throw new Error(result.error || `The request failed (${response.status}).`);
  return result;
}

async function apiGet(path) {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store' });
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error(invalidApiResponseMessage());
  }
  if (!response.ok) throw new Error(result.error || `The request failed (${response.status}).`);
  return result;
}

function mapApiSource(source) {
  return {
    ...source,
    material: { name: source.materialName },
    section: source.section || 'General',
  };
}

async function refreshGroqStatus() {
  try {
    const response = await fetch('/api/health');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const status = await response.json();
    groqStatus = { checked: true, serverAvailable: true, configured: Boolean(status.configured), model: status.model || '' };
  } catch (error) {
    groqStatus = { checked: true, serverAvailable: false, configured: false, model: '' };
    console.warn('Could not check the local Groq server:', error);
  }
  if (activeView === 'explain') renderView('explain');
}

function loadState(storageKey = STORAGE_KEY, fallback = DEFAULT_STATE) {
  try {
    const saved = localStorage.getItem(storageKey);
    if (!saved) return clone(fallback);
    const parsed = JSON.parse(saved);
    if (!parsed || !Array.isArray(parsed.materials) || !Array.isArray(parsed.topics)) {
      throw new Error('Saved workspace data has an unexpected format.');
    }
    return { ...clone(fallback), ...parsed };
  } catch (error) {
    console.error('Could not restore the saved workspace:', error);
    return clone(fallback);
  }
}

function readStoredWorkspace(storageKey) {
  try {
    const saved = localStorage.getItem(storageKey);
    if (!saved) return null;
    const parsed = JSON.parse(saved);
    if (!parsed || !Array.isArray(parsed.materials) || !Array.isArray(parsed.topics)) {
      throw new Error('Saved workspace data has an unexpected format.');
    }
    return parsed;
  } catch (error) {
    console.error('Could not restore a saved workspace:', error);
    return null;
  }
}

function mergeWorkspaceItems(serverItems, localItems) {
  const merged = new Map();
  for (const item of [...serverItems, ...localItems]) {
    if (item === undefined || item === null) continue;
    const key = item && typeof item === 'object' && item.id
      ? String(item.id)
      : JSON.stringify(item);
    if (!merged.has(key) || (item && typeof item === 'object' && item.id && serverItems.includes(item))) {
      merged.set(key, item);
    }
  }
  return [...merged.values()];
}

function restoreAccountWorkspace(user, serverWorkspace) {
  const accountWorkspace = readStoredWorkspace(`${ACCOUNT_STORAGE_PREFIX}${user.email}`);
  const mayImportLegacy = user.role === 'student' && !localStorage.getItem(LEGACY_MIGRATION_KEY);
  const legacyWorkspace = !accountWorkspace && mayImportLegacy
    ? readStoredWorkspace(STORAGE_KEY)
    : null;
  if (legacyWorkspace && (legacyWorkspace.materials.length || legacyWorkspace.topics.length)) {
    pendingLegacyWorkspaceMigration = user.email;
  }
  const localWorkspace = accountWorkspace || legacyWorkspace;
  if (!localWorkspace) return serverWorkspace;
  const serverHasActivity = ['materials', 'topics', 'attempts', 'topicHistory', 'chat']
    .some((key) => Array.isArray(serverWorkspace[key]) && serverWorkspace[key].length > 0);
  return {
    ...localWorkspace,
    ...serverWorkspace,
    materials: mergeWorkspaceItems(serverWorkspace.materials || [], localWorkspace.materials),
    topics: mergeWorkspaceItems(serverWorkspace.topics || [], localWorkspace.topics),
    mastery: { ...localWorkspace.mastery, ...serverWorkspace.mastery },
    attempts: mergeWorkspaceItems(serverWorkspace.attempts || [], localWorkspace.attempts || []),
    topicHistory: mergeWorkspaceItems(serverWorkspace.topicHistory || [], localWorkspace.topicHistory || []),
    completedTasks: mergeWorkspaceItems(serverWorkspace.completedTasks || [], localWorkspace.completedTasks || []),
    chat: mergeWorkspaceItems(serverWorkspace.chat || [], localWorkspace.chat || []),
    planMinutes: serverHasActivity ? serverWorkspace.planMinutes : localWorkspace.planMinutes,
  };
}

function saveState() {
  try {
    if (activeEmail) {
      localStorage.setItem(`${ACCOUNT_STORAGE_PREFIX}${activeEmail}`, JSON.stringify(state));
    }
    if (activeRole === 'student' && authenticatedUser) scheduleWorkspaceSave();
    return true;
  } catch (error) {
    console.error('Could not save the workspace:', error);
    showToast('Could not save changes on this device. Check available browser storage.');
    return false;
  }
}

function scheduleWorkspaceSave() {
  clearTimeout(workspaceSaveTimeout);
  workspaceSaveTimeout = setTimeout(() => {
    apiRequest('/api/workspace/save', { workspace: state })
      .then(() => {
        if (pendingLegacyWorkspaceMigration === activeEmail) {
          localStorage.setItem(LEGACY_MIGRATION_KEY, activeEmail);
          pendingLegacyWorkspaceMigration = '';
        }
      })
      .catch((error) => showToast(`Could not sync your workspace: ${error.message}`));
  }, 400);
}

function flushPageTime() {
  if (!pageTrackingReady || activeRole !== 'student' || !currentTrackedPage || !currentPageStartedAt) return;
  const now = Date.now();
  const seconds = Math.floor((now - currentPageStartedAt) / 1000);
  currentPageStartedAt = now;
  if (document.visibilityState !== 'visible' || seconds < 1) return;
  apiRequest('/api/activity/page', {
    page: currentTrackedPage,
    seconds: Math.min(seconds, 300),
  }, { keepalive: true }).catch((error) => {
    console.warn('Could not record study page time:', error);
  });
}

function trackPageChange(page) {
  if (activeRole !== 'student' || !authenticatedUser) return;
  flushPageTime();
  currentTrackedPage = page;
  currentPageStartedAt = document.visibilityState === 'visible' ? Date.now() : 0;
  pageTrackingReady = true;
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
}

function tokenize(text) {
  return String(text).toLowerCase().match(/[a-z0-9]+(?:['’-][a-z0-9]+)*/g)?.filter((word) => word.length > 1 && !STOP_WORDS.has(word)) || [];
}

function normalizeText(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function getChunks() {
  const chunks = [];
  state.materials.forEach((material) => {
    const pages = material.text.replace(/\r/g, '').split('\f');
    let sectionNumber = 0;
    let activeTopic = null;
    pages.forEach((pageText, pageIndex) => {
      let section = pages.length > 1 ? `Page ${pageIndex + 1}` : null;
      pageText.split(/\n+/).forEach((line) => {
        const headingMatch = line.trim().match(/^#{1,6}\s+(.+)$|^([A-Z][^.!?]{2,75})$/);
        const heading = (headingMatch?.[1] || headingMatch?.[2] || '').trim();
        if (heading && tokenize(heading).length <= 10) {
          section = heading;
          activeTopic = getBestTopic(heading) || activeTopic;
          return;
        }
        line.split(/(?<=[.!?])\s+/).map((text) => text.trim()).filter(Boolean).forEach((text) => {
          const matchedTopic = getBestTopic(text);
          if (matchedTopic) activeTopic = matchedTopic;
          if (text.length <= 20) return;
          sectionNumber += 1;
          chunks.push({
            text,
            material,
            topic: matchedTopic || activeTopic,
            section: section || `Section ${sectionNumber}`,
            page: pages.length > 1 ? pageIndex + 1 : null,
            tokens: tokenize(text),
          });
        });
      });
    });
  });
  return chunks;
}

function topicTokens(topic) {
  return tokenize(topic.name.replace(/&/g, ' and '));
}

function getBestTopic(text) {
  const words = new Set(tokenize(text));
  let best = null;
  let bestScore = 0;
  state.topics.forEach((topic) => {
    const matches = topicTokens(topic).filter((word) => words.has(word)).length;
    const score = matches / Math.max(1, topicTokens(topic).length);
    if (score > bestScore) {
      best = topic;
      bestScore = score;
    }
  });
  return bestScore >= 0.25 ? best : null;
}

function retrieve(query, count = 4) {
  const queryTokens = [...new Set(tokenize(query))];
  if (!queryTokens.length) return [];
  const chunks = getChunks();
  const documentFrequency = new Map();
  queryTokens.forEach((term) => {
    documentFrequency.set(term, chunks.filter((chunk) => chunk.tokens.includes(term)).length);
  });
  return chunks
    .map((chunk) => {
      const termCounts = new Map();
      chunk.tokens.forEach((term) => termCounts.set(term, (termCounts.get(term) || 0) + 1));
      const score = queryTokens.reduce((sum, term) => {
        const frequency = termCounts.get(term) || 0;
        if (!frequency) return sum;
        const inverseFrequency = Math.log(1 + (chunks.length - (documentFrequency.get(term) || 0) + 0.5) / ((documentFrequency.get(term) || 0) + 0.5));
        return sum + inverseFrequency * (frequency * 2.2) / (frequency + 1.2);
      }, 0)
        * Math.min(1, chunk.tokens.length / 8)
        * (chunk.material.kind === 'Study notes' ? 1.2 : chunk.material.kind === 'Syllabus' ? 0.9 : 0.72);
      return { ...chunk, score };
    })
    .filter((chunk) => chunk.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, count);
}

function citation(chunk) {
  const section = chunk.page && !chunk.section.startsWith('Page ')
    ? `Page ${chunk.page} · ${chunk.section}`
    : chunk.section;
  return `${chunk.material.name} · ${section}`;
}

function makeTopicId(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `topic-${Date.now()}`;
}

function inferTopics(text) {
  const lines = text.replace(/\f/g, '\n').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const result = [];
  const seen = new Set();
  lines.forEach((line) => {
    const heading = line.replace(/^(?:#{1,6}\s*|[-*•]\s*|\d+(?:\.\d+)*[.)]?\s*)/, '').replace(/[:—-]+$/, '').trim();
    const words = tokenize(heading);
    if (words.length < 1 || words.length > 8 || heading.length > 65) return;
    if (/\b(?:syllabus|curriculum|course outline|table of contents)\b|\bunit\s+\d+\b/i.test(heading)) return;
    const normalized = normalizeText(heading);
    if (!normalized || seen.has(normalized) || STOP_WORDS.has(normalized)) return;
    seen.add(normalized);
    result.push({ id: makeTopicId(heading), name: heading });
  });
  return result.slice(0, 15);
}

function topicMastery(topic) {
  const value = Number(state.mastery[topic.id]);
  return Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : 50;
}

function topicBand(score) {
  if (score < 55) return 'weak';
  if (score < 75) return 'medium';
  return 'strong';
}

function bandLabel(band) {
  return band === 'weak' ? 'Needs focus' : band === 'medium' ? 'Building' : 'Strong';
}

function formatDate(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toast.classList.remove('show'), 3000);
}

function getInitials(name) {
  return String(name || 'S').trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
}

function setAuthenticated(authenticated) {
  document.getElementById('login-screen').classList.toggle('hidden', authenticated);
  document.getElementById('workspace').classList.toggle('hidden', !authenticated);
  if (authenticated) {
    const initials = getInitials(state.studentName);
    document.getElementById('sidebar-avatar').textContent = initials;
    document.getElementById('top-avatar').textContent = initials;
    document.getElementById('sidebar-name').textContent = state.studentName;
    document.querySelectorAll('.teacher-only').forEach((item) => item.classList.add('hidden'));
    document.querySelectorAll('.admin-only').forEach((item) => item.classList.toggle('hidden', activeRole !== 'admin'));
    document.querySelectorAll('.student-only').forEach((item) => item.classList.toggle('hidden', activeRole !== 'student'));
    document.querySelector('.student-info span').textContent = activeRole === 'admin' ? 'Administrator' : 'Student workspace';
    if (activeRole === 'student' && !pageTrackingReady) trackPageChange(activeView);
    renderView(activeView);
  } else {
    authenticatedUser = null;
    activeEmail = '';
    currentTrackedPage = '';
    currentPageStartedAt = 0;
    pageTrackingReady = false;
  }
}

function updateNav() {
  document.querySelectorAll('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === activeView));
  const names = {
    dashboard: 'Overview', materials: 'My materials', diagnostic: 'Diagnostic quiz',
    gaps: 'Gap report', plan: 'Revision plan', explain: 'Ask your materials',
    classroom: 'Class insights', admin: 'Student activity', 'how-it-works': 'How the AI works',
  };
  document.getElementById('breadcrumb-current').textContent = names[activeView] || 'Overview';
  document.getElementById('material-count').textContent = state.materials.length;
  document.querySelector('.sidebar').classList.remove('open');
}

function renderView(view) {
  if (activeRole === 'admin' && !['admin', 'how-it-works'].includes(view)) {
    showToast('Study tools are available in student accounts.');
    return;
  }
  if (view === 'admin' && activeRole !== 'admin') {
    showToast('Student activity is restricted to administrators.');
    return;
  }
  if (activeRole === 'student' && view === 'classroom') {
    showToast('Class insights are not available in student accounts.');
    return;
  }
  const previousView = activeView;
  activeView = view;
  if (previousView !== view) trackPageChange(view);
  updateNav();
  const root = document.getElementById('view-root');
  const renderers = {
    dashboard: renderDashboard,
    materials: renderMaterials,
    diagnostic: renderDiagnostic,
    gaps: renderGaps,
    plan: renderPlan,
    explain: renderExplain,
    classroom: renderClassroom,
    admin: renderAdminDashboard,
    'how-it-works': renderHowItWorks,
  };
  root.innerHTML = (renderers[view] || renderDashboard)();
  bindViewEvents();
  if (view === 'admin' && activeRole === 'admin') loadAdminDashboard();
}

function renderDashboard() {
  const average = state.topics.length
    ? Math.round(state.topics.reduce((sum, topic) => sum + topicMastery(topic), 0) / state.topics.length)
    : 0;
  const weakCount = state.topics.filter((topic) => topicMastery(topic) < 55).length;
  const recentAttempts = state.attempts.slice(-3).reverse();
  const chartAttempts = state.attempts.slice(-6);
  const previousAttempt = chartAttempts.length > 1 ? chartAttempts[chartAttempts.length - 2] : null;
  const latestAttempt = chartAttempts[chartAttempts.length - 1];
  const change = previousAttempt && latestAttempt ? latestAttempt.score - previousAttempt.score : 0;
  const topicRows = state.topics.slice(0, 5).map((topic) => {
    const score = topicMastery(topic);
    const band = topicBand(score);
    return `<div class="topic-row">
      <span class="topic-name" title="${escapeHtml(topic.name)}">${escapeHtml(topic.name)}</span>
      <div class="mini-track"><span class="${band}" style="width:${score}%"></span></div>
      <span class="topic-percent">${score}%</span><span class="topic-status ${band}">${bandLabel(band)}</span>
    </div>`;
  }).join('');
  const activityRows = recentAttempts.length ? recentAttempts.map((attempt) => `<div class="activity-item"><span class="activity-dot"></span><span>${escapeHtml(attempt.label || 'Diagnostic quiz')}</span><span>${formatDate(attempt.timestamp)}</span></div>`).join('') : '<div class="empty-state">Your quiz activity will show up here.</div>';
  return `<div class="dashboard-hero">
    <div class="hero-content"><div class="hero-eyebrow">YOUR STUDY SPACE · BIOLOGY</div><h1>Good to see you, ${escapeHtml(state.studentName.split(' ')[0])}.</h1><p>Your materials point to ${weakCount ? `${weakCount} topic${weakCount === 1 ? '' : 's'} worth a little extra attention` : 'a solid foundation across your topics'}. Your next best step is ready.</p></div>
    <button class="hero-button" data-view="diagnostic">Start a quick check <span>→</span></button>
  </div>
  <div class="stats-grid">
    <div class="card stat-card"><div class="stat-icon lilac">▤</div><div class="stat-copy"><span>Study materials</span><b>${state.materials.length}</b><small>on this device</small></div></div>
    <div class="card stat-card"><div class="stat-icon mint">◫</div><div class="stat-copy"><span>Topics mapped</span><b>${state.topics.length}</b><small>from your syllabus</small></div></div>
    <div class="card stat-card"><div class="stat-icon amber">◎</div><div class="stat-copy"><span>Overall mastery</span><b>${average}%</b><small>across ${state.topics.length} topics</small></div></div>
    <div class="card stat-card"><div class="stat-icon rose">✦</div><div class="stat-copy"><span>Needs focus</span><b>${weakCount}</b><small>topics to prioritize</small></div></div>
  </div>
  <div class="dashboard-grid">
    <section class="card topic-card"><div class="card-header"><div><h2 class="section-title">Your topic map</h2><p class="section-subtitle">A snapshot of what feels familiar so far.</p></div><button class="link-button" data-view="gaps">Full gap report →</button></div><div class="topic-list">${topicRows || '<div class="empty-state">Add a syllabus to map your topics.</div>'}</div></section>
    <section class="card activity-card"><div class="card-header"><div><h2 class="section-title">Your progress</h2><p class="section-subtitle">Every attempt is a useful signal.</p></div><button class="link-button" data-view="diagnostic">Take quiz</button></div>
      <div class="activity-content"><div class="activity-summary"><div class="activity-ring" style="--ring:${average * 3.6}deg"><b>${average}%</b></div><div class="activity-summary-copy"><b>${average >= 70 ? 'Nice momentum!' : 'You’re building a base.'}</b><span>${state.attempts.length} saved practice attempts<br />Progress adjusts with each quiz</span></div></div>
      <div class="attempt-history"><div class="attempt-history-heading"><span>Quiz score trend</span>${latestAttempt ? `<b class="${change >= 0 ? 'trend-up' : 'trend-down'}">${chartAttempts.length > 1 ? `${change >= 0 ? '+' : ''}${change} pts` : 'First check-in'}</b>` : ''}</div>
        ${chartAttempts.length ? `<div class="attempt-bars">${chartAttempts.map((attempt) => `<div class="attempt-bar-column" title="${escapeHtml(attempt.label || 'Quiz')}: ${attempt.score}%"><span class="attempt-bar-value">${attempt.score}%</span><span class="attempt-bar" style="height:${Math.max(4, attempt.score)}%"></span><span class="attempt-bar-date">${formatDate(attempt.timestamp)}</span></div>`).join('')}</div>` : '<div class="chart-empty">Take a diagnostic quiz to start tracking improvement.</div>'}
      </div>
      <div class="activity-list">${activityRows}</div></div></section>
  </div>
  <div class="quick-grid">
    <button class="card quick-card" data-view="materials"><span class="stat-icon lilac">＋</span><span><b>Add study material</b><span>Upload notes or a past paper</span></span><span class="quick-arrow">→</span></button>
    <button class="card quick-card" data-view="plan"><span class="stat-icon amber">☷</span><span><b>View your revision plan</b><span>Put your time where it counts</span></span><span class="quick-arrow">→</span></button>
    <button class="card quick-card" data-view="explain"><span class="stat-icon mint">✧</span><span><b>Ask your materials</b><span>Get a cited explanation</span></span><span class="quick-arrow">→</span></button>
  </div>`;
}

const DEMO_CLASSROOM = {
  name: 'Biology · Unit 3',
  learners: 24,
  topics: [
    { name: 'Cell structure & function', average: 78, needFocus: 4, change: 8, misconception: 'Cell membrane vs. cell wall functions' },
    { name: 'Photosynthesis', average: 46, needFocus: 14, change: 3, misconception: 'Inputs and outputs of the reaction' },
    { name: 'Cellular respiration', average: 62, needFocus: 9, change: 6, misconception: 'Where aerobic respiration takes place' },
    { name: 'Membrane transport', average: 53, needFocus: 12, change: 2, misconception: 'Diffusion vs. osmosis' },
    { name: 'Enzymes & reaction rates', average: 41, needFocus: 16, change: 1, misconception: 'How temperature changes the active site' },
  ],
};

function renderClassroom() {
  const priorityTopics = [...DEMO_CLASSROOM.topics].sort((a, b) => b.needFocus - a.needFocus);
  const rows = priorityTopics.map((topic) => {
    const band = topicBand(topic.average);
    return `<div class="class-topic-row"><span class="class-topic-name">${escapeHtml(topic.name)}</span><div class="mini-track"><span class="${band}" style="width:${topic.average}%"></span></div><b>${topic.average}%</b><span class="class-concern">${topic.needFocus} learners</span><span class="class-misconception">${escapeHtml(topic.misconception)}</span></div>`;
  }).join('');
  const focus = priorityTopics[0];
  const average = Math.round(DEMO_CLASSROOM.topics.reduce((sum, topic) => sum + topic.average, 0) / DEMO_CLASSROOM.topics.length);
  return `<div class="page-heading"><div><div class="heading-eyebrow">TEACHER WORKSPACE · ${escapeHtml(DEMO_CLASSROOM.name.toUpperCase())}</div><h1>Class insights</h1><p>Topic-level patterns help you see where a class may benefit from a different explanation or another practice round.</p></div><span class="sample-data-badge">ILLUSTRATIVE DEMO DATA</span></div>
    <div class="report-banner"><div class="report-banner-icon">▥</div><div><b>Sample cohort · ${DEMO_CLASSROOM.learners} learners</b><p>This clearly labeled sample illustrates class reporting. Student identities and quiz answers are not exposed.</p></div></div>
    <div class="stats-grid class-stats">
      <div class="card stat-card"><div class="stat-icon lilac">♙</div><div class="stat-copy"><span>Class size</span><b>${DEMO_CLASSROOM.learners}</b><small>sample learners</small></div></div>
      <div class="card stat-card"><div class="stat-icon mint">◫</div><div class="stat-copy"><span>Topics mapped</span><b>${DEMO_CLASSROOM.topics.length}</b><small>from Unit 3 syllabus</small></div></div>
      <div class="card stat-card"><div class="stat-icon amber">◎</div><div class="stat-copy"><span>Class average</span><b>${average}%</b><small>across topic checks</small></div></div>
      <div class="card stat-card"><div class="stat-icon rose">✦</div><div class="stat-copy"><span>Top group focus</span><b>${focus.needFocus}/${DEMO_CLASSROOM.learners}</b><small>${escapeHtml(focus.name)}</small></div></div>
    </div>
    <div class="content-grid class-content"><section class="card"><div class="card-header"><div><h2 class="section-title">Topic-level understanding</h2><p class="section-subtitle">Average correct responses, learners below 55%, and the most common misconception.</p></div></div>
      <div class="class-topic-table"><div class="class-topic-head"><span>TOPIC</span><span>CLASS MASTERY</span><span>BELOW 55%</span><span>COMMON MISCONCEPTION</span></div>${rows}</div>
    </section>
    <aside><section class="card side-card"><h3>Suggested teaching focus</h3><div class="teacher-recommendation"><span class="status-dot weak"></span><b>${escapeHtml(focus.name)}</b></div><p>${focus.needFocus} of ${DEMO_CLASSROOM.learners} sample learners may benefit from revisiting: <b>${escapeHtml(focus.misconception)}</b>.</p><div class="source-note">Try a short explanation followed by a source-grounded retrieval check. Revisit the class pattern after the next quiz cycle.</div></section>
      <section class="card side-card"><h3>Privacy by design</h3><p>This demo shows aggregate sample data only. It does not expose individual student responses or combine student work across browsers.</p><div class="prototype-note">Live class analytics require authenticated teacher/student accounts and a shared, access-controlled backend.</div></section></aside>
    </div>`;
}

function renderMaterials() {
  const rows = state.materials.map((material) => {
    const ext = material.ext.toLowerCase();
    const details = material.addedAt === 'Sample material' ? 'Included with your demo workspace' : `${formatBytes(material.size || 0)} · Added ${formatDate(material.createdAt || Date.now())}`;
    return `<div class="material-row">
      <span class="file-icon ${ext}">${escapeHtml(ext.toUpperCase())}</span>
      <span class="material-info"><b title="${escapeHtml(material.name)}">${escapeHtml(material.name)}</b><span>${escapeHtml(details)}</span></span>
      <span class="material-badge">${escapeHtml(material.kind)}</span>
      <button class="remove-material" data-remove-material="${escapeHtml(material.id)}" aria-label="Remove ${escapeHtml(material.name)}" title="Remove material">×</button>
    </div>`;
  }).join('');
  return `<div class="page-heading"><div><div class="heading-eyebrow">YOUR KNOWLEDGE BASE</div><h1>My materials</h1><p>Your sources are stored on this device. Relevant excerpts are sent to Groq when you ask questions, generate a quiz, or submit answers.</p></div><div class="heading-actions"><button class="button button-primary button-sm" data-upload>＋ Add materials</button></div></div>
  <div class="content-grid">
    <div>
      <section class="card"><div class="card-header"><div><h2 class="section-title">Upload study material</h2><p class="section-subtitle">Add your syllabus first, then notes and past papers.</p></div></div>
        <div class="upload-zone" id="upload-zone"><div class="upload-icon">↑</div><b>Drop files here, or browse your device</b><p>PDF or text files · Up to 10 MB each</p><label class="upload-kind-label" for="material-kind">Material type</label><select class="select-input upload-kind" id="material-kind"><option value="auto">Auto-detect from filename</option><option value="Syllabus">Syllabus</option><option value="Study notes">Study notes</option><option value="Past paper">Past paper</option></select><button class="button button-secondary button-sm" data-upload>Choose files</button></div>
        <div class="source-note" style="margin:12px 16px 16px">Tip: Include headings or topic names in your syllabus so GapFinder can build a clearer topic map. For PDFs, text-based (not scanned) pages work best. Relevant passages and quiz answers are sent to Groq when you use AI features.</div>
      </section>
      <section class="card" style="margin-top:13px"><div class="card-header"><div><h2 class="section-title">Your library</h2><p class="section-subtitle">${state.materials.length} source${state.materials.length === 1 ? '' : 's'} available for retrieval.</p></div><button class="button button-danger button-sm" data-delete-all-materials ${state.materials.length ? '' : 'disabled'}>Delete all</button></div><div class="material-list">${rows || '<div class="empty-state">No materials yet. Add a syllabus or notes to get started.</div>'}</div></section>
    </div>
    <aside><section class="card side-card"><h3>Your topic map</h3><p>${state.topics.length} topic${state.topics.length === 1 ? '' : 's'} currently mapped. A new syllabus replaces the current map.</p>
      ${state.topics.slice(0, 6).map((topic) => `<div class="side-check"><span class="check-mark">✓</span><span>${escapeHtml(topic.name)}</span></div>`).join('') || '<p>No topics mapped yet.</p>'}
    </section>
    <section class="card side-card"><h3>How your sources are used</h3><p>GapFinder searches your materials for relevant passages before creating a quiz prompt or citing an explanation.</p><div class="source-note">Your files are processed in your browser and saved only in local browser storage. Nothing is sent to an AI service.</div></section></aside>
  </div>`;
}

function formatBytes(bytes) {
  if (!bytes) return 'Text';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildQuestions() {
  const used = new Set();
  return state.topics.map((topic) => {
    const topicChunks = retrieve(topic.name, 50)
      .filter((chunk) => chunk.topic?.id === topic.id && chunk.text.length > 35);
    const lessonChunks = topicChunks.filter((chunk) =>
      chunk.material.kind !== 'Past paper' && !/^(?:explain|compare|describe|state|list|what|how|why)\b/i.test(chunk.text.trim()),
    );
    const candidates = lessonChunks.length ? lessonChunks : topicChunks;
    let question = null;
    for (const found of candidates) {
      const normalized = normalizeText(found.text);
      if (used.has(normalized) || tokenize(found.text).length < 5) continue;
      question = generateGroundedQuestion(topic, found);
      if (question) {
        used.add(normalized);
        break;
      }
    }
    return question;
  }).filter(Boolean).slice(0, 8);
}

const ANSWER_SYNONYMS = {
  'carbon dioxide': ['co2'],
  'oxygen': ['o2'],
  'glucose': ['sugar'],
  'chloroplast': ['chloroplasts'],
  'mitochondria': ['mitochondrion'],
  'higher concentration': ['high concentration', 'greater concentration'],
  'lower concentration': ['low concentration', 'less concentration'],
  'concentration gradient': ['concentration difference', 'gradient'],
  'not used up': ['not consumed', 'remain unchanged'],
  'partially permeable': ['semi permeable', 'semipermeable'],
};

function answerGroup(label, aliases = []) {
  return { label, aliases: [label, ...(ANSWER_SYNONYMS[normalizeText(label)] || []), ...aliases] };
}

function groupsFromPhrase(phrase, limit = 4) {
  const words = [...new Set(tokenize(phrase).filter((word) => word.length > 3))];
  return words.slice(0, limit).map((word) => answerGroup(word));
}

function generateGroundedQuestion(topic, source) {
  const text = source.text.trim();
  const lower = text.toLowerCase();
  let prompt = '';
  let expected = '';
  let groups = [];

  if (/\bphotosynthesis converts\b/.test(lower) && /\binto\b/.test(lower)) {
    const output = text.match(/\bconverts\b.+?\binto\b(.+?)(?:[.!?]|$)/i)?.[1]?.trim();
    if (output) {
      prompt = 'According to your notes, what does photosynthesis convert light energy into?';
      expected = output;
      groups = [answerGroup('chemical energy', ['energy stored']), answerGroup('glucose', ['sugars'])];
    }
  } else if (/\bchlorophyll\b.*\bchloroplast/.test(lower) && /\babsorbs?\b/.test(lower)) {
    const location = text.match(/\bchlorophyll\b.+?\bin the\b(.+?)\s+absorbs?\b/i)?.[1]?.trim();
    if (location) {
      prompt = 'Where does chlorophyll absorb light, according to your study material?';
      expected = location;
      groups = [answerGroup('chloroplast')];
    }
  } else if (/\braw materials\b/.test(lower) && /\bproduced\b/.test(lower)) {
    prompt = 'What are the raw materials for photosynthesis, and what products does the source name?';
    expected = 'carbon dioxide and water; glucose and oxygen';
    groups = [
      answerGroup('carbon dioxide'),
      answerGroup('water'),
      answerGroup('glucose'),
      answerGroup('oxygen'),
    ];
  } else if (/\bnet movement of particles\b/.test(lower)) {
    prompt = 'How do your notes define diffusion? Include the direction particles move.';
    expected = 'net movement of particles from higher concentration to lower concentration';
    groups = [
      answerGroup('movement', ['move', 'transfer']),
      answerGroup('particles', ['particle']),
      answerGroup('higher concentration', ['high concentration', 'greater concentration']),
      answerGroup('lower concentration', ['low concentration', 'less concentration']),
    ];
  } else if (/\bosmosis\b/.test(lower) && /\bpartially permeable\b/.test(lower)) {
    prompt = 'What moves during osmosis, and what kind of membrane does it pass through?';
    expected = 'water moves through a partially permeable membrane';
    groups = [
      answerGroup('water'),
      answerGroup('partially permeable', ['semi permeable', 'semipermeable']),
      answerGroup('membrane'),
    ];
  } else if (/\bactive transport moves\b/.test(lower) && /\bgradient\b/.test(lower) && /\benergy\b/.test(lower)) {
    prompt = 'In active transport, how do particles move relative to their concentration gradient, and what is required?';
    expected = 'particles move against their concentration gradient and require energy';
    groups = [
      answerGroup('particles', ['particle']),
      answerGroup('against', ['against the gradient']),
      answerGroup('concentration gradient', ['gradient', 'concentration difference']),
      answerGroup('energy', ['atp']),
    ];
  } else if (/\bcell membrane controls\b/.test(lower)) {
    prompt = 'What does the cell membrane control, according to this passage?';
    expected = 'what enters and leaves the cell';
    groups = [
      answerGroup('enters', ['enter', 'go in']),
      answerGroup('leaves', ['leave', 'exit', 'go out']),
    ];
  } else if (/\bmitochondria\b/.test(lower) && /\bmain site of aerobic respiration\b/.test(lower)) {
    prompt = 'Where does aerobic respiration mainly take place?';
    expected = 'mitochondria';
    groups = [answerGroup('mitochondria')];
  } else if (/\benzymes are biological catalysts\b/.test(lower)) {
    prompt = 'What do enzymes do, and are they used up in the reaction?';
    expected = 'enzymes speed up reactions and are not used up';
    groups = [
      answerGroup('speed up', ['speed', 'faster', 'accelerate']),
      answerGroup('reactions', ['reaction']),
      answerGroup('not used up', ['not consumed', 'remain unchanged']),
    ];
  } else if (/\bactive site\b/.test(lower) && /\bsubstrate\b/.test(lower) && /\bcomplementary\b/.test(lower)) {
    prompt = 'How does the shape of an enzyme’s active site relate to its substrate?';
    expected = 'the active site has a complementary shape to the substrate';
    groups = [
      answerGroup('active site'),
      answerGroup('complementary', ['fits', 'matches']),
      answerGroup('substrate'),
    ];
  } else if (/\bhigh temperatures\b/.test(lower) && /\bactive site\b/.test(lower) && /\bdenaturation\b/.test(lower)) {
    prompt = 'What can high temperatures do to an enzyme’s active site, and what happens to the substrate?';
    expected = 'high temperature changes the active site shape so the substrate no longer fits; this is denaturation';
    groups = [
      answerGroup('change the shape', ['changes shape', 'change its shape']),
      answerGroup('substrate', ['substrates']),
      answerGroup('no longer fits', ['does not fit', 'cannot fit']),
      answerGroup('denaturation', ['denatured']),
    ];
  } else if (/\bcontains genetic material\b/.test(lower)) {
    prompt = 'Which cell structure contains the genetic material?';
    expected = 'the nucleus';
    groups = [answerGroup('nucleus')];
  } else if (/\bcell structure and function depend on\b/.test(lower)) {
    const phrase = text.match(/\bdepend on\b(.+?)(?:[.!?]|$)/i)?.[1]?.trim();
    if (phrase) {
      prompt = 'According to your notes, what do cell structure and function depend on?';
      expected = phrase;
      groups = [answerGroup('specialized'), answerGroup('organelles'), answerGroup('together', ['work together', 'working together'])];
    }
  } else if (/\breleases energy from glucose using oxygen\b/.test(lower)) {
    prompt = 'What two reactants does aerobic respiration use to release energy?';
    expected = 'glucose and oxygen';
    groups = [answerGroup('glucose'), answerGroup('oxygen')];
  } else if (/\banaerobic respiration\b/.test(lower) && /\bless energy\b/.test(lower)) {
    prompt = 'Why does anaerobic respiration release less energy, according to your notes?';
    expected = 'glucose is only partially broken down';
    groups = [answerGroup('glucose'), answerGroup('partially', ['partly']), answerGroup('broken down', ['break down'])];
  }

  if (prompt && groups.length) {
    return { topic, text: prompt, answer: expected, answerGroups: groups, source, type: 'short-answer' };
  }

  const terms = topicTokens(topic).sort((left, right) => right.length - left.length);
  const target = terms.find((term) => new RegExp(`\\b${escapeRegExp(term)}\\b`, 'i').test(text))
    || text.match(/\b[A-Za-z][A-Za-z-]{5,}\b/)?.[0];
  if (!target) return null;
  const masked = text.replace(new RegExp(`\\b${escapeRegExp(target)}\\b`, 'i'), '________');
  return {
    topic,
    text: `Complete the key idea from your source: “${masked}”`,
    answer: target.toLowerCase(),
    answerGroups: [answerGroup(target.toLowerCase())],
    source,
    type: 'cloze',
  };
}

function renderDiagnostic() {
  if (quizLoading && !quizQuestions.length) {
    return `<div class="page-heading"><div><div class="heading-eyebrow">A QUICK CHECK, JUST FOR YOU</div><h1>Building your diagnostic</h1><p>Retrieving relevant passages and asking Groq to create questions grounded in your materials.</p></div></div><section class="card quiz-card"><div class="empty-state">Searching your source material…</div></section>`;
  }
  if (!quizQuestions.length) {
    return `<div class="page-heading"><div><div class="heading-eyebrow">A QUICK CHECK, JUST FOR YOU</div><h1>Diagnostic quiz</h1><p>Questions are generated by Groq from passages retrieved from your study materials.</p></div></div>
      <section class="card quiz-card"><div class="empty-state">${state.materials.length ? 'Generate a short-answer diagnostic from your uploaded study materials. The app retrieves relevant passages first and cites the evidence for each question.' : 'Add notes or a textbook chapter before generating your source-grounded quiz.'}</div><div style="text-align:center"><button class="button button-primary button-sm" data-generate-quiz ${state.materials.length ? '' : 'disabled'}>✦ Generate my AI quiz</button></div></section>`;
  }
  if (quizSubmitted) return renderQuizResults();
  const question = quizQuestions[quizIndex];
  if (!question) return renderQuizResults();
  const answeredCount = quizAnswers.filter((answer) => answer.trim()).length;
  return `<div class="page-heading"><div><div class="heading-eyebrow">A QUICK CHECK, JUST FOR YOU</div><h1>Diagnostic quiz</h1><p>Each prompt is generated from a passage in your materials. Take your best shot—this is for learning, not grading.</p></div><button class="button button-secondary button-sm" data-new-quiz>↻ New quiz</button></div>
  <div class="quiz-layout"><section class="card quiz-card">
    <div class="quiz-progress-head"><span>Question ${quizIndex + 1} of ${quizQuestions.length}</span><b>${answeredCount} answered</b></div>
    <div class="quiz-progress-track"><span style="width:${((quizIndex + 1) / quizQuestions.length) * 100}%"></span></div>
    <div class="question-label">${question.type === 'cloze' ? 'Complete the idea from your source' : 'Explain the source idea in your own words'}</div>
    <h2>${escapeHtml(question.text)}</h2>
    <p class="quiz-instruction">Use your own words. Groq will evaluate your answer against the retrieved source passage.</p>
    <span class="question-topic">${escapeHtml(question.topic.name)}</span>
    <textarea id="quiz-answer" class="quiz-answer" placeholder="Type your answer here…" aria-label="Your answer">${escapeHtml(quizAnswers[quizIndex] || '')}</textarea>
    <div class="quiz-actions"><span class="quiz-hint">Grounded in: ${escapeHtml(citation(question.source))}</span><button class="button button-primary button-sm" id="quiz-next" ${quizLoading ? 'disabled' : ''}>${quizLoading ? 'Evaluating…' : quizIndex === quizQuestions.length - 1 ? 'See my results' : 'Next question'} <span>→</span></button></div>
  </section>
  <aside class="card quiz-side"><h3>In this check</h3><p>${quizQuestions.length} source-based prompt${quizQuestions.length === 1 ? '' : 's'} across your mapped topics.</p>
    ${quizQuestions.map((item, index) => `<div class="quiz-topic-item"><span class="status-dot ${quizAnswers[index] ? '' : 'medium'}"></span><span>${escapeHtml(item.topic.name)}</span><span>${quizAnswers[index] ? 'Answered' : index === quizIndex ? 'In progress' : 'Up next'}</span></div>`).join('')}
    <div class="source-chip"><span>✦</span><span><b>Source-based</b><br />Each question links back to a retrieved passage in your library.</span></div>
  </aside></div>`;
}

function evaluateAnswer(answer, question) {
  const response = normalizeText(answer);
  if (!response) return { score: 0, matched: [], missing: question.answerGroups.map((group) => group.label), isCorrect: false };
  const matched = [];
  const missing = [];
  question.answerGroups.forEach((group) => {
    const found = group.aliases.some((alias) => {
      const phrase = normalizeText(alias);
      return phrase && ` ${response} `.includes(` ${phrase} `);
    });
    (found ? matched : missing).push(group.label);
  });
  const score = Math.round((matched.length / Math.max(1, question.answerGroups.length)) * 100);
  return { score, matched, missing, isCorrect: score >= 70 && matched.length > 0 };
}

function renderQuizResults() {
  const evaluations = quizEvaluations.length
    ? quizEvaluations
    : quizQuestions.map(() => ({ score: 0, matched: [], missing: [], isCorrect: false, feedback: 'No evaluation is available.' }));
  const score = evaluations.length ? Math.round(evaluations.reduce((sum, evaluation) => sum + evaluation.score, 0) / evaluations.length) : 0;
  const topicResults = quizQuestions.map((question, index) => {
    const evaluation = evaluations[index];
    const source = evaluation.source || question.source;
    return `<div class="result-topic"><div class="result-topic-headline"><span>${escapeHtml(question.topic.name)}</span><b>${evaluation.score}% · ${evaluation.isCorrect ? 'On track' : 'Review'}</b></div><p class="result-topic-feedback">${escapeHtml(evaluation.feedback)}${evaluation.missing.length ? ` Still to review: ${escapeHtml(evaluation.missing.join(', '))}.` : ''} Source excerpt: “${escapeHtml(source.text.slice(0, 115))}${source.text.length > 115 ? '…' : ''}”</p><span class="result-topic-citation">↳ ${escapeHtml(citation(source))}</span></div>`;
  }).join('');
  return `<div class="page-heading"><div><div class="heading-eyebrow">YOUR CHECK-IN IS COMPLETE</div><h1>Every answer tells you something.</h1><p>Your report highlights what to revisit next—use it to tune your plan.</p></div></div>
  <section class="card quiz-results"><div class="result-score">${score}%</div><h2>${score >= 75 ? 'A strong check-in.' : score >= 45 ? 'A useful place to start.' : 'Now you know where to begin.'}</h2><p>Groq evaluated your answers against the retrieved evidence and question rubrics. Each topic’s mastery estimate has been updated.</p>
    <div class="result-topics">${topicResults}</div><div class="heading-actions" style="justify-content:center"><button class="button button-primary button-sm" data-view="gaps">See my updated gap report →</button><button class="button button-secondary button-sm" data-view="plan">Open revision plan</button></div>
  </section>`;
}

function renderGaps() {
  const weak = state.topics.filter((topic) => topicMastery(topic) < 55).length;
  const rows = [...state.topics].sort((a, b) => topicMastery(a) - topicMastery(b)).map((topic) => {
    const score = topicMastery(topic);
    const band = topicBand(score);
    const supporting = retrieve(topic.name, 1)[0];
    const latestSignal = [...state.topicHistory].reverse().find((item) => item.topicId === topic.id);
    let reason = score < 55
      ? 'Your recent check-ins suggest this concept needs another pass.'
      : score < 75
        ? 'You have some of the idea; another retrieval practice can help make it stick.'
        : 'Your recent answers suggest you can recall this idea with confidence.';
    if (latestSignal) {
      reason = `Latest check-in: ${latestSignal.score}% on this topic.`;
      if (latestSignal.missing.length) reason += ` Still to review: ${latestSignal.missing.join(', ')}.`;
      else reason += ' You recalled all the key ideas checked.';
    }
    if (supporting) reason += ` Source coverage found in ${supporting.material.name}.`;
    const evidence = supporting
      ? `<div class="report-evidence"><b>Source</b><span>“${escapeHtml(supporting.text.slice(0, 150))}${supporting.text.length > 150 ? '…' : ''}” · ${escapeHtml(citation(supporting))}</span></div>`
      : '';
    return `<div class="report-topic"><div class="report-topic-head"><span class="status-dot ${band}"></span><b>${escapeHtml(topic.name)}</b><span class="report-score">${score}%</span></div><p class="report-reason">${escapeHtml(reason)}</p>${evidence}</div>`;
  }).join('');
  return `<div class="page-heading"><div><div class="heading-eyebrow">YOUR KNOWLEDGE, MADE VISIBLE</div><h1>Gap report</h1><p>A transparent snapshot of your topic-level progress and what informed it.</p></div><button class="button button-primary button-sm" data-view="plan">Build my revision plan →</button></div>
  <div class="report-banner"><div class="report-banner-icon">✦</div><div><b>${weak ? `${weak} topic${weak === 1 ? '' : 's'} to prioritize in your next study session` : 'Your topic map is looking balanced'}</b><p>Estimates update after each diagnostic quiz. They’re learning signals—not grades.</p></div></div>
  <div class="content-grid"><section class="card"><div class="card-header"><div><h2 class="section-title">Topic-by-topic breakdown</h2><p class="section-subtitle">Sorted by current mastery estimate, lowest first.</p></div></div><div class="report-list">${rows || '<div class="empty-state">Add a syllabus to map your topics.</div>'}</div></section>
    <aside><section class="card side-card"><h3>At a glance</h3><div class="report-side-stat"><b>${weak}</b><span>topics need focus</span></div><div class="report-side-stat"><b>${state.topics.filter((topic) => topicMastery(topic) >= 55 && topicMastery(topic) < 75).length}</b><span>topics are building</span></div><div class="report-side-stat"><b>${state.topics.filter((topic) => topicMastery(topic) >= 75).length}</b><span>topics feel strong</span></div><div class="legend"><div class="legend-item"><span class="status-dot weak"></span>Needs focus · below 55%</div><div class="legend-item"><span class="status-dot medium"></span>Building · 55–74%</div><div class="legend-item"><span class="status-dot"></span>Strong · 75% and above</div></div></section>
    <section class="card side-card"><h3>Where these scores come from</h3><p>Each quiz answer is linked to its topic and source passage. Correct and incorrect answers nudge that topic’s mastery estimate over time.</p><div class="source-note">Current prototype uses a simple rolling estimate, not a standardized or predictive assessment.</div></section></aside>
  </div>`;
}

function planItems() {
  const totalMinutes = Math.max(15, Math.min(600, Number(state.planMinutes) || 120));
  const topics = [...state.topics].sort((a, b) => topicMastery(a) - topicMastery(b));
  if (!topics.length) return [];
  const weights = topics.map((topic) => Math.max(0.25, 100 - topicMastery(topic)));
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
  const blocks = Math.floor(totalMinutes / 5);
  const allocations = weights.map((weight) => (blocks * weight) / weightTotal);
  const assignedBlocks = allocations.map(Math.floor);
  let remainingBlocks = blocks - assignedBlocks.reduce((sum, amount) => sum + amount, 0);
  const remainderOrder = allocations
    .map((amount, index) => ({ index, fraction: amount - Math.floor(amount) }))
    .sort((left, right) => right.fraction - left.fraction);
  for (let index = 0; index < remainingBlocks; index += 1) {
    assignedBlocks[remainderOrder[index].index] += 1;
  }
  return topics.map((topic, index) => {
    const band = topicBand(topicMastery(topic));
    const minutes = assignedBlocks[index] * 5;
    const source = retrieve(topic.name, 1)[0];
    const activity = band === 'weak'
      ? 'Review the cited passage, then explain the key idea from memory.'
      : band === 'medium'
        ? 'Try a short retrieval check, then correct your notes from the source.'
        : 'Spend a few minutes on spaced recall to keep this topic fresh.';
    return { topic, band, minutes, source, activity, id: topic.id };
  }).filter((item) => item.minutes > 0);
}

function renderPlan() {
  const items = planItems();
  const total = items.reduce((sum, item) => sum + item.minutes, 0);
  const completed = state.completedTasks.filter((id) => items.some((item) => item.id === id)).length;
  const rows = items.map((item, index) => {
    const done = state.completedTasks.includes(item.id);
    const label = item.band === 'weak' ? 'Priority' : item.band === 'medium' ? 'Build' : 'Maintain';
    const sourceText = item.source ? `Start with ${item.source.material.name}.` : 'Add source notes to ground this activity.';
    return `<div class="plan-item ${item.band}"><div class="plan-step">${done ? '✓' : String(index + 1).padStart(2, '0')}</div><div class="plan-copy"><b>${escapeHtml(item.topic.name)}</b><p>${escapeHtml(item.activity)} ${escapeHtml(sourceText)}</p><div class="plan-meta"><span class="priority ${item.band === 'medium' ? 'medium' : item.band === 'strong' ? 'low' : ''}">${label}</span><span>◷ ${item.minutes} min</span><span>${topicMastery(item.topic)}% mastery</span></div></div><button class="plan-done ${done ? 'completed' : ''}" data-complete="${escapeHtml(item.id)}">${done ? 'Done ✓' : 'Mark done'}</button></div>`;
  }).join('');
  return `<div class="page-heading"><div><div class="heading-eyebrow">A PLAN THAT MOVES WITH YOU</div><h1>Your revision plan</h1><p>Lower-confidence topics come first. New quiz results reshuffle your next steps.</p></div><button class="button button-secondary button-sm" data-view="diagnostic">↻ Update with a quiz</button></div>
  <div class="plan-summary"><div class="card plan-summary-item"><span>Available study time</span><b><input id="plan-hours" type="number" min="0.25" max="10" step="0.25" value="${(Number(state.planMinutes) / 60).toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}" aria-label="Available study time in hours" /> hrs</b></div><div class="card plan-summary-item"><span>Planned revision</span><b>${total} min</b></div><div class="card plan-summary-item"><span>Steps completed</span><b>${completed} / ${items.length}</b></div></div>
  <div class="content-grid"><section class="card"><div class="card-header"><div><h2 class="section-title">Your next study session</h2><p class="section-subtitle">Start at the top, or choose the amount of time you have.</p></div></div><div class="plan-list">${rows || '<div class="empty-state">Add syllabus topics to create a revision plan.</div>'}</div></section>
  <aside><section class="card side-card"><h3>Why this order?</h3><p>Topics are ordered by your latest mastery estimate. Lower scores receive more of the available study time.</p><div class="source-note">A quiz updates these estimates, so your next plan can change as you improve.</div></section><div class="plan-adjust"><b>Make it yours.</b> Adjust your available time above. The suggested minutes are a guide; take breaks and move at your own pace.</div></aside></div>`;
}

function formatDuration(seconds = 0) {
  const minutes = Math.floor(Math.max(0, seconds) / 60);
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return hours ? `${hours}h ${remainingMinutes}m` : `${minutes}m`;
}

function renderAdminDashboard() {
  return `<div class="page-heading"><div><div class="heading-eyebrow">AUTHORIZED ADMIN · STUDENT PROGRESS</div><h1>Student activity</h1><p>Transparent learning activity for the last 10 days. Chat messages, quiz answers, and uploaded files are not included.</p></div><button class="button button-secondary button-sm" data-refresh-admin>↻ Refresh</button></div>
    <div class="report-banner"><div class="report-banner-icon">▤</div><div><b>Privacy-respecting monitoring</b><p>Students are informed at registration. This report contains account/session times, active page time, and quiz scores and topic gaps only.</p></div></div>
    <section class="card admin-report-card"><div class="card-header"><div><h2 class="section-title">Student overview</h2><p class="section-subtitle">Activity is automatically deleted after 10 days.</p></div></div><div id="admin-students" class="admin-students"><div class="empty-state">Loading student activity…</div></div></section>`;
}

function renderAdminStudents(students) {
  if (!students.length) return '<div class="empty-state">No student accounts have registered yet.</div>';
  return `<div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>Student</th><th>Last login</th><th>Sessions</th><th>Study time</th><th>Quizzes</th><th>Average</th><th>Latest quiz</th></tr></thead><tbody>${students.map((student) => {
    const topicRows = (student.latestTopics || []).map((topic) =>
      `<span class="admin-topic-chip">${escapeHtml(topic.name)} · ${topic.score}%</span>`,
    ).join('');
    const pageRows = Object.entries(student.pageSeconds || {}).map(([page, seconds]) =>
      `<span class="admin-topic-chip">${escapeHtml(page)} · ${formatDuration(seconds)}</span>`,
    ).join('');
    const lastLogin = student.lastLoginAt
      ? new Date(student.lastLoginAt * 1000).toLocaleString()
      : 'No login yet';
    const latestScore = student.latestQuizScore === null ? '—' : `${student.latestQuizScore}%`;
    return `<tr><td><b>${escapeHtml(student.name)}</b><span>${escapeHtml(student.email)}</span></td><td>${escapeHtml(lastLogin)}</td><td>${student.loginCount}</td><td>${formatDuration(student.activeSeconds)}</td><td>${student.quizCount}</td><td>${student.averageQuizScore === null ? '—' : `${student.averageQuizScore}%`}</td><td>${latestScore}</td></tr><tr class="admin-details-row"><td colspan="7"><b>Time by page:</b> ${pageRows || 'No page activity recorded'}<br /><b>Latest topic results:</b> ${topicRows || 'No quiz results yet'}</td></tr>`;
  }).join('')}</tbody></table></div>`;
}

async function loadAdminDashboard() {
  const target = document.getElementById('admin-students');
  if (!target) return;
  target.innerHTML = '<div class="empty-state">Loading student activity…</div>';
  try {
    const result = await apiGet('/api/admin/students');
    if (activeRole === 'admin' && activeView === 'admin') {
      const currentTarget = document.getElementById('admin-students');
      if (currentTarget) currentTarget.innerHTML = renderAdminStudents(result.students || []);
    }
  } catch (error) {
    const currentTarget = document.getElementById('admin-students');
    if (currentTarget) currentTarget.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
  }
}

function renderExplain() {
  const messages = state.chat.map((message) => `<div class="chat-message ${message.role === 'user' ? 'user' : 'assistant'}">${escapeHtml(message.text).replace(/\n/g, '<br>')}${message.citation ? `<span class="chat-citation">↳ ${escapeHtml(message.citation)}</span>` : ''}</div>`).join('');
  let suggestionsMarkup = '';
  if (!messages) {
    const suggestions = [...new Map(getChunks()
      .map((chunk) => chunk.topic?.name || chunk.section)
      .filter((name) => name && !/^(?:Page|Section)\s+\d+$/i.test(name))
      .map((name) => [normalizeText(name), name]))
      .values()]
      .slice(0, 3)
      .map((topic) => {
        const question = `Explain ${topic}`;
        return `<button class="suggestion-chip" data-suggestion="${escapeHtml(question)}">${escapeHtml(question)}</button>`;
      })
      .join('');
    suggestionsMarkup = suggestions
      ? `<div class="chat-empty">Try asking about your materials:<br>${suggestions}</div>`
      : '<div class="chat-empty">Upload study materials to get topic suggestions here.</div>';
  }
  const groqLabel = !groqStatus.checked
    ? 'Checking Groq connection…'
    : !groqStatus.serverAvailable
      ? 'Start the local server to connect'
      : groqStatus.configured
        ? `Groq · ${groqStatus.model}`
        : 'Groq needs an API key';
  return `<div class="page-heading"><div><div class="heading-eyebrow">ANSWERS GROUNDED IN YOUR LIBRARY</div><h1>Ask your materials</h1><p>Ask about a topic in your notes and get an explanation tied to the source passages.</p></div></div>
  <div class="explain-layout"><section class="card chat-panel"><div class="chat-header"><div class="chat-ai-icon">✧</div><div><b>Study companion</b><span>${escapeHtml(groqLabel)}</span></div><span class="source-only">GROUNDED RAG</span><button class="button button-secondary button-sm chat-clear" type="button" data-clear-chat ${state.chat.length ? '' : 'disabled'}>Clear chat</button></div>
    <div class="chat-messages" id="chat-messages">${messages || `<div class="chat-message assistant">Hi ${escapeHtml(state.studentName.split(' ')[0])}! Ask me to explain a topic from your materials. I’ll search your sources first and include a citation for any passage I use.</div>${suggestionsMarkup}`}</div>
    <form class="chat-form" id="chat-form"><input id="chat-input" type="text" placeholder="Ask about a topic in your materials…" autocomplete="off" required aria-label="Ask about your materials" /><button class="button button-primary" type="submit" aria-label="Send question">↑</button></form>
  </section>
  <aside><section class="card side-card"><h3>How the answer is built</h3><div class="process-step"><span class="process-number">1</span><div><b>Retrieve</b><p>The local server chunks your materials and ranks the passages relevant to your question.</p></div></div><div class="process-step"><span class="process-number">2</span><div><b>Ground</b><p>Only the retrieved evidence is sent to Groq with instructions to cite it and abstain when unsupported.</p></div></div><div class="process-step"><span class="process-number">3</span><div><b>Respond</b><p>Groq generates an explanation; the app displays citations from the source metadata.</p></div></div><div class="prototype-note">${groqStatus.checked && !groqStatus.serverAvailable ? 'Start the app with .\\start.ps1 to connect the local server.' : groqStatus.checked && !groqStatus.configured ? 'Groq is not configured. Copy .env.example to .env and set GROQ_API_KEY on this computer.' : 'Retrieved excerpts are sent to Groq to generate answers. Your API key stays on this local server.'}</div></section>
  <section class="card side-card"><h3>Need more sources?</h3><p>Explanations can only cover what’s in your study library.</p><button class="link-button" style="margin-top:10px" data-view="materials">Add notes or a textbook chapter →</button></section></aside></div>`;
}

function renderHowItWorks() {
  return `<div class="page-heading"><div><div class="heading-eyebrow">TRANSPARENT BY DESIGN</div><h1>How the AI works</h1><p>Retrieval and generation are separate steps. Each result can be traced back to your material.</p></div><button class="button button-secondary button-sm" data-view="dashboard">← Back to overview</button></div>
  <div class="content-grid"><section class="card">
    <div class="card-header"><div><h2 class="section-title">From your files to a focused next step</h2><p class="section-subtitle">Groq-powered generation with local, source-aware retrieval.</p></div></div>
    <div class="report-list">
      <div class="report-topic"><div class="report-topic-head"><span class="status-dot"></span><b>1 · Retrieval — find relevant evidence</b></div><p class="report-reason">The local Python server splits text into bounded chunks, retains material/section/page metadata, and ranks passages against a question or topic using lexical relevance. Only the highest-ranked evidence is selected.</p></div>
      <div class="report-topic"><div class="report-topic-head"><span class="status-dot medium"></span><b>2 · Grounded generation — create a quiz or answer</b></div><p class="report-reason">The server sends the retrieved excerpts—not the whole library—to Groq with instructions to use only that evidence. Groq generates cited explanations and diagnostic questions with source-based rubrics. Unsupported questions are omitted.</p></div>
      <div class="report-topic"><div class="report-topic-head"><span class="status-dot weak"></span><b>3 · Evaluation — explain what matched</b></div><p class="report-reason">Groq evaluates each response against the question rubric and retrieved source, accepts equivalent wording, assigns partial credit, and explains the missing ideas. Scores update the corresponding topic’s mastery estimate.</p></div>
      <div class="report-topic"><div class="report-topic-head"><span class="status-dot weak"></span><b>4 · Diagnosis — turn answers into topic signals</b></div><p class="report-reason">Each answer updates its topic’s rolling mastery estimate. Attempt-level feedback records which ideas were recalled or missed, so the gap report can explain what to revisit and the revision plan can prioritize it.</p></div>
      <div class="report-topic"><div class="report-topic-head"><span class="status-dot"></span><b>5 · Revision — adapt to your available time</b></div><p class="report-reason">The revision plan distributes your selected time across topics in proportion to their estimated learning gaps. A later quiz can change the topic order and time allocation.</p></div>
    </div>
  </section><aside><section class="card side-card"><h3>Where retrieval and generation are kept separate</h3><p>Retrieval runs on the local server. Only selected evidence is passed to the Groq LLM; the Groq API key is read from the server’s environment and never sent to the browser. If no relevant evidence is found, the app abstains.</p><div class="prototype-note">When you ask a question or generate/evaluate a quiz, retrieved text and your answers are sent to Groq. Avoid uploading sensitive information.</div></section>
  <section class="card side-card"><h3>Local demo privacy</h3><p>Demo workspaces are stored in browser local storage. The Python server does not save uploaded document text; it processes each API request in memory.</p><p>PDF text extraction stays in the browser. Scanned PDFs are not OCR'd.</p></section></aside></div>`;
}

function bindViewEvents() {
  document.querySelectorAll('[data-view]').forEach((button) => {
    button.addEventListener('click', () => renderView(button.dataset.view));
  });
  document.querySelectorAll('[data-delete-all-materials]').forEach((button) => {
    button.addEventListener('click', removeAllMaterials);
  });
  document.querySelectorAll('[data-upload]').forEach((button) => {
    button.addEventListener('click', () => document.getElementById('file-input').click());
  });
  document.querySelectorAll('[data-remove-material]').forEach((button) => {
    button.addEventListener('click', () => removeMaterial(button.dataset.removeMaterial));
  });
  document.querySelectorAll('[data-new-quiz]').forEach((button) => {
    button.addEventListener('click', () => {
      generateQuiz();
    });
  });
  document.querySelectorAll('[data-generate-quiz]').forEach((button) => {
    button.addEventListener('click', generateQuiz);
  });
  const zone = document.getElementById('upload-zone');
  if (zone) {
    zone.addEventListener('dragover', (event) => {
      event.preventDefault();
      zone.classList.add('drag-over');
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', (event) => {
      event.preventDefault();
      zone.classList.remove('drag-over');
      handleFiles([...event.dataTransfer.files]);
    });
  }
  const quizNext = document.getElementById('quiz-next');
  if (quizNext) {
    quizNext.addEventListener('click', () => {
      quizAnswers[quizIndex] = document.getElementById('quiz-answer').value.trim();
      if (quizIndex < quizQuestions.length - 1) {
        quizIndex += 1;
        renderView('diagnostic');
      } else {
        finishQuiz();
      }
    });
  }
  const planHours = document.getElementById('plan-hours');
  if (planHours) {
    planHours.addEventListener('change', () => {
      const hours = Number(planHours.value);
      if (!Number.isFinite(hours) || hours <= 0 || hours > 10) {
        showToast('Choose a study time greater than 0 and no more than 10 hours.');
        planHours.value = (Number(state.planMinutes) / 60).toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
        return;
      }
      state.planMinutes = Math.max(15, Math.round((hours * 60) / 5) * 5);
      state.completedTasks = [];
      saveState();
      renderView('plan');
    });
  }
  document.querySelectorAll('[data-complete]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = button.dataset.complete;
      state.completedTasks = state.completedTasks.includes(id)
        ? state.completedTasks.filter((taskId) => taskId !== id)
        : [...state.completedTasks, id];
      saveState();
      renderView('plan');
    });
  });
  document.querySelectorAll('[data-suggestion]').forEach((button) => {
    button.addEventListener('click', () => {
      document.getElementById('chat-input').value = button.dataset.suggestion;
      document.getElementById('chat-form').requestSubmit();
    });
  });
  const chatForm = document.getElementById('chat-form');
  if (chatForm) chatForm.addEventListener('submit', submitChat);
  const clearChat = document.querySelector('[data-clear-chat]');
  if (clearChat) {
    clearChat.addEventListener('click', () => {
      state.chat = [];
      saveState();
      renderView('explain');
      showToast('Chat history cleared.');
    });
  }
  const refreshAdmin = document.querySelector('[data-refresh-admin]');
  if (refreshAdmin) refreshAdmin.addEventListener('click', loadAdminDashboard);
}

async function generateQuiz() {
  if (quizLoading) return;
  quizLoading = true;
  quizQuestions = [];
  quizAnswers = [];
  quizEvaluations = [];
  quizSubmitted = false;
  if (activeView === 'diagnostic') renderView('diagnostic');
  try {
    const result = await apiRequest('/api/quiz', {
      materials: apiMaterials(),
      topics: state.topics.map(({ id, name }) => ({ id, name })),
    });
    quizQuestions = result.questions.map((question) => ({
      ...question,
      source: mapApiSource(question.source),
    }));
    quizAnswers = Array(quizQuestions.length).fill('');
    quizIndex = 0;
  } catch (error) {
    showToast(error.message || 'Could not generate the quiz.');
  } finally {
    quizLoading = false;
    if (activeView === 'diagnostic') renderView('diagnostic');
  }
}

async function finishQuiz() {
  if (quizLoading) return;
  quizLoading = true;
  if (activeView === 'diagnostic') renderView('diagnostic');
  let evaluations;
  try {
    const result = await apiRequest('/api/evaluate', {
      materials: apiMaterials(),
      answers: quizQuestions.map((question, index) => ({
        topicName: question.topic.name,
        question: question.text,
        answer: quizAnswers[index] || '',
        answerGroups: question.answerGroups,
        sourceId: question.source.id,
      })),
    });
    evaluations = result.evaluations.map((evaluation) => ({
      ...evaluation,
      source: mapApiSource(evaluation.source),
    }));
  } catch (error) {
    quizLoading = false;
    if (activeView === 'diagnostic') renderView('diagnostic');
    showToast(error.message || 'Could not evaluate quiz answers. Your answers are still available to retry.');
    return;
  }
  quizLoading = false;
  quizEvaluations = evaluations;
  const byTopic = new Map();
  quizQuestions.forEach((question, index) => {
    const scores = byTopic.get(question.topic.id) || [];
    scores.push(evaluations[index].score);
    byTopic.set(question.topic.id, scores);
  });
  byTopic.forEach((scores, id) => {
    const current = Number(state.mastery[id]) || 50;
    const attemptScore = scores.reduce((sum, value) => sum + value, 0) / scores.length;
    state.mastery[id] = Math.round(current * 0.65 + attemptScore * 0.35);
  });
  const topicResults = quizQuestions.map((question, index) => ({
    topicId: question.topic.id,
    topicName: question.topic.name,
    score: evaluations[index].score,
    answer: quizAnswers[index] || '',
    matched: evaluations[index].matched,
    missing: evaluations[index].missing,
    feedback: evaluations[index].feedback,
    citation: citation(evaluations[index].source),
    excerpt: evaluations[index].source.text,
  }));
  const totalScore = evaluations.length
    ? Math.round(evaluations.reduce((sum, evaluation) => sum + evaluation.score, 0) / evaluations.length)
    : 0;
  try {
    await apiRequest('/api/activity/quiz', {
      score: totalScore,
      topics: topicResults.map((item) => ({ name: item.topicName, score: item.score })),
    });
  } catch (error) {
    showToast(`Quiz finished, but activity could not be synced: ${error.message}`);
  }
  const timestamp = Date.now();
  state.attempts.push({
    score: totalScore,
    total: 100,
    timestamp,
    label: 'Diagnostic · Study check',
    topics: topicResults.map(({ topicId, topicName, score }) => ({ topicId, topicName, score })),
  });
  state.attempts = state.attempts.slice(-30);
  state.topicHistory = [...state.topicHistory, ...topicResults.map((item) => ({ ...item, timestamp }))].slice(-100);
  state.completedTasks = [];
  saveState();
  quizSubmitted = true;
  if (activeView === 'diagnostic') renderView('diagnostic');
}

async function submitChat(event) {
  event.preventDefault();
  const input = document.getElementById('chat-input');
  const query = input.value.trim();
  if (!query) return;
  const history = state.chat.slice(-6).map(({ role, text }) => ({ role, text }));
  state.chat.push({ role: 'user', text: query });
  const assistantMessage = { role: 'assistant', text: 'Searching your materials and asking Groq…' };
  state.chat.push(assistantMessage);
  state.chat = state.chat.slice(-20);
  saveState();
  if (activeView === 'explain') renderView('explain');
  const formInput = document.getElementById('chat-input');
  if (formInput) formInput.disabled = true;
  try {
    const result = await apiRequest('/api/chat', {
      question: query,
      history,
      materials: apiMaterials(),
    });
    assistantMessage.text = result.answer;
    assistantMessage.citation = (result.sources || [])
      .map((source) => `[S${source.sourceNumber}] ${source.citation}`)
      .join(' · ');
    if (assistantMessage.citation && !/\[S\d+\]/.test(assistantMessage.text)) {
      assistantMessage.text += `\n\nSources: ${(result.sources || []).map((source) => `[S${source.sourceNumber}]`).join(', ')}`;
    }
  } catch (error) {
    assistantMessage.text = `I couldn’t complete the grounded answer: ${error.message}`;
    assistantMessage.citation = '';
  }
  const messageIndex = state.chat.indexOf(assistantMessage);
  if (messageIndex >= 0) state.chat[messageIndex] = assistantMessage;
  state.chat = state.chat.slice(-20);
  saveState();
  if (activeView === 'explain') renderView('explain');
  const messages = document.getElementById('chat-messages');
  if (messages) messages.scrollTop = messages.scrollHeight;
}

async function loadPdfText(file) {
  if (!window.pdfjsLib) {
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
      script.onload = resolve;
      script.onerror = () => reject(new Error('Could not load the PDF text reader. Check your internet connection and try again.'));
      document.head.appendChild(script);
    });
  }
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  const pdf = await window.pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  const pages = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const lines = [];
    let currentLine = '';
    let previousY = null;
    content.items.forEach((item) => {
      if (typeof item.str !== 'string' || !item.str.trim()) return;
      const y = Array.isArray(item.transform) ? Number(item.transform[5]) : null;
      if (currentLine && Number.isFinite(y) && previousY !== null && Math.abs(y - previousY) > 3) {
        lines.push(currentLine.trim());
        currentLine = '';
      }
      currentLine += `${currentLine ? ' ' : ''}${item.str.trim()}`;
      if (Number.isFinite(y)) previousY = y;
    });
    if (currentLine) lines.push(currentLine.trim());
    pages.push(lines.join('\n'));
  }
  const text = pages.join('\f');
  if (text.trim().length < 20) throw new Error('This PDF has no selectable text. Scanned PDFs are not supported in this demo.');
  return text;
}

async function handleFiles(files) {
  if (!files.length) return;
  for (const file of files) {
    if (file.size > 10 * 1024 * 1024) {
      showToast(`${file.name} is larger than the 10 MB limit.`);
      continue;
    }
    const ext = file.name.split('.').pop().toLowerCase();
    if (!['pdf', 'txt', 'md', 'markdown'].includes(ext)) {
      showToast(`${file.name}: choose a PDF or text file.`);
      continue;
    }
    try {
      const text = ext === 'pdf' ? await loadPdfText(file) : await file.text();
      if (text.trim().length < 20) throw new Error('This file does not contain enough readable text.');
      const selectedKind = document.getElementById('material-kind')?.value || 'auto';
      const kind = classifyMaterial(file.name, selectedKind);
      const material = {
        id: `upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: file.name,
        ext: ext === 'markdown' ? 'md' : ext,
        kind,
        size: file.size,
        createdAt: Date.now(),
        text: text.slice(0, 500000),
      };
      state.materials.push(material);
      let uploadMessage = `${file.name} added to your library.`;
      if (kind === 'Syllabus') {
        const inferred = inferTopics(text);
        if (inferred.length) {
          state.topics = inferred;
          inferred.forEach((topic) => {
            if (!(topic.id in state.mastery)) state.mastery[topic.id] = 50;
          });
          state.completedTasks = [];
        } else {
          uploadMessage = 'Syllabus added, but no topic headings were detected. Add topics as separate lines.';
        }
      }
      saveState();
      showToast(uploadMessage);
    } catch (error) {
      console.error(`Could not read ${file.name}:`, error);
      showToast(`${file.name}: ${error.message || 'Could not read this file.'}`);
    }
  }
  document.getElementById('file-input').value = '';
  quizQuestions = [];
  renderView('materials');
}

function classifyMaterial(name, selectedKind = 'auto') {
  if (selectedKind !== 'auto') return selectedKind;
  const lower = name.toLowerCase();
  if (lower.includes('syllabus') || lower.includes('curriculum')) return 'Syllabus';
  if (lower.includes('paper') || lower.includes('exam') || lower.includes('question')) return 'Past paper';
  return 'Study notes';
}

function removeMaterial(id) {
  const material = state.materials.find((item) => item.id === id);
  if (!material) return;
  if (material.id.startsWith('seed-')) {
    showToast('Sample materials are part of the demo and can’t be removed.');
    return;
  }
  state.materials = state.materials.filter((item) => item.id !== id);
  state.chat = [];
  saveState();
  quizQuestions = [];
  renderView('materials');
  showToast('Material removed.');
}

function removeAllMaterials() {
  if (!state.materials.length) return;
  const confirmed = window.confirm(
    `Delete all ${state.materials.length} materials? This also clears the topic map and chat history. This cannot be undone.`,
  );
  if (!confirmed) return;
  state.materials = [];
  state.topics = [];
  state.mastery = {};
  state.completedTasks = [];
  state.chat = [];
  quizQuestions = [];
  saveState();
  renderView('materials');
  showToast('All materials deleted.');
}

async function signOut() {
  if (activeRole === 'student') {
    flushPageTime();
    clearTimeout(workspaceSaveTimeout);
    try {
      await apiRequest('/api/workspace/save', { workspace: state });
    } catch (error) {
      showToast(`Could not sync your workspace before sign out: ${error.message}`);
    }
  }
  try {
    await apiRequest('/api/auth/logout', {});
  } catch (error) {
    showToast(`Could not confirm sign out: ${error.message}`);
  }
  state = { ...clone(DEFAULT_STATE), materials: [], topics: [], mastery: {}, attempts: [], topicHistory: [], chat: [] };
  setAuthenticated(false);
}

function bindGlobalEvents() {
  document.getElementById('login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const email = document.getElementById('email').value.trim().toLowerCase();
    const password = document.getElementById('password').value;
    const error = document.getElementById('login-error');
    const submit = document.getElementById('login-submit');
    const payload = { email, password, role: loginRole };
    if (authMode === 'register') {
      if (loginRole !== 'student') {
        error.textContent = 'Student registration is only available in Student mode.';
        return;
      }
      if (!document.getElementById('monitoring-consent').checked) {
        error.textContent = 'Please acknowledge the student activity notice before creating your account.';
        return;
      }
      payload.name = document.getElementById('register-name').value.trim();
      payload.monitoringAcknowledged = true;
    }
    submit.disabled = true;
    error.textContent = '';
    try {
      const result = await apiRequest(authMode === 'register' ? '/api/auth/register' : '/api/auth/login', payload);
      authenticatedUser = result.user;
      activeEmail = result.user.email;
      activeRole = result.user.role;
      state = result.workspace ? restoreAccountWorkspace(result.user, result.workspace) : {
        ...clone(DEFAULT_STATE),
        studentName: result.user.name,
        materials: [],
        topics: [],
        mastery: {},
        attempts: [],
        topicHistory: [],
        chat: [],
      };
      activeView = activeRole === 'admin' ? 'admin' : 'dashboard';
      setAuthenticated(true);
      if (activeRole === 'student') {
        saveState();
        if (pendingLegacyWorkspaceMigration === activeEmail) {
          showToast('Your existing browser materials were restored and are syncing to your account.');
        }
      }
    } catch (requestError) {
      error.textContent = requestError.message || 'Could not sign in.';
    } finally {
      submit.disabled = false;
    }
  });
  document.querySelectorAll('.login-role-option').forEach((button) => {
    button.addEventListener('click', (event) => {
      loginRole = event.currentTarget.dataset.role;
      if (loginRole === 'admin' && authMode === 'register') {
        authMode = 'login';
        document.getElementById('register-name-wrap').classList.add('hidden');
        document.getElementById('monitoring-consent-wrap').classList.add('hidden');
        document.getElementById('register-name').required = false;
        document.getElementById('password').minLength = 0;
        document.getElementById('login-submit').innerHTML = 'Sign in <span>→</span>';
        document.getElementById('auth-mode-toggle').textContent = 'Create a student account';
      }
      document.querySelectorAll('.login-role-option').forEach((option) => {
        const selected = option.dataset.role === loginRole;
        option.classList.toggle('selected', selected);
        option.setAttribute('aria-pressed', String(selected));
      });
      document.getElementById('auth-mode-toggle').classList.toggle('hidden', loginRole !== 'student');
      document.getElementById('login-description').textContent = authMode === 'register'
        ? 'Create your student account. Review the activity notice before continuing.'
        : loginRole === 'admin'
          ? 'Sign in to review student activity using your administrator account.'
          : 'Sign in to your study space, or create a student account to get started.';
      document.getElementById('login-error').textContent = '';
    });
  });
  document.getElementById('auth-mode-toggle').addEventListener('click', (event) => {
    authMode = authMode === 'login' ? 'register' : 'login';
    const registering = authMode === 'register';
    document.getElementById('register-name-wrap').classList.toggle('hidden', !registering);
    document.getElementById('monitoring-consent-wrap').classList.toggle('hidden', !registering);
    document.getElementById('register-name').required = registering;
    document.getElementById('password').minLength = registering ? 10 : 0;
    document.getElementById('password').autocomplete = registering ? 'new-password' : 'current-password';
    document.getElementById('login-submit').innerHTML = registering
      ? 'Create student account <span>→</span>'
      : 'Sign in <span>→</span>';
    document.getElementById('login-description').textContent = registering
      ? 'Create your student account. Review the activity notice before continuing.'
      : 'Sign in to your study space, or create a student account to get started.';
    event.currentTarget.textContent = registering ? 'Already have an account? Sign in' : 'Create a student account';
    document.getElementById('login-error').textContent = '';
  });
  document.getElementById('password-toggle').addEventListener('click', (event) => {
    const field = document.getElementById('password');
    const visible = field.type === 'text';
    field.type = visible ? 'password' : 'text';
    event.currentTarget.textContent = visible ? 'Show' : 'Hide';
    event.currentTarget.setAttribute('aria-label', visible ? 'Show password' : 'Hide password');
  });
  document.getElementById('logout-button').addEventListener('click', signOut);
  document.getElementById('top-logout-button').addEventListener('click', signOut);
  document.querySelectorAll('.sidebar-brand').forEach((brand) => brand.addEventListener('click', (event) => {
    event.preventDefault();
    renderView('dashboard');
  }));
  document.getElementById('mobile-menu').addEventListener('click', () => {
    document.querySelector('.sidebar').classList.toggle('open');
  });
  document.getElementById('top-avatar').addEventListener('click', () => showToast(`${state.studentName} · ${activeRole === 'admin' ? 'Administrator' : 'Student account'}`));
  document.getElementById('file-input').addEventListener('change', (event) => handleFiles([...event.target.files]));
  document.addEventListener('click', (event) => {
    if (event.target.closest('.app-footer [data-view="how-it-works"]')) renderView('how-it-works');
  });
}

bindGlobalEvents();
refreshGroqStatus();
apiGet('/api/auth/me').then((result) => {
  if (!result.user) return;
  authenticatedUser = result.user;
  activeEmail = result.user.email;
  activeRole = result.user.role;
  if (result.workspace) {
    state = restoreAccountWorkspace(result.user, result.workspace);
    if (activeRole === 'student') saveState();
  }
  else state = { ...clone(DEFAULT_STATE), studentName: result.user.name, materials: [], topics: [], mastery: {}, attempts: [], topicHistory: [], chat: [] };
  activeView = activeRole === 'admin' ? 'admin' : 'dashboard';
  setAuthenticated(true);
}).catch((error) => {
  console.warn('Could not restore the signed-in session:', error);
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    flushPageTime();
    currentPageStartedAt = 0;
  } else if (activeRole === 'student' && currentTrackedPage) {
    currentPageStartedAt = Date.now();
  }
});
window.addEventListener('beforeunload', flushPageTime);
setInterval(() => {
  if (document.visibilityState === 'visible') flushPageTime();
}, 30_000);
