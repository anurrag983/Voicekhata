const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const API_BASE = String(window.VOICEKHATA_CONFIG?.apiBaseUrl || window.location.origin).replace(/\/+$/, '');
const TOKEN_KEY = 'voicekhata.access_token';
const PENDING_ENTRY_KEY = 'voicekhata.pending_entry';
// Keep the short-lived access token across app relaunches so an Android
// assistant launch can enter the authenticated workspace after a cold start.
let token = (() => {
  const saved = localStorage.getItem(TOKEN_KEY);
  const legacy = sessionStorage.getItem(TOKEN_KEY);
  if (!saved && legacy) localStorage.setItem(TOKEN_KEY, legacy);
  sessionStorage.removeItem(TOKEN_KEY);
  return saved || legacy || '';
})();
let merchant = null;
let customers = [];
let transactions = [];
let selectedCustomerId = '';
let selectedCustomerLedger = null;
let customerLedgerLoading = false;
let customerLedgerError = '';
let profile = { shopName: '', ownerName: '', location: '' };
let pendingVoiceEntry = null;
let voiceConversation = null;
let recognition = null;
let listening = false;
let micStream = null;
let mediaRecorder = null;
let recordedChunks = [];
let recordingTimer = null;
let recordingHeardSpeech = false;
let recordingSilenceStartedAt = 0;
let processRecordingOnStop = false;
let startingVoice = false;
let awaitingVoiceReply = false;
let voiceReplyRecognition = null;
let voiceReplyRecorder = null;
let voiceReplyStream = null;
let voiceReplyContext = null;
let voiceReplyFrame = 0;
let discardVoiceReply = false;
let voiceReplyTimer = null;
let audioContext = null;
let analyser = null;
let waveFrame = 0;
let voiceLanguage = 'hi-IN';
let gnaniSttEnabled = false;
let gnaniTtsEnabled = false;
let voiceSpaceHeld = false;
let voiceSpaceReleasedWhileStarting = false;
let voicePointerTimer = null;
let voicePointerHoldActive = false;
let voicePointerReleasedDuringStart = false;
let suppressVoiceButtonClick = false;
let assistantVoiceLaunchPending = false;
let pendingLedgerRequest = (() => { try { return JSON.parse(sessionStorage.getItem(PENDING_ENTRY_KEY) || 'null'); } catch { return null; } })();
let savingCustomer = false;
let savingLedger = false;

const money = (value) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(Number(value) || 0);
const dateKey = (value) => {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const normaliseCustomerName = (value) => String(value ?? '').normalize('NFC').trim().toLocaleLowerCase('en-IN').replace(/\s+/g, ' ');
const DEVANAGARI_CONSONANTS = new Map([
  ['क','k'], ['ख','kh'], ['ग','g'], ['घ','gh'], ['ङ','n'], ['च','ch'], ['छ','chh'], ['ज','j'], ['झ','jh'], ['ञ','n'], ['ट','t'], ['ठ','th'], ['ड','d'], ['ढ','dh'], ['ण','n'],
  ['त','t'], ['थ','th'], ['द','d'], ['ध','dh'], ['न','n'], ['प','p'], ['फ','ph'], ['ब','b'], ['भ','bh'], ['म','m'], ['य','y'], ['र','r'], ['ल','l'], ['व','v'], ['श','sh'], ['ष','sh'], ['स','s'], ['ह','h'],
]);
const DEVANAGARI_VOWELS = new Map([['अ','a'], ['आ','a'], ['इ','i'], ['ई','i'], ['उ','u'], ['ऊ','u'], ['ऋ','ri'], ['ए','e'], ['ऐ','ai'], ['ओ','o'], ['औ','au']]);
const DEVANAGARI_MATRAS = new Map([['ा','a'], ['ि','i'], ['ी','i'], ['ु','u'], ['ू','u'], ['ृ','ri'], ['े','e'], ['ै','ai'], ['ो','o'], ['ौ','au']]);
function customerNameMatchKey(value) {
  const chars = [...String(value ?? '').normalize('NFC').toLocaleLowerCase('en-IN')];
  let romanized = '';
  let word = '';
  let wordHasDevanagari = false;
  let endsWithInherentVowel = false;
  const flushWord = () => {
    if (wordHasDevanagari && endsWithInherentVowel && word.endsWith('a')) word = word.slice(0, -1);
    romanized += word;
    word = '';
    wordHasDevanagari = false;
    endsWithInherentVowel = false;
  };
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index];
    if (DEVANAGARI_CONSONANTS.has(char)) {
      word += DEVANAGARI_CONSONANTS.get(char);
      wordHasDevanagari = true;
      if (chars[index + 1] === '्') index += 1;
      else if (DEVANAGARI_MATRAS.has(chars[index + 1])) endsWithInherentVowel = false;
      else { word += 'a'; endsWithInherentVowel = true; }
    } else if (DEVANAGARI_VOWELS.has(char)) { word += DEVANAGARI_VOWELS.get(char); wordHasDevanagari = true; endsWithInherentVowel = false; }
    else if (DEVANAGARI_MATRAS.has(char)) { word += DEVANAGARI_MATRAS.get(char); wordHasDevanagari = true; endsWithInherentVowel = false; }
    else if (char === 'ं' || char === 'ँ') { word += 'n'; wordHasDevanagari = true; endsWithInherentVowel = false; }
    else if (char === '़' || char === '्' || char === '‍' || char === '‌') continue;
    else if (/[\p{L}\p{M}\d]/u.test(char)) { word += char; endsWithInherentVowel = false; }
    else { flushWord(); romanized += char; }
  }
  flushWord();
  return romanized.normalize('NFD').replace(/\p{M}/gu, '')
    .replace(/aa/g, 'a').replace(/ee|ii/g, 'i').replace(/oo|uu/g, 'u')
    .replace(/\s+/g, ' ').trim();
}
const sameCustomerName = (left, right) => customerNameMatchKey(left) === customerNameMatchKey(right);
const COMMAND_FILLER_WORDS = new Set([
  'rupee', 'rupees', 'rupaye', 'rupya', 'rs', 'paisa', 'paise', 'ka', 'ke', 'ko', 'se', 'ne', 'par',
  'udhaar', 'udhar', 'credit', 'debit', 'jama', 'mile', 'mila', 'likho', 'likh', 'entry', 'received',
  'payment', 'paid', 'vasool', 'add', 'record', 'aaj', 'today', 'hai', 'hain', 'tha', 'the', 'name', 'customer', 'kiye', 'kiya', 'diya', 'diye', 'liya', 'liye', 'kar', 'karo',
  'रुपये', 'रुपए', 'रुपया', 'रुपयों', 'पैसे', 'पैसा', 'पैसों', 'लिखो', 'लिख', 'जमा', 'उधार', 'उधर', 'उधारी', 'जी', 'ji',
  'मिले', 'मिला', 'किए', 'किया', 'दिए', 'दिया', 'लिए', 'लिया', 'कर', 'करो', 'हुआ', 'हुई', 'आज', 'है', 'हैं', 'थे', 'था', 'का', 'के', 'को', 'ने', 'से', 'पर', 'नाम', 'ग्राहक',
]);
function commandCustomerName(value) {
  return [...String(value || '').normalize('NFC').matchAll(/[\p{L}\p{M}]+/gu)]
    .map((match) => match[0])
    .filter((word) => !COMMAND_FILLER_WORDS.has(word.toLocaleLowerCase('en-IN')))
    .join(' ')
    .trim();
}
function namesOneEditApart(left, right) {
  const a = Array.from(customerNameMatchKey(left));
  const b = Array.from(customerNameMatchKey(right));
  if (Math.min(a.length, b.length) < 3 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let differences = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i += 1; j += 1; continue; }
    differences += 1;
    if (differences > 1) return false;
    if (a.length === b.length) { i += 1; j += 1; }
    else if (a.length > b.length) i += 1;
    else j += 1;
  }
  return differences + Number(i < a.length || j < b.length) <= 1;
}

function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove('show'), 3200);
}

function speakText(message) {
  if (gnaniTtsEnabled) return speakWithGnani(message).then((played) => played || speakWithBrowser(message));
  return speakWithBrowser(message);
}
function speakWithBrowser(message) {
  if (!('speechSynthesis' in window) || !window.SpeechSynthesisUtterance) return Promise.resolve(false);
  return new Promise((resolve) => {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(message);
    utterance.lang = voiceLanguage;
    utterance.rate = 0.95;
    utterance.volume = 1;
    const voices = window.speechSynthesis.getVoices();
    const language = voiceLanguage.toLowerCase().split('-')[0];
    utterance.voice = voices.find((voice) => voice.lang.toLowerCase().startsWith(`${language}-`)) || null;
    let finished = false;
    const finish = (played) => {
      if (finished) return;
      finished = true;
      resolve(played);
    };
    utterance.onend = () => finish(true);
    utterance.onerror = () => finish(false);
    try { window.speechSynthesis.speak(utterance); }
    catch { finish(false); }
  });
}

function setAuthError(message = '') {
  const error = $('#auth-error');
  error.textContent = message;
  error.hidden = !message;
}

function showAuth(message = '') {
  if (listening) stopListening();
  stopVoiceReply();
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  $$('dialog[open]').forEach((dialog) => dialog.close());
  pendingVoiceEntry = null;
  voiceConversation = null;
  $('#app-shell').hidden = true;
  $('#auth-screen').hidden = false;
  setAuthMode('login');
  setAuthError(message);
}

function showApp() {
  $('#auth-screen').hidden = true;
  $('#app-shell').hidden = false;
}

async function api(path, options = {}) {
  if (!API_BASE) throw new Error('API URL is missing. Set apiBaseUrl in frontend/config.js.');
  const headers = new Headers(options.headers || {});
  const hasBody = options.body !== undefined && options.body !== null;
  if (token && !path.includes('/auth/login') && !path.includes('/auth/register')) headers.set('Authorization', `Bearer ${token}`);
  if (hasBody && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, { ...options, headers, cache: 'no-store' });
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error('Cannot reach the backend. Start it with ./start.sh and open the app at http://127.0.0.1:8000.');
    }
    throw error;
  }
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await response.json() : null;
  if (!response.ok) {
    const detail = payload?.detail;
    const message = Array.isArray(detail) ? detail.map((item) => item.msg).join(', ') : (detail || `Request failed (${response.status})`);
    if (response.status === 401 && !path.includes('/auth/login') && !path.includes('/auth/register')) {
      token = '';
      localStorage.removeItem(TOKEN_KEY);
      showAuth('Your session expired. Please log in again.');
    }
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return payload;
}

