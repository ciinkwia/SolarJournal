// Firebase Auth
const auth = firebase.auth();
const googleProvider = new firebase.auth.GoogleAuthProvider();

// DOM elements
const authScreen = document.getElementById('auth-screen');
const appContent = document.getElementById('app-content');
const userInfo = document.getElementById('user-info');
const userName = document.getElementById('user-name');
const signOutBtn = document.getElementById('sign-out-btn');
const googleSignInBtn = document.getElementById('google-sign-in-btn');
const tabNav = document.getElementById('tab-nav');

// Today view elements
const todayView = document.getElementById('today-view');
const todayDate = document.getElementById('today-date');
const highlightsList = document.getElementById('highlights-list');
const highlightInput = document.getElementById('highlight-input');
const addHighlightBtn = document.getElementById('add-highlight-btn');
const addHighlightSection = document.getElementById('add-highlight-section');
const completeBtn = document.getElementById('complete-btn');
const completedMessage = document.getElementById('completed-message');
const progressLabel = document.getElementById('progress-label');

// Journal view elements
const journalView = document.getElementById('journal-view');
const journalList = document.getElementById('journal-list');
const journalEmpty = document.getElementById('journal-empty');
const loadMoreBtn = document.getElementById('load-more-btn');

let currentUser = null;
let todayEntry = null;
let journalEntries = [];
let currentTab = 'today';

// Get today's date in YYYY-MM-DD (local time)
function getTodayDate() {
  return new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD
}

// Auth headers
async function getAuthHeaders() {
  if (!currentUser) return {};
  const token = await currentUser.getIdToken();
  return { 'Authorization': `Bearer ${token}` };
}

// Auth state listener
auth.onAuthStateChanged(async (user) => {
  if (user) {
    currentUser = user;
    userName.textContent = user.displayName || user.email;
    userInfo.classList.remove('hidden');
    tabNav.classList.remove('hidden');
    authScreen.classList.add('hidden');
    appContent.classList.remove('hidden');
    loadToday();
  } else {
    currentUser = null;
    todayEntry = null;
    journalEntries = [];
    userInfo.classList.add('hidden');
    tabNav.classList.add('hidden');
    appContent.classList.add('hidden');
    authScreen.classList.remove('hidden');
  }
});

// Sign in
googleSignInBtn.addEventListener('click', async () => {
  try {
    await auth.signInWithRedirect(googleProvider);
  } catch (err) {
    console.error('Sign-in error:', err);
    alert('Sign-in failed: ' + err.message);
  }
});

// Sign out
signOutBtn.addEventListener('click', () => auth.signOut());

// Tab switching
tabNav.addEventListener('click', (e) => {
  const btn = e.target.closest('.tab-btn');
  if (!btn) return;

  const tab = btn.dataset.tab;
  if (tab === currentTab) return;

  currentTab = tab;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');

  if (tab === 'today') {
    todayView.classList.remove('hidden');
    journalView.classList.add('hidden');
  } else {
    todayView.classList.add('hidden');
    journalView.classList.remove('hidden');
    loadJournal();
  }
});

// Format date for display
function formatDisplayDate(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const d = new Date(year, month - 1, day);
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

// Format time from ISO string
function formatTime(iso) {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

// Simple markdown to HTML
function renderMarkdown(md) {
  let html = md
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

  html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');

  html = html.split('\n').map(line => {
    const trimmed = line.trim();
    if (!trimmed) return '';
    if (trimmed.startsWith('<h') || trimmed.startsWith('<ul') || trimmed.startsWith('<li') || trimmed.startsWith('<pre') || trimmed.startsWith('<code')) {
      return trimmed;
    }
    return `<p>${trimmed}</p>`;
  }).join('\n');

  return html;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Update progress dots
function updateProgress() {
  const count = todayEntry ? todayEntry.highlights.length : 0;
  for (let i = 0; i < 3; i++) {
    const dot = document.getElementById(`dot-${i}`);
    if (i < count) {
      dot.classList.add('filled');
    } else {
      dot.classList.remove('filled');
    }
  }
  progressLabel.textContent = `${count} of 3 highlights`;
}

// Render today's view
function renderToday() {
  if (!todayEntry) return;

  todayDate.textContent = formatDisplayDate(todayEntry.date);
  updateProgress();

  const isCompleted = todayEntry.status === 'completed';

  // Render highlights
  highlightsList.innerHTML = todayEntry.highlights.map((h, i) => `
    <div class="highlight-card">
      <div class="highlight-number">Highlight ${i + 1}</div>
      <div class="highlight-text">${escapeHtml(h.text)}</div>
      <div class="highlight-time">${formatTime(h.addedAt)}</div>
      ${h.expansion ? `
        <div class="highlight-expansion">
          <div class="expansion-label">AI Expansion</div>
          <div class="expansion-content">${renderMarkdown(h.expansion)}</div>
        </div>
      ` : ''}
    </div>
  `).join('');

  // Show/hide input and buttons
  if (isCompleted) {
    addHighlightSection.classList.add('hidden');
    completeBtn.classList.add('hidden');
    completedMessage.classList.remove('hidden');
  } else if (todayEntry.highlights.length >= 3) {
    addHighlightSection.classList.add('hidden');
    completeBtn.classList.remove('hidden');
    completedMessage.classList.add('hidden');
  } else {
    addHighlightSection.classList.remove('hidden');
    completeBtn.classList.add('hidden');
    completedMessage.classList.add('hidden');
  }
}

// Load today's entry
async function loadToday() {
  try {
    const headers = await getAuthHeaders();
    const date = getTodayDate();
    const res = await fetch(`/api/entries/today?date=${date}`, { headers });
    if (res.ok) {
      todayEntry = await res.json();
      renderToday();
    }
  } catch (err) {
    console.error('Failed to load today:', err);
  }
}

// Add highlight
addHighlightBtn.addEventListener('click', async () => {
  const text = highlightInput.value.trim();
  if (!text) return;

  addHighlightBtn.disabled = true;
  const btnText = addHighlightBtn.querySelector('.btn-text');
  const btnLoading = addHighlightBtn.querySelector('.btn-loading');
  btnText.classList.add('hidden');
  btnLoading.classList.remove('hidden');

  try {
    const headers = await getAuthHeaders();
    const res = await fetch('/api/entries/today/highlights', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, date: getTodayDate() }),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to add highlight');
    }

    todayEntry = await res.json();
    highlightInput.value = '';
    renderToday();
  } catch (err) {
    alert(err.message);
  } finally {
    addHighlightBtn.disabled = false;
    btnText.classList.remove('hidden');
    btnLoading.classList.add('hidden');
  }
});

// Ctrl+Enter to add highlight
highlightInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    addHighlightBtn.click();
  }
});

