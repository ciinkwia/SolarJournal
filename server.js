const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');
const admin = require('firebase-admin');
const Anthropic = require('@anthropic-ai/sdk');

const FIREBASE_AUTH_HOST = 'solarnotes-9c059.firebaseapp.com';

// Load .env file if it exists
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf-8').split('\n').forEach(line => {
    const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = (match[2] || '').replace(/^['"]|['"]$/g, '');
    }
  });
}

// Initialize Firebase Admin
let db;
try {
  let serviceAccount;
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } else {
    const saPath = path.join(__dirname, 'firebase-service-account.json');
    if (fs.existsSync(saPath)) {
      serviceAccount = JSON.parse(fs.readFileSync(saPath, 'utf-8'));
    }
  }

  if (serviceAccount) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    db = admin.firestore();
    console.log('Firebase Admin initialized successfully');
  } else {
    console.warn('\n========================================');
    console.warn('  Firebase service account not found!');
    console.warn('  Set FIREBASE_SERVICE_ACCOUNT env var');
    console.warn('  or place firebase-service-account.json in project root.');
    console.warn('========================================\n');
  }
} catch (err) {
  console.error('Firebase Admin init error:', err.message);
}

// Initialize Anthropic client
const anthropicKey = process.env.ANTHROPIC_API_KEY;
let anthropic;
if (anthropicKey && anthropicKey !== 'your-api-key-here') {
  anthropic = new Anthropic({ apiKey: anthropicKey });
  console.log('Anthropic client initialized');
} else {
  console.warn('\n========================================');
  console.warn('  ANTHROPIC_API_KEY is not set!');
  console.warn('  Set it in your .env file.');
  console.warn('  The app will run but cannot generate expansions.');
  console.warn('========================================\n');
}

// Load system prompt
const systemPromptPath = path.join(__dirname, 'system_prompt_journal.txt');
let SYSTEM_PROMPT;
try {
  SYSTEM_PROMPT = fs.readFileSync(systemPromptPath, 'utf-8').trim();
  console.log('System prompt loaded from system_prompt_journal.txt');
} catch (err) {
  console.warn('system_prompt_journal.txt not found, using default prompt');
  SYSTEM_PROMPT = 'You are a solar tech learning companion. Expand on the highlight with relevant technical depth, specific specs, and practical tips.';
}

// Call Claude API
async function callClaude(highlightText) {
  const message = await anthropic.messages.create({
    model: 'claude-opus-4-0-20250115',
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [
      { role: 'user', content: highlightText }
    ],
  });
  return message.content[0].text;
}

const app = express();
const PORT = process.env.PORT || 3000;