function decodeWavChunk(encoded) {
  const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
  if (bytes.length < 44) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const readId = (offset) => String.fromCharCode(...bytes.slice(offset, offset + 4));
  if (readId(0) !== 'RIFF' || readId(8) !== 'WAVE') return null;
  let format = null;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const id = readId(offset);
    const size = view.getUint32(offset + 4, true);
    const dataOffset = offset + 8;
    if (dataOffset + size > bytes.length) return null;
    if (id === 'fmt ' && size >= 16) {
      format = {
        code: view.getUint16(dataOffset, true),
        channels: view.getUint16(dataOffset + 2, true),
        sampleRate: view.getUint32(dataOffset + 4, true),
        byteRate: view.getUint32(dataOffset + 8, true),
        blockAlign: view.getUint16(dataOffset + 12, true),
        bits: view.getUint16(dataOffset + 14, true),
      };
    } else if (id === 'data') {
      return format ? { format, pcm: bytes.slice(dataOffset, dataOffset + size) } : null;
    }
    offset = dataOffset + size + (size % 2);
  }
  return null;
}
function assembleWav(chunks) {
  const decoded = chunks.map(decodeWavChunk);
  if (!decoded.length || decoded.some((chunk) => !chunk)) return null;
  const format = decoded[0].format;
  if (format.code !== 1 || decoded.some((chunk) => JSON.stringify(chunk.format) !== JSON.stringify(format))) return null;
  const dataLength = decoded.reduce((total, chunk) => total + chunk.pcm.length, 0);
  const output = new ArrayBuffer(44 + dataLength);
  const view = new DataView(output);
  const putText = (offset, value) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  putText(0, 'RIFF'); view.setUint32(4, 36 + dataLength, true); putText(8, 'WAVE');
  putText(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, format.code, true);
  view.setUint16(22, format.channels, true); view.setUint32(24, format.sampleRate, true);
  view.setUint32(28, format.byteRate, true); view.setUint16(32, format.blockAlign, true); view.setUint16(34, format.bits, true);
  putText(36, 'data'); view.setUint32(40, dataLength, true);
  const outputBytes = new Uint8Array(output);
  let cursor = 44;
  for (const chunk of decoded) { outputBytes.set(chunk.pcm, cursor); cursor += chunk.pcm.length; }
  return new Blob([output], { type: 'audio/wav' });
}
function decodeGnaniTtsSse(stream) {
  const chunks = [];
  for (const block of String(stream || '').split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/);
    const eventType = lines.find((line) => line.startsWith('event:'))?.slice(6).trim();
    const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
    if (!data || (eventType && !['audio', 'audio_chunk', 'chunk', 'message'].includes(eventType))) continue;
    let audioData = data;
    try {
      const payload = JSON.parse(data);
      audioData = payload.audio || payload.audio_chunk || payload.data || '';
    } catch { /* Gnani's SSE endpoint also sends each audio chunk as raw base64. */ }
    if (audioData) chunks.push(String(audioData).replace(/^data:audio\/[a-z0-9.+-]+;base64,/i, '').replace(/\s+/g, ''));
  }
  return chunks;
}
function assembleGnaniPcmWav(chunks) {
  let audioChunks;
  try { audioChunks = chunks.map((encoded) => Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0))); }
  catch { return null; }
  if (!audioChunks.length || audioChunks.some((chunk) => !chunk.length)) return null;
  let format = null;
  const pcmChunks = audioChunks.map((chunk) => {
    if (chunk.length < 44 || String.fromCharCode(...chunk.subarray(0, 4)) !== 'RIFF' || String.fromCharCode(...chunk.subarray(8, 12)) !== 'WAVE') return chunk;
    const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    for (let offset = 12; offset + 8 <= chunk.length;) {
      const id = String.fromCharCode(...chunk.subarray(offset, offset + 4));
      const size = view.getUint32(offset + 4, true);
      const dataOffset = offset + 8;
      if (id === 'fmt ' && size >= 16 && dataOffset + 16 <= chunk.length) {
        format = {
          code: view.getUint16(dataOffset, true), channels: view.getUint16(dataOffset + 2, true),
          sampleRate: view.getUint32(dataOffset + 4, true), byteRate: view.getUint32(dataOffset + 8, true),
          blockAlign: view.getUint16(dataOffset + 12, true), bits: view.getUint16(dataOffset + 14, true),
        };
      }
      if (id === 'data') return chunk.subarray(dataOffset);
      if (!size || dataOffset + size > chunk.length) break;
      offset = dataOffset + size + (size % 2);
    }
    return new Uint8Array();
  });
  if (!format || format.code !== 1 || !format.channels || !format.sampleRate || !format.blockAlign || !format.bits) return null;
  const dataLength = pcmChunks.reduce((total, chunk) => total + chunk.length, 0);
  const alignedDataLength = dataLength - (dataLength % format.blockAlign);
  if (!alignedDataLength) return null;
  const output = new ArrayBuffer(44 + alignedDataLength);
  const view = new DataView(output);
  const putText = (offset, value) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  putText(0, 'RIFF'); view.setUint32(4, 36 + alignedDataLength, true); putText(8, 'WAVE');
  putText(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, format.code, true); view.setUint16(22, format.channels, true);
  view.setUint32(24, format.sampleRate, true); view.setUint32(28, format.byteRate, true);
  view.setUint16(32, format.blockAlign, true); view.setUint16(34, format.bits, true);
  putText(36, 'data'); view.setUint32(40, alignedDataLength, true);
  const bytes = new Uint8Array(output);
  let cursor = 44;
  let remaining = alignedDataLength;
  for (const chunk of pcmChunks) {
    const length = Math.min(chunk.length, remaining);
    bytes.set(chunk.subarray(0, length), cursor); cursor += length; remaining -= length;
    if (!remaining) break;
  }
  return new Blob([output], { type: 'audio/wav' });
}
async function speakWithGnani(message) {
  if (!token || !API_BASE) return false;
  try {
    const response = await fetch(`${API_BASE}/api/v1/voice/speak`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: message, language_code: voiceLanguage }),
      cache: 'no-store',
    });
    if (!response.ok) return false;
    const stream = await response.text();
    const audioChunks = decodeGnaniTtsSse(stream);
    const wav = assembleWav(audioChunks) || assembleGnaniPcmWav(audioChunks);
    if (!wav) return false;
    const url = URL.createObjectURL(wav);
    try {
      const audio = new Audio(url);
      await new Promise((resolve, reject) => {
        audio.onended = resolve;
        audio.onerror = reject;
        audio.play().catch(reject);
      });
    } finally { URL.revokeObjectURL(url); }
    return true;
  } catch {
    return false;
  }
}

function setAuthMode(mode) {
  const registering = mode === 'register';
  $('#login-form').hidden = registering;
  $('#register-form').hidden = !registering;
  $('#auth-title').textContent = registering ? 'Set up your shop' : 'Welcome back';
  $('#auth-subtitle').textContent = registering ? 'Set up your shop once. Later, sign in with your email and password.' : 'Sign in to see your customers and khata.';
  $('#auth-toggle').textContent = registering ? 'Already have an account? Log in' : 'New here? Create an account';
  setAuthError('');
}

async function authenticate(path, payload) {
  try {
    const result = await api(path, { method: 'POST', body: JSON.stringify(payload) });
    token = result.access_token;
    localStorage.setItem(TOKEN_KEY, token);
    merchant = result.merchant;
    await loadWorkspace();
    showApp();
    renderAll();
    startAssistantVoiceWhenReady();
    toast(path.endsWith('/register') ? 'Shop account created' : 'You are logged in');
  } catch (error) {
    setAuthError(error.message);
  }
}

$('#login-form').addEventListener('submit', (event) => {
  event.preventDefault();
  authenticate('/api/v1/auth/login', {
    email: $('#login-email').value.trim(),
    password: $('#login-password').value,
  });
});
$('#register-form').addEventListener('submit', (event) => {
  event.preventDefault();
  authenticate('/api/v1/auth/register', {
    name: $('#register-name').value.trim(),
    owner_name: $('#register-owner-name').value.trim() || null,
    location: $('#register-location').value.trim() || null,
    email: $('#register-email').value.trim(),
    password: $('#register-password').value,
  });
});
$('#auth-toggle').addEventListener('click', () => setAuthMode($('#register-form').hidden ? 'register' : 'login'));
$('#logout-btn').addEventListener('click', () => {
  token = '';
  merchant = null;
  customers = [];
  transactions = [];
  localStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(PENDING_ENTRY_KEY);
  pendingLedgerRequest = null;
  showAuth();
  setAuthMode('login');
});

async function loadWorkspace() {
  const [me, remoteCustomers, remoteEntries] = await Promise.all([
    api('/api/v1/auth/me'),
    api('/api/v1/customers'),
    loadAllEntries(),
  ]);
  merchant = me;
  transactions = remoteEntries.map((entry) => ({
    id: entry.id,
    customerId: entry.customer_id,
    amount: Number(entry.amount),
    type: entry.entry_type === 'udhaar' ? 'credit' : 'payment',
    note: entry.note || '',
    createdAt: entry.created_at,
  }));
  const activityByCustomer = new Map();
  for (const entry of transactions) {
    const current = activityByCustomer.get(entry.customerId);
    if (!current || new Date(entry.createdAt) > new Date(current)) activityByCustomer.set(entry.customerId, entry.createdAt);
  }
  customers = remoteCustomers.map((customer) => ({
    id: customer.id,
    name: customer.name,
    phone: customer.phone || '',
    balance: Number(customer.balance),
    lastActivity: activityByCustomer.get(customer.id) || null,
  }));
  profile = {
    shopName: me.name,
    ownerName: me.owner_name || '',
    location: me.location || '',
  };
}

async function loadAllEntries() {
  const pageSize = 500;
  const all = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await api(`/api/v1/ledger/entries?limit=${pageSize}&offset=${offset}`);
    all.push(...page);
    if (page.length < pageSize) return all;
  }
}

function balanceOf(customerId) {
  return Number(customers.find((customer) => customer.id === customerId)?.balance || 0);
}
function customerName(id) {
  return customers.find((customer) => customer.id === id)?.name || 'Unknown customer';
}
function initials(name) {
  return name.trim().split(/\s+/).slice(0, 2).map((word) => word[0] || '').join('').toUpperCase() || '·';
}
function displayTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (dateKey(date) === dateKey(new Date())) return date.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
  return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

function renderProfile() {
  const name = profile.shopName || 'Your shop';
  $('#store-name').textContent = name;
  $('#store-location').textContent = profile.location || merchant?.email || 'Shop account';
  $('#store-avatar').textContent = initials(name);
  $('#owner-name').textContent = profile.ownerName || 'Shop owner';
  $('#owner-avatar').textContent = initials(profile.ownerName || 'Shop owner');
  $('#greeting').textContent = profile.ownerName ? `Namaste, ${profile.ownerName} ji` : 'Your shop, at a glance';
  $('#shop-name-input').value = name;
  $('#owner-name-input').value = profile.ownerName || '';
  $('#shop-location-input').value = profile.location || '';
}
function renderDate() {
  const now = new Date();
  $('#today-label').textContent = now.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).toUpperCase();
  $('#today-date').textContent = now.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}