// Complete entry
completeBtn.addEventListener('click', async () => {
  if (!todayEntry) return;

  completeBtn.disabled = true;
  const btnText = completeBtn.querySelector('.btn-text');
  const btnLoading = completeBtn.querySelector('.btn-loading');
  btnText.classList.add('hidden');
  btnLoading.classList.remove('hidden');

  try {
    const headers = await getAuthHeaders();
    const res = await fetch(`/api/entries/${todayEntry.id}/complete`, {
      method: 'POST',
      headers,
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to complete entry');
    }

    todayEntry = await res.json();
    renderToday();
  } catch (err) {
    alert(err.message);
  } finally {
    completeBtn.disabled = false;
    btnText.classList.remove('hidden');
    btnLoading.classList.add('hidden');
  }
});

// Load journal entries
async function loadJournal(append = false) {
  try {
    const headers = await getAuthHeaders();
    let url = '/api/entries';
    if (append && journalEntries.length > 0) {
      const lastDate = journalEntries[journalEntries.length - 1].date;
      url += `?before=${lastDate}`;
    }

    const res = await fetch(url, { headers });
    if (res.ok) {
      const entries = await res.json();
      if (append) {
        journalEntries = [...journalEntries, ...entries];
      } else {
        journalEntries = entries;
      }
      renderJournal();

      // Show/hide load more
      if (entries.length >= 20) {
        loadMoreBtn.classList.remove('hidden');
      } else {
        loadMoreBtn.classList.add('hidden');
      }
    }
  } catch (err) {
    console.error('Failed to load journal:', err);
  }
}

// Render journal entries
function renderJournal() {
  if (journalEntries.length === 0) {
    journalList.innerHTML = '';
    journalEmpty.classList.remove('hidden');
    return;
  }

  journalEmpty.classList.add('hidden');
  journalList.innerHTML = journalEntries.map(entry => `
    <div class="journal-card" data-id="${entry.id}">
      <div class="journal-card-header" onclick="toggleJournalCard('${entry.id}')">
        <div>
          <div class="journal-date">${formatDisplayDate(entry.date)}</div>
          <div class="journal-preview">${entry.highlights.map(h => escapeHtml(h.text)).join(' / ')}</div>
        </div>
        <div class="journal-meta">
          <button class="delete-btn" onclick="event.stopPropagation(); deleteEntry('${entry.id}')" title="Delete entry">&times;</button>
          <span class="journal-toggle">&#9660;</span>
        </div>
      </div>
      <div class="journal-card-body">
        ${entry.highlights.map((h, i) => `
          <div class="highlight-card" style="margin-top: ${i > 0 ? '0.75rem' : '0'}">
            <div class="highlight-number">Highlight ${i + 1}</div>
            <div class="highlight-text">${escapeHtml(h.text)}</div>
            ${h.expansion ? `
              <div class="highlight-expansion">
                <div class="expansion-label">AI Expansion</div>
                <div class="expansion-content">${renderMarkdown(h.expansion)}</div>
              </div>
            ` : ''}
          </div>
        `).join('')}
      </div>
    </div>
  `).join('');
}

// Toggle journal card
window.toggleJournalCard = function(id) {
  const card = document.querySelector(`.journal-card[data-id="${id}"]`);
  if (card) card.classList.toggle('expanded');
};

// Delete entry
window.deleteEntry = async function(id) {
  if (!confirm('Delete this journal entry?')) return;

  try {
    const headers = await getAuthHeaders();
    const res = await fetch(`/api/entries/${id}`, { method: 'DELETE', headers });
    if (res.ok) {
      journalEntries = journalEntries.filter(e => e.id !== id);
      renderJournal();

      // If we deleted today's entry, reload today
      if (todayEntry && todayEntry.id === id) {
        todayEntry = null;
        loadToday();
      }
    }
  } catch (err) {
    console.error('Delete failed:', err);
  }
};

// Load more
loadMoreBtn.addEventListener('click', () => loadJournal(true));