// Reverse proxy for Firebase auth handlers and SDK helpers.
// This makes the auth handler same-origin with the app, which is required to
// avoid sessionStorage partitioning issues that break signInWithRedirect/Popup
// when the app and authDomain live on different eTLD+1s.
function proxyToFirebase(req, res) {
  const options = {
    hostname: FIREBASE_AUTH_HOST,
    port: 443,
    path: req.originalUrl,
    method: req.method,
    headers: { ...req.headers, host: FIREBASE_AUTH_HOST },
  };
  const proxyReq = https.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', (err) => {
    console.error('Firebase proxy error:', err.message);
    if (!res.headersSent) res.status(502).send('Bad Gateway');
  });
  req.pipe(proxyReq);
}
app.use('/__/auth', proxyToFirebase);
app.use('/__/firebase', proxyToFirebase);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Auth middleware
async function verifyAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const token = authHeader.split('Bearer ')[1];
  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = {
      uid: decodedToken.uid,
      email: decodedToken.email,
      name: decodedToken.name || decodedToken.email,
    };
    next();
  } catch (err) {
    console.error('Auth error:', err.message);
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// GET /api/me
app.get('/api/me', verifyAuth, (req, res) => {
  res.json(req.user);
});

// GET /api/entries/today — get or create today's in-progress entry
app.get('/api/entries/today', verifyAuth, async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Firebase is not configured.' });

  const date = req.query.date;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date query param required (YYYY-MM-DD)' });
  }

  try {
    const snapshot = await db.collection('journal_entries')
      .where('userId', '==', req.user.uid)
      .where('date', '==', date)
      .limit(1)
      .get();

    if (!snapshot.empty) {
      const doc = snapshot.docs[0];
      const data = doc.data();
      return res.json({
        id: doc.id,
        date: data.date,
        title: data.title || '',
        notes: data.notes || '',
        highlights: data.highlights || [],
        status: data.status,
        completedAt: data.completedAt ? data.completedAt.toDate().toISOString() : null,
        createdAt: data.createdAt ? data.createdAt.toDate().toISOString() : new Date().toISOString(),
      });
    }

    // Create new entry for today
    const newEntry = {
      userId: req.user.uid,
      date,
      title: '',
      notes: '',
      highlights: [],
      status: 'in_progress',
      completedAt: null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const docRef = await db.collection('journal_entries').add(newEntry);
    res.json({
      id: docRef.id,
      date,
      title: '',
      notes: '',
      highlights: [],
      status: 'in_progress',
      completedAt: null,
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Get today error:', err.message);
    res.status(500).json({ error: 'Failed to get today\'s entry.' });
  }
});

// POST /api/entries/:id/complete — submit highlights/title/notes and generate AI expansions
app.post('/api/entries/:id/complete', verifyAuth, async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Firebase is not configured.' });
  if (!anthropic) return res.status(503).json({ error: 'Anthropic API is not configured.' });

  const bodyHighlights = Array.isArray(req.body.highlights) ? req.body.highlights : null;
  const title = typeof req.body.title === 'string' ? req.body.title.trim() : '';
  const notes = typeof req.body.notes === 'string' ? req.body.notes.trim() : '';

  if (!bodyHighlights || bodyHighlights.length !== 3 || bodyHighlights.some(t => !t || !t.trim())) {
    return res.status(400).json({ error: 'Need exactly 3 non-empty highlights.' });
  }

  try {
    const docRef = db.collection('journal_entries').doc(req.params.id);
    const doc = await docRef.get();

    if (!doc.exists) {
      return res.status(404).json({ error: 'Entry not found.' });
    }

    const data = doc.data();
    if (data.userId !== req.user.uid) {
      return res.status(403).json({ error: 'Not authorized.' });
    }

    if (data.status === 'completed') {
      return res.status(400).json({ error: 'Entry is already completed.' });
    }

    const nowIso = new Date().toISOString();
    const newHighlights = bodyHighlights.map(text => ({
      text: text.trim(),
      expansion: null,
      addedAt: nowIso,
    }));

    // Generate AI expansions for all 3 highlights in parallel
    const expansions = await Promise.all(newHighlights.map(h =>
      callClaude(h.text).catch(err => {
        console.error('Claude expansion error:', err.message);
        return 'Expansion failed — try again later.';
      })
    ));

    const updatedHighlights = newHighlights.map((h, i) => ({
      ...h,
      expansion: expansions[i],
    }));

    await docRef.update({
      title,
      notes,
      highlights: updatedHighlights,
      status: 'completed',
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({
      id: doc.id,
      date: data.date,
      title,
      notes,
      highlights: updatedHighlights,
      status: 'completed',
      completedAt: new Date().toISOString(),
      createdAt: data.createdAt ? data.createdAt.toDate().toISOString() : new Date().toISOString(),
    });
  } catch (err) {
    console.error('Complete entry error:', err.message);
    res.status(500).json({ error: 'Failed to complete entry.' });
  }
});

// GET /api/entries — list completed entries
app.get('/api/entries', verifyAuth, async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Firebase is not configured.' });

  try {
    let query = db.collection('journal_entries')
      .where('userId', '==', req.user.uid)
      .where('status', '==', 'completed')
      .orderBy('date', 'desc')
      .limit(20);

    if (req.query.before) {
      query = query.where('date', '<', req.query.before);
    }

    const snapshot = await query.get();

    const entries = snapshot.docs.map(doc => {
      const data = doc.data();
      return {
        id: doc.id,
        date: data.date,
        title: data.title || '',
        notes: data.notes || '',
        highlights: data.highlights || [],
        status: data.status,
        completedAt: data.completedAt ? data.completedAt.toDate().toISOString() : null,
        createdAt: data.createdAt ? data.createdAt.toDate().toISOString() : new Date().toISOString(),
      };
    });

    res.json(entries);
  } catch (err) {
    console.error('List entries error:', err.message);
    res.status(500).json({ error: 'Failed to load entries.' });
  }
});

// DELETE /api/entries/:id
app.delete('/api/entries/:id', verifyAuth, async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Firebase is not configured.' });

  try {
    const docRef = db.collection('journal_entries').doc(req.params.id);
    const doc = await docRef.get();

    if (!doc.exists) {
      return res.status(404).json({ error: 'Entry not found.' });
    }

    if (doc.data().userId !== req.user.uid) {
      return res.status(403).json({ error: 'Not authorized.' });
    }

    await docRef.delete();
    res.json({ success: true });
  } catch (err) {
    console.error('Delete entry error:', err.message);
    res.status(500).json({ error: 'Failed to delete entry.' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`
  SolarJournal running at:`);
  console.log(`    Local:   http://localhost:${PORT}`);
  console.log(`    Phone:   http://192.168.0.104:${PORT}
`);
});