function renderActivity() {
  const list = $('#activity-list');
  const items = [...transactions].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 5);
  if (!items.length) {
    list.innerHTML = '<div class="activity-empty"><span class="empty-mark">＋</span><b>Your ledger starts here</b><p>When you record a credit or payment, it will appear here.</p><button class="text-link" data-open-entry>Record your first entry →</button></div>';
    list.querySelector('[data-open-entry]').addEventListener('click', () => openEntry());
    return;
  }
  list.innerHTML = items.map((entry) => `<div class="activity-row"><span class="activity-symbol ${entry.type}">${entry.type === 'credit' ? '↗' : '↙'}</span><div class="activity-person"><b>${esc(customerName(entry.customerId))}</b><small>${esc(displayTime(entry.createdAt))} · ${entry.type === 'credit' ? 'Udhaar' : 'Payment'}${entry.note ? ` · ${esc(entry.note)}` : ''}</small></div><div class="activity-amount ${entry.type}">${entry.type === 'credit' ? '+' : '−'}${money(entry.amount)}<small>${entry.type === 'credit' ? 'Added' : 'Received'}</small></div></div>`).join('');
}
function renderHomeCustomers() {
  const element = $('#home-customers');
  const owing = customers.map((customer) => ({ ...customer, balance: balanceOf(customer.id) })).filter((customer) => customer.balance > 0).sort((a, b) => b.balance - a.balance).slice(0, 4);
  if (!customers.length) {
    element.innerHTML = '<div class="empty-state"><b>No customers yet</b><p>Add a customer to start keeping their khata.</p><button class="text-link" data-add-home-customer>＋ Add your first customer</button></div>';
    element.querySelector('[data-add-home-customer]').addEventListener('click', openCustomer);
    return;
  }
  element.innerHTML = owing.length ? owing.map((customer) => `<button type="button" class="customer-mini" data-customer-id="${esc(customer.id)}" aria-label="View ${esc(customer.name)} history"><span class="customer-initial">${esc(initials(customer.name))}</span><span class="customer-mini-info"><b>${esc(customer.name)}</b><small>Outstanding</small></span><span class="customer-balance">${money(customer.balance)}</span></button>`).join('') : '<div class="empty-state"><b>All caught up</b><span>No customer has an outstanding balance.</span></div>';
}
function renderCustomers() {
  const query = ($('#customer-search').value || '').trim().toLowerCase();
  const filter = $('#balance-filter').value;
  const rows = customers.map((customer) => ({ ...customer, balance: balanceOf(customer.id) }))
    .filter((customer) => `${customer.name} ${customer.phone}`.toLowerCase().includes(query))
    .filter((customer) => filter === 'owing' ? customer.balance > 0 : filter === 'settled' ? customer.balance === 0 : filter === 'advance' ? customer.balance < 0 : true)
    .sort((a, b) => a.name.localeCompare(b.name));
  $('#customer-count').textContent = `${rows.length} ${rows.length === 1 ? 'customer' : 'customers'}`;
  const body = $('#customer-rows');
  if (!rows.length) {
    body.innerHTML = customers.length ? '<tr><td colspan="6" class="table-empty">No customers match that search.</td></tr>' : '<tr><td colspan="6" class="table-empty">Your customer list is empty. Add a customer to start a khata.</td></tr>';
    return;
  }
  body.innerHTML = rows.map((customer) => `<tr class="customer-clickable-row" data-customer-id="${esc(customer.id)}" tabindex="0" role="button" aria-label="View ${esc(customer.name)} history"><td><span class="table-person"><span class="customer-initial">${esc(initials(customer.name))}</span>${esc(customer.name)}</span></td><td>${esc(customer.phone || '—')}</td><td>${esc(displayTime(customer.lastActivity))}</td><td><b>${money(Math.max(0, customer.balance))}</b>${customer.balance < 0 ? `<small class="advance-note"> · Advance ${money(-customer.balance)}</small>` : ''}</td><td><span class="status-badge ${customer.balance <= 0 ? 'settled' : ''}">${customer.balance > 0 ? 'Outstanding' : customer.balance < 0 ? 'Advance' : 'Settled'}</span></td><td><span class="row-open-label">View history →</span></td></tr>`).join('');
}
function openCustomerDetail(customerId) {
  if (!customers.some((customer) => customer.id === customerId)) return;
  selectedCustomerId = customerId;
  selectedCustomerLedger = null;
  customerLedgerLoading = true;
  customerLedgerError = '';
  go('customer');
  loadCustomerLedger(customerId);
}
async function loadCustomerLedger(customerId) {
  customerLedgerLoading = true;
  customerLedgerError = '';
  if (selectedCustomerId === customerId) renderCustomerDetail();
  try {
    const result = await api(`/api/v1/customers/${encodeURIComponent(customerId)}/ledger`);
    if (selectedCustomerId !== customerId) return;
    selectedCustomerLedger = result;
  } catch (error) {
    if (selectedCustomerId !== customerId) return;
    customerLedgerError = error.message || 'Could not load this customer’s history.';
  } finally {
    if (selectedCustomerId === customerId) {
      customerLedgerLoading = false;
      renderCustomerDetail();
    }
  }
}
function renderCustomerDetail() {
  const customer = customers.find((item) => item.id === selectedCustomerId);
  if (!customer) return;
  const data = selectedCustomerLedger?.customer?.id === customer.id ? selectedCustomerLedger : null;
  const items = data ? [...data.entries].sort((a, b) => new Date(a.created_at) - new Date(b.created_at)) : [];
  const entries = items.map((entry) => ({ ...entry, amount: Number(entry.amount), type: entry.entry_type === 'udhaar' ? 'credit' : 'payment' }));
  let runningBalance = 0;
  const withBalances = entries.map((entry) => {
    runningBalance += entry.type === 'credit' ? entry.amount : -entry.amount;
    return { ...entry, balanceAfter: runningBalance };
  }).reverse();
  const currentBalance = Number(data?.balance ?? customer.balance);
  const creditTotal = sums(entries, 'credit');
  const paymentTotal = sums(entries, 'payment');
  $('#customer-detail-name').textContent = customer.name;
  $('#customer-detail-contact').textContent = [customer.phone || 'No phone number', customer.lastActivity ? `Last activity ${displayTime(customer.lastActivity)}` : 'No activity yet'].join(' · ');
  $('#customer-detail-balance').textContent = currentBalance < 0 ? `${money(-currentBalance)} advance` : money(currentBalance);
  $('#customer-detail-credit').textContent = money(creditTotal);
  $('#customer-detail-payments').textContent = money(paymentTotal);
  $('#customer-detail-count').textContent = `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'} in this khata`;
  const body = $('#customer-history-rows');
  if (customerLedgerLoading && !data) {
    body.innerHTML = '<tr><td colspan="5" class="table-empty">Loading customer history…</td></tr>';
    return;
  }
  if (customerLedgerError && !data) {
    body.innerHTML = `<tr><td colspan="5" class="table-empty">${esc(customerLedgerError)} <button type="button" class="text-link" data-retry-customer-history>Try again</button></td></tr>`;
    return;
  }
  if (!withBalances.length) {
    body.innerHTML = '<tr><td colspan="5" class="table-empty">No transactions have been recorded for this customer yet.</td></tr>';
    return;
  }
  body.innerHTML = withBalances.map((entry) => {
    const date = new Date(entry.created_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
    const balanceAfter = entry.balanceAfter < 0 ? `${money(-entry.balanceAfter)} advance` : money(entry.balanceAfter);
    return `<tr><td>${esc(date)}</td><td>${esc(entry.note || (entry.type === 'credit' ? 'Udhaar added' : 'Payment received'))}</td><td><span class="status-badge ${entry.type === 'payment' ? 'settled' : ''}">${entry.type === 'credit' ? 'Udhaar' : 'Payment'}</span></td><td><b class="${entry.type === 'credit' ? 'entry-credit' : 'entry-payment'}">${entry.type === 'credit' ? '+' : '−'}${money(entry.amount)}</b></td><td>${esc(balanceAfter)}</td></tr>`;
  }).join('');
}
function renderTransactions() {
  const body = $('#transaction-rows');
  const items = [...transactions].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  if (!items.length) {
    body.innerHTML = '<tr><td colspan="5" class="table-empty">Transactions you record will appear here.</td></tr>';
    return;
  }
  body.innerHTML = items.map((entry) => `<tr><td>${esc(new Date(entry.createdAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }))}</td><td>${esc(customerName(entry.customerId))}</td><td>${esc(entry.note || '—')}</td><td><span class="status-badge ${entry.type === 'payment' ? 'settled' : ''}">${entry.type === 'credit' ? 'Udhaar' : 'Payment'}</span></td><td><b>${entry.type === 'credit' ? '+' : '−'}${money(entry.amount)}</b></td></tr>`).join('');
}
function sums(items, type) {
  return items.filter((entry) => !type || entry.type === type).reduce((sum, entry) => sum + Number(entry.amount), 0);
}
function renderSummary() {
  const today = dateKey(new Date());
  const month = today.slice(0, 7);
  const todayItems = transactions.filter((entry) => dateKey(entry.createdAt) === today);
  const monthItems = transactions.filter((entry) => dateKey(entry.createdAt).slice(0, 7) === month);
  const balances = customers.map((customer) => balanceOf(customer.id));
  $('#total-outstanding').textContent = money(balances.reduce((sum, balance) => sum + Math.max(0, balance), 0));
  const owing = balances.filter((balance) => balance > 0).length;
  $('#outstanding-count').textContent = `${owing} ${owing === 1 ? 'customer' : 'customers'} with balance`;
  $('#today-collected').textContent = money(sums(todayItems, 'payment'));
  $('#today-count').textContent = String(todayItems.length);
  $('#month-credit').textContent = money(sums(monthItems, 'credit'));
  $('#month-payments').textContent = money(sums(monthItems, 'payment'));
  $('#analytics-customer-count').textContent = String(owing);
  renderWeeklyChart();
}
function renderWeeklyChart() {
  const root = $('#weekly-chart');
  const days = [];
  for (let offset = 6; offset >= 0; offset -= 1) {
    const day = new Date();
    day.setHours(0, 0, 0, 0);
    day.setDate(day.getDate() - offset);
    const key = dateKey(day);
    const entries = transactions.filter((entry) => dateKey(entry.createdAt) === key);
    days.push({ label: day.toLocaleDateString('en-IN', { weekday: 'short' }), credit: sums(entries, 'credit'), payment: sums(entries, 'payment') });
  }
  const max = Math.max(1, ...days.flatMap((day) => [day.credit, day.payment]));
  root.innerHTML = days.map((day) => `<div class="week-day" title="${esc(day.label)} · Credit ${money(day.credit)} · Payment ${money(day.payment)}"><div class="week-bars"><span class="week-credit" style="height:${Math.max(day.credit ? 5 : 0, day.credit / max * 100)}%"></span><span class="week-payment" style="height:${Math.max(day.payment ? 5 : 0, day.payment / max * 100)}%"></span></div><small>${esc(day.label)}</small></div>`).join('');
}
function renderAll() {
  renderProfile();
  renderDate();
  renderActivity();
  renderHomeCustomers();
  renderCustomers();
  renderTransactions();
  renderSummary();
  if (selectedCustomerId && $('#page-customer').classList.contains('active')) loadCustomerLedger(selectedCustomerId);
}
function go(page) {
  $$('.page').forEach((element) => element.classList.toggle('active', element.id === `page-${page}`));
  const navPage = page === 'customer' ? 'khata' : page;
  $$('[data-page]').forEach((button) => button.classList.toggle('active', button.dataset.page === navPage));
  $('#crumb-page').textContent = page === 'customer' ? 'Customer history' : page === 'khata' ? 'Digital khata' : page === 'analytics' ? 'Analytics' : 'Overview';
  if (page === 'khata') renderCustomers();
  if (page === 'customer') renderCustomerDetail();
  if (page === 'analytics') renderSummary();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
$$('[data-page]').forEach((button) => button.addEventListener('click', () => go(button.dataset.page)));
$$('[data-goto]').forEach((button) => button.addEventListener('click', () => go(button.dataset.goto)));
$$('[data-open-entry]').forEach((button) => button.addEventListener('click', () => openEntry()));
$('#customer-rows').addEventListener('click', (event) => {
  const row = event.target.closest('tr[data-customer-id]');
  if (row) openCustomerDetail(row.dataset.customerId);
});
$('#customer-rows').addEventListener('keydown', (event) => {
  const row = event.target.closest('tr[data-customer-id]');
  if (row && (event.key === 'Enter' || event.key === ' ')) {
    event.preventDefault();
    openCustomerDetail(row.dataset.customerId);
  }
});
$('#home-customers').addEventListener('click', (event) => {
  const customerButton = event.target.closest('[data-customer-id]');
  if (customerButton) openCustomerDetail(customerButton.dataset.customerId);
});
$('#customer-back').addEventListener('click', () => go('khata'));
$('#customer-detail-new-entry').addEventListener('click', () => openEntry(selectedCustomerId));
$('#customer-history-rows').addEventListener('click', (event) => {
  if (event.target.closest('[data-retry-customer-history]')) loadCustomerLedger(selectedCustomerId);
});

function openCustomer() {
  $('#customer-dialog').showModal();
  $('#new-name').focus();
}
let openEntryAfterCustomer = false;
let manualEntryAfterCustomer = null;
function openEntry(selectedCustomerId = '', draft = null) {
  if (!customers.length) {
    openEntryAfterCustomer = true;
    manualEntryAfterCustomer = draft;
    openCustomer();
    toast('Add a customer first, then record their entry.');
    return;
  }
  $('#transaction-form').reset();
  populateCustomerSelect(selectedCustomerId);
  if (draft) {
    if (!draft.customerId || draft.ambiguousCustomerIds?.length > 1) $('#transaction-customer').value = '';
    $('#transaction-type').value = draft.type === 'payment' ? 'payment' : 'credit';
    $('#transaction-amount').value = draft.amount == null ? '' : String(draft.amount);
    $('#transaction-note').value = draft.raw || '';
  }
  $('#transaction-dialog').showModal();
  $('#transaction-customer').focus();
}
function populateCustomerSelect(selectedId = '') {
  const select = $('#transaction-customer');
  const ordered = customers.slice().sort((a, b) => a.name.localeCompare(b.name));
  const nameCounts = new Map();
  for (const customer of ordered) {
    const key = customerNameMatchKey(customer.name);
    nameCounts.set(key, (nameCounts.get(key) || 0) + 1);
  }
  const options = ordered.map((customer) => {
    const duplicate = nameCounts.get(customerNameMatchKey(customer.name)) > 1;
    const identity = duplicate ? (customer.phone ? ` · ${customer.phone}` : ` · account ${customer.id.slice(-4)}`) : '';
    return `<option value="${esc(customer.id)}">${esc(customer.name)}${identity} · balance ${money(balanceOf(customer.id))}</option>`;
  }).join('');
  select.innerHTML = `<option value="" disabled>Choose a customer</option>${options}`;
  select.value = selectedId || (ordered.length === 1 ? ordered[0].id : '');
}
$('#shop-profile').addEventListener('click', () => $('#profile-dialog').showModal());
$('#profile-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    merchant = await api('/api/v1/auth/me', {
      method: 'PATCH',
      body: JSON.stringify({
        name: $('#shop-name-input').value.trim(),
        owner_name: $('#owner-name-input').value.trim() || null,
        location: $('#shop-location-input').value.trim() || null,
      }),
    });
    profile = { shopName: merchant.name, ownerName: merchant.owner_name || '', location: merchant.location || '' };
    renderAll();
    $('#profile-dialog').close();
    toast('Shop details saved to your account');
  } catch (error) {
    toast(error.message);
  }
});
$('#add-customer').addEventListener('click', openCustomer);
function clearPendingCustomerEntry() {
  openEntryAfterCustomer = false;
  manualEntryAfterCustomer = null;
}
$('#customer-dialog .dialog-close').addEventListener('click', clearPendingCustomerEntry);
$('#customer-dialog').addEventListener('cancel', clearPendingCustomerEntry);
$('#customer-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (savingCustomer) return;
  savingCustomer = true;
  const submitButton = event.target.querySelector('[type="submit"]');
  submitButton.disabled = true;
  const name = $('#new-name').value.trim();
  const phone = $('#new-phone').value.trim();
  try {
    const created = await api('/api/v1/customers', { method: 'POST', body: JSON.stringify({ name, phone: phone || null }) });
    await loadWorkspace();
    renderAll();
    $('#customer-dialog').close();
    event.target.reset();
    toast(`${name} added to your khata`);
    if (openEntryAfterCustomer) {
      openEntryAfterCustomer = false;
      const correction = manualEntryAfterCustomer;
      manualEntryAfterCustomer = null;
      openEntry(created.id, correction);
    }
  } catch (error) {
    if (error.status === 409 && error.message.toLowerCase().includes('customer with this name already exists')) {
      try {
        await loadWorkspace();
        renderAll();
        const matches = customers.filter((customer) => sameCustomerName(customer.name, name));
        if (matches.length) {
          $('#customer-dialog').close();
          event.target.reset();
          openEntryAfterCustomer = false;
          const correction = manualEntryAfterCustomer;
          manualEntryAfterCustomer = null;
          if (matches.length === 1) {
            openEntry(matches[0].id, correction);
            toast(`${matches[0].name} is already in your khata. Choose udhaar or payment for them; use a distinguishing name for a different person.`);
          } else {
            openEntry('', correction);
            toast(`More than one ${name} is in your khata. Choose the correct account by phone or account number.`);
          }
          return;
        }
      } catch (refreshError) {
        toast(`Customer already exists. Could not refresh your list: ${refreshError.message}`);
        return;
      }
    }
    toast(error.message);
  } finally {
    savingCustomer = false;
    submitButton.disabled = false;
  }
});
$('#add-transaction').addEventListener('click', () => openEntry());
$('#transaction-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (savingLedger) return;
  const customerId = $('#transaction-customer').value;
  const amount = Number($('#transaction-amount').value);
  const type = $('#transaction-type').value;
  const note = $('#transaction-note').value.trim();
  if (!customerId || !Number.isFinite(amount) || amount <= 0) {
    toast('Choose a customer and enter an amount greater than zero.');
    return;
  }
  savingLedger = true;
  const submitButton = event.target.querySelector('[type="submit"]');
  submitButton.disabled = true;
  try {
    await createLedgerEntry(customerId, amount, type, note);
    $('#transaction-dialog').close();
    event.target.reset();
    toast('Entry saved to your khata');
    const spokenType = type === 'credit' ? 'उधार की एंट्री' : 'जमा की एंट्री';
    speakText(`${customerName(customerId)}, ${amount} रुपये की ${spokenType} सेव हो गई।`);
  } catch (error) {
    toast(error.message);
  } finally {
    savingLedger = false;
    submitButton.disabled = false;
  }
});
async function createLedgerEntry(customerId, amount, type, note = '') {
  const payload = { customer_id: customerId, amount, entry_type: type === 'credit' ? 'udhaar' : 'jama', note: note || null };
  const signature = JSON.stringify(payload);
  if (!pendingLedgerRequest || pendingLedgerRequest.signature !== signature) {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const key = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    pendingLedgerRequest = { signature, key };
    sessionStorage.setItem(PENDING_ENTRY_KEY, JSON.stringify(pendingLedgerRequest));
  }
  await api('/api/v1/ledger/entries', {
    method: 'POST',
    headers: { 'Idempotency-Key': pendingLedgerRequest.key },
    body: JSON.stringify(payload),
  });
  await loadWorkspace();
  renderAll();
  pendingLedgerRequest = null;
  sessionStorage.removeItem(PENDING_ENTRY_KEY);
}
$('#help-btn').addEventListener('click', () => toast('Your customer and ledger data sync with the VoiceKhata backend.'));
$('#customer-search').addEventListener('input', renderCustomers);
$('#balance-filter').addEventListener('change', renderCustomers);
$('#voice-language').disabled = true;
$('#voice-language').textContent = 'HI+EN';
$('#voice-language').setAttribute('aria-label', 'Hindi and Hinglish voice input');
$('#voice-language').title = 'Hindi voice input with common English words';

const NUMBER_WORDS = { zero:0, one:1, ek:1, 'एक':1, two:2, do:2, 'दो':2, three:3, teen:3, 'तीन':3, four:4, char:4, chaar:4, 'चार':4, five:5, paanch:5, panch:5, 'पांच':5, 'पाँच':5, six:6, chhe:6, 'छह':6, seven:7, saat:7, 'सात':7, eight:8, aath:8, 'आठ':8, nine:9, nau:9, 'नौ':9, ten:10, das:10, 'दस':10, eleven:11, gyarah:11, 'ग्यारह':11, twelve:12, barah:12, 'बारह':12, thirteen:13, terah:13, 'तेरह':13, fourteen:14, chaudah:14, 'चौदह':14, fifteen:15, pandrah:15, 'पंद्रह':15, sixteen:16, solah:16, 'सोलह':16, seventeen:17, satrah:17, 'सत्रह':17, eighteen:18, atharah:18, 'अठारह':18, nineteen:19, unnis:19, 'उन्नीस':19, twenty:20, bees:20, 'बीस':20, thirty:30, tees:30, 'तीस':30, forty:40, chalis:40, 'चालीस':40, fifty:50, pachaas:50, 'पचास':50, sixty:60, saath:60, 'साठ':60, seventy:70, sattar:70, 'सत्तर':70, eighty:80, assi:80, 'अस्सी':80, ninety:90, nabbe:90, 'नब्बे':90, hundred:100, sau:100, 'सौ':100, thousand:1000, hazaar:1000, 'हजार':1000, lakh:100000, lac:100000 };
function normaliseDigits(value) {
  return value.replace(/[०-९]/g, (digit) => String('०१२३४५६७८९'.indexOf(digit)));
}
function spokenAmount(text) {
  // Hindi vowel marks are Unicode combining marks, so include them in each word.
  const tokens = [...text.matchAll(/[\p{L}\p{M}]+/gu)];
  let best = null;
  for (let i = 0; i < tokens.length; i += 1) {
    if (!(tokens[i][0].toLowerCase() in NUMBER_WORDS)) continue;
    let total = 0;
    let current = 0;
    let last = i;
    for (let j = i; j < tokens.length; j += 1) {
      const key = tokens[j][0].toLowerCase();
      if (!(key in NUMBER_WORDS)) break;
      last = j;
      const value = NUMBER_WORDS[key];
      if (value === 100) current = Math.max(1, current) * 100;
      else if (value >= 1000) { total += Math.max(1, current) * value; current = 0; }
      else current += value;
    }
    const value = total + current;
    if (value > 0 && (!best || last - i > best.tokenEnd - best.tokenStart)) {
      best = {
        charStart: tokens[i].index,
        charEnd: tokens[last].index + tokens[last][0].length,
        tokenStart: i,
        tokenEnd: last,
        value,
      };
    }
  }
  return best;
}
function parseCommand(raw) {
  const text = normaliseDigits(raw.trim());
  if (!text) return null;
  const numeric = text.match(/(?:₹\s*)?(\d[\d,]*(?:\.\d{1,2})?)/);
  let amount;
  let amountSpan = [text.length, text.length];
  if (numeric) {
    amount = Number(numeric[1].replace(/,/g, ''));
    amountSpan = [numeric.index, numeric.index + numeric[0].length];
  } else {
    const word = spokenAmount(text);
    if (word) {
      amount = word.value;
      amountSpan = [word.charStart, word.charEnd];
    }
  }
  if (amount !== undefined && amount !== null && (!Number.isFinite(amount) || amount <= 0)) return { error: 'Please give an amount greater than zero.' };
  const customerText = commandCustomerName(`${text.slice(0, amountSpan[0])} ${text.slice(amountSpan[1])}`);
  const isPayment = /(jama|mil[eai]|paid|payment|received|vasool|जमा|मिले|मिला)/iu.test(text);
  const isCredit = /(udhaar|udhar|credit|उधार|उधर|उधारी|लिखो|लिख)/iu.test(text);
  const typeSpecified = isPayment || isCredit;
  const normalized = customerNameMatchKey(customerText);
  const matches = customers.filter((customer) => normalized === customerNameMatchKey(customer.name));
  const suggestions = matches.length ? [] : customers.filter((customer) => namesOneEditApart(normalized, customer.name));
  let name = matches[0]?.name;
  if (!name) name = customerText.split(' ').filter(Boolean).slice(0, 3).join(' ').replace(/\b\w/g, (char) => char.toUpperCase());
  if (!name) return { error: 'Say the customer’s name and the amount.' };
  return {
    customer: name,
    customerId: matches.length === 1 ? matches[0].id : null,
    ambiguousCustomerIds: matches.length > 1 ? matches.map((customer) => customer.id) : [],
    suggestedCustomerIds: suggestions.map((customer) => customer.id),
    amount: amount ?? null,
    type: isPayment ? 'payment' : 'credit',
    typeSpecified,
    raw: raw.trim(),
  };
}
function showVoiceConfirmation(entry) {
  const existing = customers.find((customer) => customer.id === entry.customerId);
  const ambiguous = entry.ambiguousCustomerIds?.length > 1;
  const suggestions = !existing && !ambiguous
    ? customers.filter((customer) => (entry.suggestedCustomerIds || []).includes(customer.id))
    : [];
  const needsChoice = ambiguous || suggestions.length > 0;
  const choiceLabel = $('#voice-customer-choice-wrap');
  const choice = $('#voice-customer-choice');
  choiceLabel.hidden = !needsChoice;
  choice.required = needsChoice;
  if (ambiguous) {
    const matches = customers.filter((customer) => entry.ambiguousCustomerIds.includes(customer.id));
    choice.innerHTML = `<option value="">Choose the right account</option>${matches.map((customer) => `<option value="${esc(customer.id)}">${esc(customer.name)}${customer.phone ? ` · ${esc(customer.phone)}` : ` · account ${esc(customer.id.slice(-4))}`} · balance ${money(balanceOf(customer.id))}</option>`).join('')}`;
    choice.value = '';
    $('#confirm-title').textContent = 'Which customer is this?';
    $('#confirm-copy').textContent = `I found more than one ${entry.customer}. Choose the right account, then confirm ${money(entry.amount)} as ${entry.type === 'credit' ? 'udhaar' : 'a payment'}.`;
  } else if (suggestions.length) {
    choice.innerHTML = `<option value="">Choose the correct name</option><option value="new">New customer: ${esc(entry.customer)}</option>${suggestions.map((customer) => `<option value="${esc(customer.id)}">Existing: ${esc(customer.name)}${customer.phone ? ` · ${esc(customer.phone)}` : ` · account ${esc(customer.id.slice(-4))}`} · balance ${money(balanceOf(customer.id))}</option>`).join('')}`;
    choice.value = '';
    $('#confirm-title').textContent = 'Check the customer name';
    $('#confirm-copy').textContent = `I heard “${entry.customer}”, which is close to an existing name. Choose the right account or select New customer. Then confirm ${money(entry.amount)} as ${entry.type === 'credit' ? 'udhaar' : 'a payment'}.`;
  } else {
    choice.innerHTML = '';
    choice.required = false;
    $('#confirm-title').textContent = existing ? 'Add this to the existing khata?' : 'Create a new khata?';
    $('#confirm-copy').textContent = existing
      ? `Add ${money(entry.amount)} as ${entry.type === 'credit' ? 'udhaar for' : 'payment from'} ${existing.name}?`
      : `I heard “${entry.customer}”. Check the name carefully before saving ${money(entry.amount)} as ${entry.type === 'credit' ? 'udhaar' : 'a payment'}. If it is wrong or an existing customer, choose “Let me fix it”.`;
  }
  $('#confirm-dialog').showModal();
}
function openManualCorrection(entry) {
  if (!entry.customerId && !entry.ambiguousCustomerIds?.length && entry.type === 'credit') {
    openEntryAfterCustomer = true;
    manualEntryAfterCustomer = entry;
    $('#customer-form').reset();
    $('#new-name').value = entry.customer;
    openCustomer();
    toast('Check the customer name. After adding them, you can correct the amount and entry type.');
    return;
  }
  if (!customers.length) {
    openEntryAfterCustomer = true;
    manualEntryAfterCustomer = entry;
    $('#customer-form').reset();
    $('#new-name').value = entry.customer || '';
    openCustomer();
    toast('Add the customer first. The entry details will be ready to review next.');
    return;
  }
  openEntryAfterCustomer = false;
  manualEntryAfterCustomer = null;
  openEntry(entry.customerId || '', entry);
}
function cancelVoiceSession(sessionId) {
  if (sessionId) api(`/api/v1/voice/sessions/${sessionId}/cancel`, { method: 'POST' }).catch(() => {});
}
function prepareVoiceEntry(raw, sessionId = null) {
  const parsed = parseCommand(raw);
  if (!parsed) { cancelVoiceSession(sessionId); return; }
  if (parsed.error) { cancelVoiceSession(sessionId); toast(parsed.error); speakText(parsed.error); return; }
  parsed.sessionId = sessionId;
  pendingVoiceEntry = parsed;
  beginVoiceConfirmation(parsed);
}
function voiceConfirmationPrompt(entry) {
  const amount = Number(entry.amount).toLocaleString(voiceLanguage === 'hi-IN' ? 'hi-IN' : 'en-IN');
  const relation = entry.type === 'credit' ? 'उधार' : 'जमा';
  const englishRelation = entry.type === 'credit' ? 'credit' : 'payment';
  const existing = customers.find((customer) => customer.id === entry.customerId);
  const choices = entry.ambiguousCustomerIds?.length
    ? customers.filter((customer) => entry.ambiguousCustomerIds.includes(customer.id))
    : (entry.suggestedCustomerIds || []).length
      ? customers.filter((customer) => entry.suggestedCustomerIds.includes(customer.id))
      : [];
  const choiceLabels = choices.map((customer) => customer.phone
    ? `${customer.name}, phone ending ${customer.phone.replace(/\D/g, '').slice(-4)}`
    : customer.name);
  if (voiceLanguage !== 'hi-IN') {
    if (choices.length) return `I heard ${entry.customer}. Similar accounts: ${choiceLabels.join('; ')}. Say the correct name or phone ending${entry.suggestedCustomerIds?.length ? ', say new for a new customer' : ''}, or say cancel.`;
    return existing
      ? `${existing.name}, ${amount} rupees ${englishRelation}. Say yes to save, or no to cancel.`
      : `I heard ${entry.customer}. Create this customer and record ${amount} rupees as a ${englishRelation}? Say yes to save, or no to cancel.`;
  }
  if (choices.length) return `मैंने ${entry.customer} सुना। मिलते-जुलते खाते हैं: ${choiceLabels.join('; ')}। सही ग्राहक का नाम या फोन के आखिरी चार अंक बोलें${entry.suggestedCustomerIds?.length ? ', नया ग्राहक बनाने के लिए नया बोलें' : ''}, या रद्द करने के लिए नहीं बोलें।`;
  return existing
    ? `${existing.name}, ${amount} रुपये ${relation}। सही है तो हाँ बोलें। रद्द करने के लिए नहीं बोलें।`
    : `${entry.customer}, ${amount} रुपये ${relation}। नया खाता बनाकर सेव करने के लिए हाँ बोलें। रद्द करने के लिए नहीं बोलें।`;
}
function beginVoiceConfirmation(entry) {
  voiceConversation = { entry, customerResolved: false, candidates: [], candidateKind: '', newCustomerName: '' };
  pendingVoiceEntry = entry;
  advanceVoiceConversation();
}
function fallbackConversationToForm(entry, message) {
  stopVoiceReply();
  cancelVoiceSession(entry.sessionId);
  pendingVoiceEntry = null;
  voiceConversation = null;
  if (message) toast(`${message} I’m opening the entry form so you can finish safely.`);
  openManualCorrection(entry);
}
function askConversationQuestion(entry, prompt, onAnswer) {
  pendingVoiceEntry = entry;
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const canUseGnaniForAnswers = gnaniSttEnabled && window.MediaRecorder && navigator.mediaDevices?.getUserMedia && (window.AudioContext || window.webkitAudioContext);
  if ((!canUseGnaniForAnswers && !SpeechRecognition) || (!('speechSynthesis' in window) && !gnaniTtsEnabled)) {
    fallbackConversationToForm(entry, 'Hands-free questions are not available in this browser.');
    return;
  }
  awaitingVoiceReply = true;
  $('#voice-title').textContent = 'Please answer by voice';
  $('#voice-subtitle').textContent = 'I will ask one question at a time.';
  $('#voice-caption').innerHTML = '<span class="voice-dot"></span><span>Speaking a question…</span>';
  speakText(prompt).then((played) => {
    if (!awaitingVoiceReply || pendingVoiceEntry !== entry) return;
    if (!played) { fallbackConversationToForm(entry, 'Could not play the voice question.'); return; }
    listenForVoiceConfirmation(entry, SpeechRecognition, 0, onAnswer, (message) => fallbackConversationToForm(entry, message));
  });
}
function transcriptWords(value) {
  return [...String(value || '').normalize('NFC').toLocaleLowerCase('en-IN').matchAll(/[\p{L}\p{M}]+/gu)].map((match) => match[0]);
}
function responseHas(words, options) { return words.some((word) => options.has(word)); }
function parseAmountReply(raw) {
  const text = normaliseDigits(String(raw || '').trim());
  const numeric = text.match(/(?:₹\s*)?(\d[\d,]*(?:\.\d{1,2})?)/);
  if (numeric) {
    const amount = Number(numeric[1].replace(/,/g, ''));
    return Number.isFinite(amount) && amount > 0 ? amount : null;
  }
  const spoken = spokenAmount(text);
  return spoken?.value > 0 ? spoken.value : null;
}
function cleanCustomerNameReply(raw) {
  const withoutPolitePhrase = normaliseDigits(String(raw || ''))
    .replace(/(?:नाम से सेव कर दो|नाम सेव कर दो|save (?:it )?as|save (?:this )?name|सेव कर दो|सेव करो|save it|save)/giu, ' ')
    .replace(/\b\d[\d,]*(?:\.\d{1,2})?\b/gu, ' ')
    .replace(/^(?:नया|नयी|नए|new)\s+/iu, ' ');
  return commandCustomerName(withoutPolitePhrase);
}
function voiceIntent(words) {
  const yes = responseHas(words, new Set(['yes', 'yeah', 'haan', 'han', 'हाँ', 'हां', 'हा', 'जी', 'सही', 'ठीक']));
  const no = responseHas(words, new Set(['no', 'nahi', 'nahin', 'नहीं', 'नही', 'ना', 'रद्द', 'cancel']));
  const old = responseHas(words, new Set(['old', 'existing', 'purana', 'purani', 'purane', 'पहले', 'पहला', 'पुराना', 'पुरानी', 'पुराने', 'वही']));
  const isNew = responseHas(words, new Set(['new', 'naya', 'nayi', 'naye', 'नया', 'नयी', 'नए', 'नया']));
  return { yes, no, old, isNew };
}
function resolveVoiceCustomer(customer) {
  const state = voiceConversation;
  if (!state) return;
  state.entry.customer = customer.name;
  state.entry.customerId = customer.id;
  state.entry.ambiguousCustomerIds = [];
  state.entry.suggestedCustomerIds = [];
  state.customerResolved = true;
  advanceVoiceConversation();
}
function setVoiceCustomerCandidates(candidates, kind) {
  const state = voiceConversation;
  if (!state) return;
  state.candidates = candidates;
  state.candidateKind = kind;
  state.entry.customerId = null;
  state.entry.ambiguousCustomerIds = kind === 'exact' && candidates.length > 1 ? candidates.map((customer) => customer.id) : [];
  state.entry.suggestedCustomerIds = kind === 'similar' ? candidates.map((customer) => customer.id) : [];
}
function beginNewVoiceCustomerName(requireDistinct) {
  const state = voiceConversation;
  if (!state) return;
  const name = state.entry.customer;
  const prompt = requireDistinct
    ? `${name} नाम का customer पहले से है। New customer को किस अलग नाम से save करूँ? Example: ${name} - दूध वाले।`
    : `क्या new customer को ${name} नाम से save करूँ? हाँ बोलें, या कोई अलग पहचान वाला नाम बताएँ।`;
  askConversationQuestion(state.entry, prompt, (heard) => {
    const words = transcriptWords(heard);
    const intent = voiceIntent(words);
    if (!requireDistinct && intent.yes) {
      state.newCustomerName = name;
      state.entry.customer = name;
      state.entry.customerId = null;
      state.entry.suggestedCustomerIds = [];
      state.entry.ambiguousCustomerIds = [];
      state.customerResolved = true;
      advanceVoiceConversation();
      return;
    }
    const candidateName = cleanCustomerNameReply(heard);
    if (!requireDistinct && intent.no) {
      askConversationQuestion(state.entry, `ठीक है। Customer का अलग नाम बताएँ, जैसे ${name} - दूध वाले।`, (differentName) => {
        const resolvedName = cleanCustomerNameReply(differentName);
        if (!resolvedName || customers.some((customer) => sameCustomerName(customer.name, resolvedName))) {
          beginNewVoiceCustomerName(true);
          return;
        }
        state.newCustomerName = resolvedName;
        state.entry.customer = resolvedName;
        state.entry.customerId = null;
        state.entry.suggestedCustomerIds = [];
        state.entry.ambiguousCustomerIds = [];
        state.customerResolved = true;
        advanceVoiceConversation();
      });
      return;
    }
    if (!candidateName || candidateName.length > 120) {
      beginNewVoiceCustomerName(requireDistinct);
      return;
    }
    if (requireDistinct && intent.no) {
      beginNewVoiceCustomerName(true);
      return;
    }
    const duplicate = customers.some((customer) => sameCustomerName(customer.name, candidateName));
    if (duplicate) {
      state.entry.customer = candidateName;
      beginNewVoiceCustomerName(true);
      return;
    }
    state.newCustomerName = candidateName;
    state.entry.customer = candidateName;
    state.entry.customerId = null;
    state.entry.suggestedCustomerIds = [];
    state.entry.ambiguousCustomerIds = [];
    state.customerResolved = true;
    advanceVoiceConversation();
  });
}
function startVoiceCustomerResolution() {
  const state = voiceConversation;
  if (!state) return;
  const entry = state.entry;
  const exact = customers.filter((customer) => sameCustomerName(customer.name, entry.customer));
  const similar = exact.length ? [] : customers.filter((customer) => (entry.suggestedCustomerIds || []).includes(customer.id));
  const candidates = exact.length ? exact : similar;
  if (candidates.length) {
    const kind = exact.length ? 'exact' : 'similar';
    setVoiceCustomerCandidates(candidates, kind);
    const details = candidates.map((customer) => customer.phone
      ? `${customer.name}, फोन के आखिरी चार अंक ${customer.phone.replace(/\D/g, '').slice(-4)}`
      : customer.name).join(' या ');
    const prompt = exact.length
      ? `${entry.customer} नाम का customer पहले से है। क्या यह existing customer है या new customer? पुराना या नया बोलें।`
      : `मैंने ${entry.customer} सुना। Existing customer ${details} मिलता-जुलता है। क्या वही customer है या new customer? पुराना या नया बोलें।`;
    askConversationQuestion(entry, prompt, (heard) => {
      const words = transcriptWords(heard);
      const intent = voiceIntent(words);
      if (intent.old) {
        if (candidates.length === 1) { resolveVoiceCustomer(candidates[0]); return; }
        const selected = voiceReplyChoice(entry, heard);
        if (selected) { resolveVoiceCustomer(selected); return; }
        askConversationQuestion(entry, `कई पुराने खाते मिले। सही खाते का फोन नंबर, आखिरी चार अंक बोलें।`, (accountReply) => {
          const choice = voiceReplyChoice(entry, accountReply);
          if (choice) resolveVoiceCustomer(choice);
          else fallbackConversationToForm(entry, 'I could not identify the old account.');
        });
        return;
      }
      if (intent.isNew) { beginNewVoiceCustomerName(true); return; }
      askConversationQuestion(entry, `पुराना ${entry.customer} या नया ग्राहक बोलें।`, arguments_ => {
        const next = voiceIntent(transcriptWords(arguments_));
        if (next.old && candidates.length === 1) resolveVoiceCustomer(candidates[0]);
        else if (next.isNew) beginNewVoiceCustomerName(true);
        else fallbackConversationToForm(entry, 'I could not tell which customer you meant.');
      });
    });
    return;
  }
  setVoiceCustomerCandidates([], 'new');
  askConversationQuestion(entry, `${entry.customer} नाम का existing customer नहीं मिला। क्या यह new customer है? हाँ या नहीं बोलें।`, (heard) => {
    const intent = voiceIntent(transcriptWords(heard));
    if (intent.yes || intent.isNew) { beginNewVoiceCustomerName(false); return; }
    if (intent.no) {
      askConversationQuestion(entry, `पुराने ग्राहक का पूरा नाम बोलें।`, (nameReply) => {
        const oldName = cleanCustomerNameReply(nameReply);
        if (!oldName) { fallbackConversationToForm(entry, 'I could not hear the customer name.'); return; }
        entry.customer = oldName;
        entry.suggestedCustomerIds = [];
        startVoiceCustomerResolution();
      });
      return;
    }
    startVoiceCustomerResolution();
  });
}
function advanceVoiceConversation() {
  const state = voiceConversation;
  if (!state) return;
  const entry = state.entry;
  if (entry.amount == null) {
    askConversationQuestion(entry, `कितने रुपये की एंट्री करनी है?`, (heard) => {
      const amount = parseAmountReply(heard);
      if (!amount) {
        askConversationQuestion(entry, `रुपयों की संख्या साफ बोलें, जैसे पाँच सौ।`, (retry) => {
          const retryAmount = parseAmountReply(retry);
          if (!retryAmount) fallbackConversationToForm(entry, 'I could not understand the amount.');
          else { entry.amount = retryAmount; advanceVoiceConversation(); }
        });
      } else { entry.amount = amount; advanceVoiceConversation(); }
    });
    return;
  }
  if (!entry.typeSpecified) {
    askConversationQuestion(entry, `यह उधार है या जमा पेमेंट?`, (heard) => {
      const words = transcriptWords(heard);
      if (responseHas(words, new Set(['उधार', 'उधर', 'उधारी', 'udhaar', 'udhar', 'credit']))) {
        entry.type = 'credit'; entry.typeSpecified = true; advanceVoiceConversation(); return;
      }
      if (responseHas(words, new Set(['जमा', 'jama', 'payment', 'paid', 'मिले', 'मिला', 'received']))) {
        entry.type = 'payment'; entry.typeSpecified = true; advanceVoiceConversation(); return;
      }
      askConversationQuestion(entry, `कृपया साफ बोलें: उधार या जमा?`, (retry) => {
        const next = transcriptWords(retry);
        if (responseHas(next, new Set(['उधार', 'उधर', 'उधारी', 'udhaar', 'udhar', 'credit']))) { entry.type = 'credit'; entry.typeSpecified = true; advanceVoiceConversation(); }
        else if (responseHas(next, new Set(['जमा', 'jama', 'payment', 'paid', 'मिले', 'मिला', 'received']))) { entry.type = 'payment'; entry.typeSpecified = true; advanceVoiceConversation(); }
        else fallbackConversationToForm(entry, 'I could not understand udhaar or payment.');
      });
    });
    return;
  }
  if (!state.customerResolved) { startVoiceCustomerResolution(); return; }
  entry.customer = state.newCustomerName || entry.customer;
  pendingVoiceEntry = entry;
  voiceConversation = null;
  askConversationQuestion(entry, voiceConfirmationPrompt(entry), (heard) => handleVoiceConfirmationReply(entry, heard, window.SpeechRecognition || window.webkitSpeechRecognition, 0));
}
function releaseVoiceReplyAudio() {
  if (voiceReplyStream) { voiceReplyStream.getTracks().forEach((track) => track.stop()); voiceReplyStream = null; }
  if (voiceReplyContext) { voiceReplyContext.close().catch(() => {}); voiceReplyContext = null; }
  if (voiceReplyFrame) cancelAnimationFrame(voiceReplyFrame);
  voiceReplyFrame = 0;
}
function listenForGnaniReply(entry, onReply, onFallback) {
  discardVoiceReply = false;
  let chunks = [];
  let hasSpeech = false;
  let silenceStartedAt = 0;
  let handled = false;
  const finishFallback = (message) => {
    if (handled) return;
    handled = true;
    discardVoiceReply = true;
    releaseVoiceReplyAudio();
    stopVoiceReply();
    if (onFallback) onFallback(message);
    else showVoiceReplyFallback(entry, message);
  };
  const finishRecording = () => {
    if (voiceReplyRecorder?.state === 'recording') voiceReplyRecorder.stop();
  };
  (async () => {
    try {
      voiceReplyStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (!awaitingVoiceReply || pendingVoiceEntry !== entry) { releaseVoiceReplyAudio(); return; }
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext || !window.MediaRecorder) throw new Error('This browser cannot record voice answers.');
      voiceReplyContext = new AudioContext();
      if (voiceReplyContext.state === 'suspended') await voiceReplyContext.resume();
      const analyserNode = voiceReplyContext.createAnalyser();
      analyserNode.fftSize = 256;
      voiceReplyContext.createMediaStreamSource(voiceReplyStream).connect(analyserNode);
      const samples = new Uint8Array(analyserNode.fftSize);
      const mimeType = typeof MediaRecorder.isTypeSupported === 'function'
        ? ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find((type) => MediaRecorder.isTypeSupported(type))
        : '';
      voiceReplyRecorder = mimeType ? new MediaRecorder(voiceReplyStream, { mimeType }) : new MediaRecorder(voiceReplyStream);
      voiceReplyRecorder.ondataavailable = (event) => { if (event.data?.size) chunks.push(event.data); };
      voiceReplyRecorder.onerror = () => finishFallback('Could not record your answer. Please try again.');
      voiceReplyRecorder.onstop = async () => {
        const recorder = voiceReplyRecorder;
        voiceReplyRecorder = null;
        if (voiceReplyTimer) { clearTimeout(voiceReplyTimer); voiceReplyTimer = null; }
        const audio = new Blob(chunks, { type: recorder?.mimeType || 'audio/webm' });
        chunks = [];
        releaseVoiceReplyAudio();
        if (handled || discardVoiceReply || !awaitingVoiceReply || pendingVoiceEntry !== entry) return;
        if (!audio.size || audio.size < 2048) { finishFallback('I did not hear your answer. Please try again.'); return; }
        try {
          $('#voice-caption').innerHTML = '<span class="voice-dot"></span><span>Checking your answer…</span>';
          const wav = await encodeWav16k(audio);
          const form = new FormData();
          form.append('audio', wav, 'voice-answer.wav');
          form.append('language_code', voiceLanguage);
          const result = await api('/api/v1/voice/transcribe', { method: 'POST', body: form });
          if (!awaitingVoiceReply || pendingVoiceEntry !== entry) return;
          handled = true;
          stopVoiceReply();
          if (onReply) onReply(result.transcript);
          else handleVoiceConfirmationReply(entry, result.transcript, window.SpeechRecognition || window.webkitSpeechRecognition, 0);
        } catch (error) {
          finishFallback(error.message || 'Could not understand your answer. Please try again.');
        }
      };
      voiceReplyRecorder.start(200);
      $('#voice-caption').innerHTML = '<span class="voice-dot"></span><span>Listening… speak your answer</span>';
      const monitor = () => {
        if (!awaitingVoiceReply || pendingVoiceEntry !== entry || handled || !voiceReplyRecorder || voiceReplyRecorder.state !== 'recording') return;
        analyserNode.getByteTimeDomainData(samples);
        let energy = 0;
        for (const value of samples) { const normalized = (value - 128) / 128; energy += normalized * normalized; }
        const rms = Math.sqrt(energy / samples.length);
        if (rms > 0.018) { hasSpeech = true; silenceStartedAt = 0; }
        else if (hasSpeech) {
          if (!silenceStartedAt) silenceStartedAt = performance.now();
          else if (performance.now() - silenceStartedAt >= 850) { finishRecording(); return; }
        }
        voiceReplyFrame = requestAnimationFrame(monitor);
      };
      voiceReplyTimer = setTimeout(() => {
        if (!hasSpeech) { finishFallback('I did not hear your answer. Please try again.'); return; }
        finishRecording();
      }, 9000);
      monitor();
    } catch (error) {
      finishFallback(error.name === 'NotAllowedError' ? 'Allow microphone access to answer by voice.' : (error.message || 'Could not start the microphone.'));
    }
  })();
}
function stopVoiceReply() {
  awaitingVoiceReply = false;
  if (voiceReplyTimer) { clearTimeout(voiceReplyTimer); voiceReplyTimer = null; }
  const active = voiceReplyRecognition;
  voiceReplyRecognition = null;
  if (active) { active.onresult = null; active.onerror = null; active.onend = null; try { active.abort(); } catch {} }
  if (voiceReplyRecorder) {
    discardVoiceReply = true;
    const recorder = voiceReplyRecorder;
    voiceReplyRecorder = null;
    if (recorder.state === 'recording') { recorder.onstop = null; try { recorder.stop(); } catch {} }
    releaseVoiceReplyAudio();
  }
}
function showVoiceReplyFallback(entry, message) {
  if (!awaitingVoiceReply) return;
  stopVoiceReply();
  showVoiceConfirmation(entry);
  if (message) toast(`${message} Use the confirmation controls on screen.`);
}
function listenForVoiceConfirmation(entry, SpeechRecognition, attempt, onReply = null, onFallback = null) {
  if (!awaitingVoiceReply || pendingVoiceEntry !== entry) return;
  if (gnaniSttEnabled && window.MediaRecorder && navigator.mediaDevices?.getUserMedia && (window.AudioContext || window.webkitAudioContext)) {
    listenForGnaniReply(entry, onReply, onFallback);
    return;
  }
  let reply;
  try {
    reply = new SpeechRecognition();
    reply.lang = voiceLanguage;
    reply.interimResults = false;
    reply.continuous = false;
    voiceReplyRecognition = reply;
    $('#voice-caption').innerHTML = '<span class="voice-dot"></span><span>Listening for your answer…</span>';
    reply.onresult = (event) => {
      const heard = Array.from(event.results).map((result) => result[0].transcript).join(' ').trim();
      stopVoiceReply();
      if (onReply) onReply(heard);
      else handleVoiceConfirmationReply(entry, heard, SpeechRecognition, attempt);
    };
    reply.onerror = (event) => {
      if (awaitingVoiceReply) {
        if (onFallback) { stopVoiceReply(); onFallback(event.error === 'not-allowed' ? 'Allow microphone access to confirm by voice.' : 'I could not hear your answer.'); }
        else showVoiceReplyFallback(entry, event.error === 'not-allowed' ? 'Allow microphone access to confirm by voice.' : 'I could not hear your answer.');
      }
    };
    reply.onend = () => {
      if (awaitingVoiceReply) {
        if (onFallback) { stopVoiceReply(); onFallback('I did not hear an answer.'); }
        else showVoiceReplyFallback(entry, 'I did not hear an answer.');
      }
    };
    voiceReplyTimer = setTimeout(() => {
      if (onFallback) { stopVoiceReply(); onFallback('I did not hear an answer.'); }
      else showVoiceReplyFallback(entry, 'I did not hear an answer.');
    }, 10000);
    reply.start();
  } catch {
    showVoiceReplyFallback(entry, 'Voice confirmation could not start.');
  }
}
function voiceReplyChoice(entry, heard) {
  const text = customerNameMatchKey(heard);
  const candidates = entry.ambiguousCustomerIds?.length
    ? customers.filter((customer) => entry.ambiguousCustomerIds.includes(customer.id))
    : customers.filter((customer) => (entry.suggestedCustomerIds || []).includes(customer.id));
  const digits = text.replace(/\D/g, '');
  const byName = candidates.filter((customer) => text.includes(customerNameMatchKey(customer.name)));
  if (byName.length === 1) return byName[0];
  if (digits.length >= 2) {
    const byPhone = candidates.filter((customer) => customer.phone && customer.phone.replace(/\D/g, '').endsWith(digits));
    if (byPhone.length === 1) return byPhone[0];
  }
  return null;
}
function handleVoiceConfirmationReply(entry, heard, SpeechRecognition, attempt) {
  if (pendingVoiceEntry !== entry) return;
  const words = [...heard.normalize('NFC').toLocaleLowerCase('en-IN').matchAll(/[\p{L}\p{M}]+/gu)].map((match) => match[0]);
  const noWords = new Set(['no', 'nahi', 'nahin', 'नहीं', 'नही', 'रद्द', 'cancel', 'stop']);
  const yesWords = new Set(['yes', 'yeah', 'haan', 'han', 'हाँ', 'हां', 'हा', 'जी', 'सही', 'ठीक', 'save', 'confirm']);
  if (words.some((word) => noWords.has(word))) {
    pendingVoiceEntry = null;
    voiceConversation = null;
    cancelVoiceSession(entry.sessionId);
    setVoiceReady('Entry cancelled. Nothing was saved.');
    speakText(voiceLanguage === 'hi-IN' ? 'ठीक है, एंट्री रद्द कर दी। कुछ सेव नहीं हुआ।' : 'Okay, the entry is cancelled. Nothing was saved.');
    return;
  }
  const hasChoices = entry.ambiguousCustomerIds?.length || entry.suggestedCustomerIds?.length;
  if (hasChoices) {
    const customer = voiceReplyChoice(entry, heard);
    if (customer) {
      entry.customerId = customer.id;
      entry.customer = customer.name;
      entry.ambiguousCustomerIds = [];
      entry.suggestedCustomerIds = [];
      pendingVoiceEntry = entry;
      $('#voice-customer-choice').value = customer.id;
      $('#confirm-transaction').click();
      return;
    }
    if (words.some((word) => ['new', 'naya', 'नया', 'नयी', 'नए'].includes(word)) && entry.suggestedCustomerIds?.length) {
      entry.ambiguousCustomerIds = [];
      entry.suggestedCustomerIds = [];
      pendingVoiceEntry = entry;
      $('#confirm-transaction').click();
      return;
    }
  } else if (words.some((word) => yesWords.has(word))) {
    $('#confirm-transaction').click();
    return;
  }
  if (attempt < 1) {
    const retryPrompt = hasChoices
      ? `${voiceLanguage === 'hi-IN' ? 'माफ कीजिए, समझ नहीं आया। ' : 'Sorry, I did not understand. '}${voiceConfirmationPrompt(entry)}`
      : (voiceLanguage === 'hi-IN' ? 'माफ कीजिए, समझ नहीं आया। सेव करने के लिए हाँ, रद्द करने के लिए नहीं बोलें।' : 'Sorry, I did not understand. Say yes to save or no to cancel.');
    speakText(retryPrompt).then((played) => {
      if (played && pendingVoiceEntry === entry) listenForVoiceConfirmation(entry, SpeechRecognition, attempt + 1);
      else if (pendingVoiceEntry === entry) showVoiceReplyFallback(entry, 'I could not understand your answer.');
    });
    return;
  }
  pendingVoiceEntry = entry;
  showVoiceConfirmation(entry);
  toast('I could not understand the voice reply. Please confirm on screen.');
}
function dismissVoiceConfirmation() {
  const sessionId = pendingVoiceEntry?.sessionId;
  stopVoiceReply();
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  pendingVoiceEntry = null;
  voiceConversation = null;
  cancelVoiceSession(sessionId);
  setVoiceReady();
}
$('#cancel-transaction').addEventListener('click', () => {
  const entry = pendingVoiceEntry;
  dismissVoiceConfirmation();
  if ($('#confirm-dialog').open) $('#confirm-dialog').close();
  if (entry) openManualCorrection(entry);
});
$('#confirm-dialog .dialog-close').addEventListener('click', dismissVoiceConfirmation);
$('#confirm-dialog').addEventListener('cancel', dismissVoiceConfirmation);
$('#confirm-dialog').addEventListener('close', () => {
  // The title-bar close button submits its method="dialog" form without firing
  // the cancel event. Still cancel a server-side voice session when dismissed.
  if (pendingVoiceEntry) dismissVoiceConfirmation();
});
let confirmingVoiceEntry = false;
$('#confirm-transaction').addEventListener('click', async () => {
  if (!pendingVoiceEntry || confirmingVoiceEntry) return;
  confirmingVoiceEntry = true;
  const confirmButton = $('#confirm-transaction');
  confirmButton.disabled = true;
  const entry = pendingVoiceEntry;
  pendingVoiceEntry = null;
  voiceConversation = null;
  if ($('#confirm-dialog').open) $('#confirm-dialog').close();
  try {
    let customerId = entry.customerId;
    if (entry.ambiguousCustomerIds?.length > 1) {
      customerId = $('#voice-customer-choice').value;
      if (!customerId) {
        toast('Choose which customer should get this entry.');
        pendingVoiceEntry = entry;
        showVoiceConfirmation(entry);
        return;
      }
    } else if (entry.suggestedCustomerIds?.length) {
      const selected = $('#voice-customer-choice').value;
      if (!selected) {
        toast('Choose the correct existing name, or select New customer.');
        pendingVoiceEntry = entry;
        showVoiceConfirmation(entry);
        return;
      }
      customerId = selected === 'new' ? null : selected;
    }
    if (!customerId) {
      const created = await api('/api/v1/customers', { method: 'POST', body: JSON.stringify({ name: entry.customer, phone: null }) });
      customerId = created.id;
    }
    const payload = {
      customer_id: customerId,
      amount: entry.amount,
      entry_type: entry.type === 'credit' ? 'udhaar' : 'jama',
      note: entry.raw || null,
    };
    if (entry.sessionId) {
      await api(`/api/v1/voice/sessions/${entry.sessionId}/confirm`, { method: 'POST', body: JSON.stringify(payload) });
      await loadWorkspace();
      renderAll();
    } else {
      await createLedgerEntry(customerId, entry.amount, entry.type, entry.raw);
    }
    setVoiceReady('Entry saved. Your khata is up to date.');
    toast('Confirmed entry saved to your khata');
    const savedCustomerName = customerName(customerId);
    const savedType = entry.type === 'credit' ? 'उधार की एंट्री' : 'जमा की एंट्री';
    speakText(`${savedCustomerName}, ${Number(entry.amount).toLocaleString('hi-IN')} रुपये की ${savedType} सेव हो गई।`);
  } catch (error) {
    if (entry.sessionId && error.status === 409) {
      try {
        await loadWorkspace();
        renderAll();
        toast('This voice entry was already handled. Your ledger has been refreshed.');
        return;
      } catch {}
    }
    if (!entry.customerId && !entry.ambiguousCustomerIds?.length && error.status === 409 && error.message.toLowerCase().includes('customer with this name already exists')) {
      try {
        await loadWorkspace();
        renderAll();
        const matches = customers.filter((customer) => sameCustomerName(customer.name, entry.customer));
        if (matches.length) {
          pendingVoiceEntry = matches.length === 1
            ? { ...entry, customer: matches[0].name, customerId: matches[0].id, ambiguousCustomerIds: [], suggestedCustomerIds: [] }
            : { ...entry, customer: matches[0].name, customerId: null, ambiguousCustomerIds: matches.map((customer) => customer.id), suggestedCustomerIds: [] };
          showVoiceConfirmation(pendingVoiceEntry);
          toast(matches.length === 1
            ? `${matches[0].name} already exists. Confirm again to add this entry to that account.`
            : `More than one ${matches[0].name} exists. Choose the correct account, then confirm.`);
          return;
        }
      } catch (refreshError) {
        toast(`Customer already exists, but the list could not refresh: ${refreshError.message}`);
        return;
      }
    }
    if (entry.sessionId && !pendingVoiceEntry) {
      // Keep the explicit confirmation available after a transient failure.
      // The backend binds a voice session to at most one ledger entry, so a
      // retry cannot create a second entry if the first response was lost.
      pendingVoiceEntry = entry;
      showVoiceConfirmation(entry);
      toast('Could not confirm the save. Check your connection, then try again.');
      return;
    }
    toast(error.message);
  } finally {
    confirmingVoiceEntry = false;
    confirmButton.disabled = false;
  }
});

const waveCanvas = $('.wave-canvas');
const waveCtx = waveCanvas.getContext('2d');
function drawWave(time = 0) {
  const box = waveCanvas.getBoundingClientRect();
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const width = Math.max(1, box.width);
  const height = Math.max(1, box.height);
  if (waveCanvas.width !== Math.round(width * dpr) || waveCanvas.height !== Math.round(height * dpr)) {
    waveCanvas.width = Math.round(width * dpr);
    waveCanvas.height = Math.round(height * dpr);
  }
  waveCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  waveCtx.clearRect(0, 0, width, height);
  let level = 0;
  let rms = 0;
  if (analyser) {
    const data = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (const sample of data) { const value = (sample - 128) / 128; sum += value * value; }
    rms = Math.sqrt(sum / data.length);
    level = Math.min(1, rms * 5);
  }
  if (listening && mediaRecorder?.state === 'recording') {
    if (rms > 0.018) { recordingHeardSpeech = true; recordingSilenceStartedAt = 0; }
    else if (recordingHeardSpeech) {
      if (!recordingSilenceStartedAt) recordingSilenceStartedAt = performance.now();
      else if (performance.now() - recordingSilenceStartedAt >= 1400) { finishGnaniRecording(); return; }
    }
  }
  const active = listening;
  const center = height / 2;
  const phase = active ? time * 0.0012 : 0;
  const gradient = waveCtx.createLinearGradient(0, 0, width, 0);
  gradient.addColorStop(0, '#1b8051'); gradient.addColorStop(0.34, '#62e8a0'); gradient.addColorStop(0.62, '#3ed694'); gradient.addColorStop(1, '#28754b');
  for (let layer = 0; layer < 5; layer += 1) {
    waveCtx.beginPath();
    for (let x = 0; x <= width; x += 2) {
      const t = x / width;
      const envelope = Math.pow(Math.sin(Math.PI * t), 1.15);
      const shape = Math.sin(t * Math.PI * 2.25 - phase + layer * 0.22) + 0.31 * Math.sin(t * Math.PI * 5.4 - phase * 0.7 + layer * 0.5);
      const detail = Math.sin(t * Math.PI * 13 - phase * 1.2 + layer * 0.8);
      const amplitude = (1.3 + level * 29) * envelope * (0.62 + layer * 0.09);
      const y = center + shape * amplitude + detail * (0.35 + level * 2.4) * envelope;
      if (x === 0) waveCtx.moveTo(x, y); else waveCtx.lineTo(x, y);
    }
    waveCtx.globalAlpha = active ? [0.22, 0.32, 0.44, 0.62, 0.96][layer] : [0.1, 0.15, 0.2, 0.28, 0.68][layer];
    waveCtx.strokeStyle = gradient;
    waveCtx.lineWidth = layer === 4 ? 1.55 : layer === 3 ? 1 : 0.55;
    waveCtx.shadowBlur = layer === 4 ? (active ? 12 : 5) : layer === 3 ? 5 : 0;
    waveCtx.shadowColor = '#54d982';
    waveCtx.stroke();
  }
  waveCtx.globalAlpha = 1;
  waveCtx.shadowBlur = 0;
  if (active) waveFrame = requestAnimationFrame(drawWave); else waveFrame = 0;
}
function releaseAudioInput() {
  if (micStream) { micStream.getTracks().forEach((track) => track.stop()); micStream = null; }
  if (audioContext) { audioContext.close().catch(() => {}); audioContext = null; analyser = null; }
}
function stopListening() {
  listening = false;
  $('#voice-button').classList.remove('listening', 'processing');
  $('#voice-button').disabled = false;
  $('#voice-button').setAttribute('aria-label', 'Start listening');
  if (recognition) { try { recognition.stop(); } catch {} recognition = null; }
  if (recordingTimer) { clearTimeout(recordingTimer); recordingTimer = null; }
  if (mediaRecorder?.state === 'recording') {
    processRecordingOnStop = false;
    try { mediaRecorder.stop(); } catch {}
  }
  if (waveFrame) cancelAnimationFrame(waveFrame);
  waveFrame = 0;
  releaseAudioInput();
  drawWave();
}
function setVoiceReady(caption = 'Tap the waveform to speak') {
  $('#voice-button').disabled = false;
  $('#voice-button').classList.remove('listening', 'processing');
  $('#voice-button').setAttribute('aria-label', 'Start listening');
  $('#voice-title').textContent = 'Ready when you are';
  $('#voice-subtitle').textContent = 'Say the customer, amount, and whether it is udhaar or a payment.';
  $('#voice-caption').innerHTML = `<span class="voice-dot"></span><span>${esc(caption)}</span>`;
}
async function startBrowserRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) { toast('Voice input is unavailable in this browser. Use New entry to record this transaction.'); return; }
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (AudioContext) { audioContext = new AudioContext(); analyser = audioContext.createAnalyser(); analyser.fftSize = 256; audioContext.createMediaStreamSource(micStream).connect(analyser); }
    recognition = new SpeechRecognition();
    recognition.lang = voiceLanguage;
    recognition.interimResults = true;
    recognition.continuous = false;
    listening = true;
    $('#voice-button').classList.add('listening');
    $('#voice-button').setAttribute('aria-label', 'Stop listening');
    $('#voice-title').textContent = 'I’m listening';
    $('#voice-subtitle').textContent = 'Say the customer, amount, and whether it is udhaar or a payment.';
    $('#voice-caption').innerHTML = '<span class="voice-dot"></span><span>Listening… speak now</span>';
    drawWave();
    recognition.onresult = (event) => {
      let transcript = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) transcript += event.results[i][0].transcript;
      $('#voice-caption').innerHTML = `<span class="voice-dot"></span><span>${esc(transcript)}</span>`;
      if (event.results[event.results.length - 1].isFinal) {
        stopListening();
        $('#voice-title').textContent = 'Got it. Please confirm';
        $('#voice-subtitle').textContent = 'Check the customer and amount before saving.';
        setTimeout(() => { setVoiceReady(); prepareVoiceEntry(transcript); }, 250);
      }
    };
    recognition.onerror = (event) => {
      stopListening();
      setVoiceReady();
      if (event.error === 'not-allowed') toast('Allow microphone access in browser settings to use voice.');
      else if (event.error !== 'no-speech' && event.error !== 'aborted') toast('Voice input paused. Use New entry to record this transaction.');
    };
    recognition.onend = () => { if (listening) stopListening(); };
    recognition.start();
  } catch (error) {
    stopListening();
    setVoiceReady();
    toast(error.name === 'NotAllowedError' ? 'Allow microphone access in your browser to use voice.' : 'Could not start voice input. Choose New entry instead.');
  }
}
function attachWaveAnalyser() {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (AudioContext) { audioContext = new AudioContext(); analyser = audioContext.createAnalyser(); analyser.fftSize = 256; audioContext.createMediaStreamSource(micStream).connect(analyser); }
}
async function startGnaniRecording() {
  if (!window.MediaRecorder) return startBrowserRecognition();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    micStream = stream;
    attachWaveAnalyser();
    const mimeType = typeof MediaRecorder.isTypeSupported === 'function'
      ? ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find((type) => MediaRecorder.isTypeSupported(type))
      : '';
    mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    recordedChunks = [];
    recordingHeardSpeech = false;
    recordingSilenceStartedAt = 0;
    processRecordingOnStop = false;
    mediaRecorder.ondataavailable = (event) => { if (event.data?.size) recordedChunks.push(event.data); };
    mediaRecorder.onerror = () => { stopListening(); setVoiceReady(); toast('Could not record voice. Use New entry instead.'); };
    mediaRecorder.onstop = async () => {
      const shouldTranscribe = processRecordingOnStop;
      processRecordingOnStop = false;
      if (recordingTimer) { clearTimeout(recordingTimer); recordingTimer = null; }
      const audio = new Blob(recordedChunks, { type: mediaRecorder?.mimeType || 'audio/webm' });
      recordedChunks = [];
      mediaRecorder = null;
      releaseAudioInput();
      if (!shouldTranscribe) { setVoiceReady(); return; }
      if (!audio.size) { setVoiceReady(); toast('No voice was recorded. Please try again.'); return; }
      await transcribeGnaniAudio(audio);
    };
    mediaRecorder.start(250);
    listening = true;
    $('#voice-button').classList.add('listening');
    $('#voice-button').setAttribute('aria-label', 'Stop and transcribe');
    $('#voice-title').textContent = 'I’m listening';
    $('#voice-subtitle').textContent = 'Say the customer, amount, and whether it is udhaar or a payment. Pause when you finish.';
    $('#voice-caption').innerHTML = '<span class="voice-dot"></span><span>Listening… recording stops after your pause</span>';
    drawWave();
    recordingTimer = setTimeout(() => {
      if (listening) { toast('Voice recording reached 30 seconds. Transcribing now.'); finishGnaniRecording(); }
    }, 29000);
  } catch (error) {
    stopListening();
    setVoiceReady();
    toast(error.name === 'NotAllowedError' ? 'Allow microphone access in browser settings to use voice.' : 'Could not start voice recording. Use New entry instead.');
  }
}
function finishGnaniRecording() {
  if (!mediaRecorder || mediaRecorder.state !== 'recording') return;
  processRecordingOnStop = true;
  listening = false;
  $('#voice-button').classList.remove('listening');
  $('#voice-button').classList.add('processing');
  $('#voice-button').disabled = true;
  $('#voice-button').setAttribute('aria-label', 'Transcribing');
  $('#voice-title').textContent = 'Transcribing your voice';
  $('#voice-subtitle').textContent = 'Sending your recording to Gnani for transcription.';
  $('#voice-caption').innerHTML = '<span class="voice-dot"></span><span>Checking the recording…</span>';
  if (waveFrame) cancelAnimationFrame(waveFrame);
  waveFrame = 0;
  drawWave();
  mediaRecorder.stop();
}
async function encodeWav16k(audio) {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) throw new Error('Audio conversion is unavailable in this browser');
  const context = new AudioContext();
  let decoded;
  try { decoded = await context.decodeAudioData(await audio.arrayBuffer()); }
  finally { await context.close(); }
  if (decoded.duration > 30.5) throw new Error('Voice recording must be under 30 seconds');
  const outputRate = 16000;
  const outputLength = Math.ceil(decoded.length * outputRate / decoded.sampleRate);
  const channels = Array.from({ length: decoded.numberOfChannels }, (_, index) => decoded.getChannelData(index));
  const wav = new ArrayBuffer(44 + outputLength * 2);
  const view = new DataView(wav);
  const writeText = (offset, value) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  writeText(0, 'RIFF'); view.setUint32(4, 36 + outputLength * 2, true); writeText(8, 'WAVE');
  writeText(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, outputRate, true); view.setUint32(28, outputRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  writeText(36, 'data'); view.setUint32(40, outputLength * 2, true);
  for (let index = 0; index < outputLength; index += 1) {
    const sourcePosition = index * decoded.sampleRate / outputRate;
    const left = Math.floor(sourcePosition);
    const fraction = sourcePosition - left;
    let sample = 0;
    for (const channel of channels) {
      const first = channel[Math.min(left, channel.length - 1)] || 0;
      const second = channel[Math.min(left + 1, channel.length - 1)] || 0;
      sample += first + (second - first) * fraction;
    }
    sample /= channels.length;
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(44 + index * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  return new Blob([wav], { type: 'audio/wav' });
}
async function transcribeGnaniAudio(audio) {
  try {
    const wav = await encodeWav16k(audio);
    const form = new FormData();
    form.append('audio', wav, 'voice-command.wav');
    form.append('language_code', voiceLanguage);
    const session = await api('/api/v1/voice/sessions', { method: 'POST', body: form });
    setVoiceReady();
    $('#voice-title').textContent = 'Got it. Please confirm';
    $('#voice-subtitle').textContent = 'Check the transcript, customer, and amount before saving.';
    $('#voice-caption').innerHTML = `<span class="voice-dot"></span><span>${esc(session.transcript)}</span>`;
    prepareVoiceEntry(session.transcript, session.id);
  } catch (error) {
    setVoiceReady('Voice transcription did not finish. Try again or use New entry.');
    toast(error.message || 'Gnani could not transcribe this recording.');
  }
}
async function startListening() {
  if (startingVoice || listening) return;
  if (!window.isSecureContext) { toast('Voice input needs HTTPS or localhost.'); return; }
  if (!navigator.mediaDevices?.getUserMedia) { toast('Microphone input is unavailable here. Use New entry instead.'); return; }
  startingVoice = true;
  const keepGestureButtonActive = voicePointerHoldActive;
  if (!keepGestureButtonActive) $('#voice-button').disabled = true;
  try {
    const capabilities = await api('/api/v1/voice/capabilities');
    gnaniSttEnabled = Boolean(capabilities.speech_to_text);
    gnaniTtsEnabled = Boolean(capabilities.speech_output);
    if (capabilities.speech_to_text && window.MediaRecorder && (window.AudioContext || window.webkitAudioContext)) {
      await startGnaniRecording();
      return;
    }
    if (capabilities.speech_to_text && !window.MediaRecorder) toast('This browser cannot record audio for Gnani. Trying its built-in speech recognition.');
    await startBrowserRecognition();
  } catch (error) {
    gnaniSttEnabled = false;
    gnaniTtsEnabled = false;
    toast(error.message || 'Could not check voice service. Use New entry instead.');
  } finally {
    startingVoice = false;
    if (!keepGestureButtonActive) $('#voice-button').disabled = false;
  }
}
function stopActiveVoiceCapture() {
  if (mediaRecorder?.state === 'recording') finishGnaniRecording();
  else if (listening) stopListening();
}
function beginGestureVoiceCapture(onStarted = null) {
  startListening().then(() => {
    if (onStarted) onStarted();
  });
}
function startAssistantVoiceWhenReady() {
  if (!assistantVoiceLaunchPending || $('#app-shell').hidden || startingVoice || listening || awaitingVoiceReply || pendingVoiceEntry) return;
  assistantVoiceLaunchPending = false;
  startListening();
}
// Native Android assistant integrations call this after opening the app from
// the system assistant gesture. Keep the request pending until the shop is
// authenticated and its workspace has finished loading.
window.voiceKhataAssistantLaunch = () => {
  assistantVoiceLaunchPending = true;
  startAssistantVoiceWhenReady();
  return true;
};
document.addEventListener('keydown', (event) => {
  if (event.code !== 'Space' || event.repeat || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
  if ($('#app-shell').hidden || awaitingVoiceReply || voiceSpaceHeld) return;
  if (document.querySelector('dialog[open]')) return;
  const target = event.target;
  if (target?.matches?.('input, textarea, select, button, a, [contenteditable="true"]')) return;
  if (listening || startingVoice || pendingVoiceEntry) return;
  event.preventDefault();
  voiceSpaceHeld = true;
  voiceSpaceReleasedWhileStarting = false;
  beginGestureVoiceCapture(() => {
    if (voiceSpaceReleasedWhileStarting) { voiceSpaceReleasedWhileStarting = false; return; }
    if (!voiceSpaceHeld) stopActiveVoiceCapture();
  });
});
document.addEventListener('keyup', (event) => {
  if (event.code !== 'Space' || !voiceSpaceHeld) return;
  event.preventDefault();
  voiceSpaceHeld = false;
  if (listening) stopActiveVoiceCapture();
  else if (startingVoice) voiceSpaceReleasedWhileStarting = true;
});
window.addEventListener('blur', () => {
  if (!voiceSpaceHeld) return;
  voiceSpaceHeld = false;
  if (listening) stopActiveVoiceCapture();
  else if (startingVoice) voiceSpaceReleasedWhileStarting = true;
});
const voiceButton = $('#voice-button');
voiceButton.addEventListener('pointerdown', (event) => {
  if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
  if ($('#app-shell').hidden || listening || startingVoice || awaitingVoiceReply || pendingVoiceEntry) return;
  voicePointerHoldActive = false;
  voicePointerReleasedDuringStart = false;
  voicePointerTimer = setTimeout(() => {
    voicePointerTimer = null;
    voicePointerHoldActive = true;
    suppressVoiceButtonClick = true;
    try { voiceButton.setPointerCapture(event.pointerId); } catch {}
    beginGestureVoiceCapture(() => {
      if (voicePointerReleasedDuringStart) stopActiveVoiceCapture();
    });
  }, 320);
});
const finishVoicePointerGesture = (event) => {
  if (voicePointerTimer) { clearTimeout(voicePointerTimer); voicePointerTimer = null; }
  if (!voicePointerHoldActive) return;
  event.preventDefault();
  voicePointerHoldActive = false;
  voicePointerReleasedDuringStart = true;
  if (listening) stopActiveVoiceCapture();
  else if (startingVoice) voicePointerReleasedDuringStart = false;
  setTimeout(() => { suppressVoiceButtonClick = false; }, 0);
};
voiceButton.addEventListener('pointerup', finishVoicePointerGesture);
voiceButton.addEventListener('pointercancel', finishVoicePointerGesture);
voiceButton.addEventListener('lostpointercapture', finishVoicePointerGesture);
voiceButton.addEventListener('click', () => {
  if (suppressVoiceButtonClick) { suppressVoiceButtonClick = false; return; }
  if (awaitingVoiceReply) {
    const entry = pendingVoiceEntry;
    stopVoiceReply();
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    if (entry && voiceConversation) fallbackConversationToForm(entry, 'Voice questions stopped.');
    else if (entry) showVoiceConfirmation(entry);
    return;
  }
  if (!listening) { startListening(); return; }
  if (mediaRecorder) finishGnaniRecording(); else stopListening();
});
drawWave();

async function bootstrap() {
  if (!API_BASE) { showAuth('Set the backend URL in frontend/config.js before signing in.'); return; }
  if (!token) { showAuth(); return; }
  try {
    await loadWorkspace();
    showApp();
    renderAll();
    startAssistantVoiceWhenReady();
  } catch (error) {
    showAuth(error.message === 'Invalid or expired access token' ? 'Your session expired. Please log in again.' : `Could not connect to backend: ${error.message}`);
  }
}
bootstrap();
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload(), { once: true });
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').then((registration) => registration.update()).catch(() => {}));
}
