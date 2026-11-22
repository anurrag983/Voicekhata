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
let workspaceLoadError = '';
let retryingWorkspaceLoad = false;
let selectedCustomerId = '';
let selectedCustomerLedger = null;
let ledgerView = 'all';
let chartStartDate = '';
let chartEndDate = '';
let customerLedgerLoading = false;
let customerLedgerError = '';
let profile = { shopName: '', ownerName: '', location: '', upiId: '' };
let pendingVoiceEntry = null;
let voiceConversation = null;
let handsFreeQuestionRetries = 0;
let handsFreeTranscriptionRetries = 0;
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
let nativeVoiceReplyHandlers = null;
let voiceReplyStream = null;
let voiceReplyProcessedStream = null;
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
let voiceCapabilitiesLoaded = false;
let voiceCapabilitiesPromise = null;
let gnaniLastError = '';
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
  'मिले', 'मिला', 'किए', 'किया', 'दिए', 'दिया', 'लिए', 'लिया', 'कर', 'करो', 'हुआ', 'हुए', 'हुई', 'हुईं', 'आज', 'है', 'हैं', 'थे', 'था', 'थी', 'हो', 'का', 'के', 'को', 'ने', 'से', 'पर', 'नाम', 'ग्राहक',
]);
function commandCustomerName(value) {
  const name = [...String(value || '').normalize('NFC').matchAll(/[\p{L}\p{M}]+/gu)]
    .map((match) => match[0])
    .filter((word) => !COMMAND_FILLER_WORDS.has(word.toLocaleLowerCase('en-IN')))
    .join(' ')
    .trim();
  if (!/[\u0900-\u097f]/u.test(name)) return name;
  return customerNameMatchKey(name).replace(/(^|[\s-])(\p{L})/gu, (_, separator, letter) => `${separator}${letter.toUpperCase()}`);
}
function displayCustomerName(value) {
  const name = String(value || '').normalize('NFC').trim();
  return /[\u0900-\u097f]/u.test(name) ? (commandCustomerName(name) || name) : name;
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

let gnaniTtsWarningShown = false;
let geminiQuestionWarningShown = false;
async function speakText(message) {
  if (!voiceCapabilitiesLoaded) await requestVoiceCapabilities();
  if (!gnaniTtsEnabled) {
    if (!gnaniTtsWarningShown) {
      gnaniTtsWarningShown = true;
      toast(gnaniLastError || 'Gnani speech output is not enabled on the backend.');
    }
    return false;
  }
  const played = await speakWithGnani(message);
  if (played) return true;
  if (!gnaniTtsWarningShown) {
    gnaniTtsWarningShown = true;
    toast(gnaniLastError || 'Gnani voice response failed.');
  }
  return false;
}
function isHandsFreeVoiceSession() {
  try { return Boolean(window.VoiceKhataNative?.isHandsFreeSession?.()); }
  catch { return false; }
}
function updateHandsFreeStatus(message) {
  try { if (isHandsFreeVoiceSession()) window.VoiceKhataNative.setHandsFreeStatus(message); } catch {}
}
function finishHandsFreeAfterSpeech(message) {
  updateHandsFreeStatus(message);
  window.__voiceKhataHandsFreeSpeechActive = true;
  const speech = speakText(message);
  Promise.resolve(speech).finally(() => {
    window.__voiceKhataHandsFreeSpeechActive = false;
    if (isHandsFreeVoiceSession()) window.VoiceKhataNative.finishHandsFreeSession();
  });
}
function retryHandsFreeCapture(message) {
  updateHandsFreeStatus(message);
  speakText(message).then((played) => {
    if (isHandsFreeVoiceSession() && played) window.VoiceKhataNative.startCapture();
    else if (isHandsFreeVoiceSession()) failHandsFreeVoiceSession('Gnani se awaaz nahi chal paayi. Kuch save nahi hua.');
  });
}
function retryHandsFreeQuestion(entry, prompt, onAnswer) {
  speakText('जवाब नहीं सुना। फिर बोलें।').then((played) => {
    if (isHandsFreeVoiceSession() && played) askConversationQuestion(entry, prompt, onAnswer);
    else if (isHandsFreeVoiceSession()) failHandsFreeVoiceSession();
  });
}
function failHandsFreeVoiceSession(message = 'माफ़ कीजिए, आवाज़ समझ नहीं आई। कुछ सेव नहीं हुआ। दोबारा शुरू करने के लिए assistant button दबाएँ।') {
  stopVoiceReply();
  const sessionId = pendingVoiceEntry?.sessionId || voiceConversation?.entry?.sessionId;
  if (sessionId) cancelVoiceSession(sessionId);
  pendingVoiceEntry = null;
  voiceConversation = null;
  setVoiceReady('Nothing was saved. Start again by pressing the assistant button.');
  finishHandsFreeAfterSpeech(message);
}
function setAuthError(message = '') {
  const error = $('#auth-error');
  if (error) {
    error.textContent = message;
    error.hidden = !message;
  }
  if (message) setAuthInfo('');
}

function setAuthInfo(message = '') {
  const info = $('#auth-info');
  if (info) {
    info.textContent = message;
    info.hidden = !message;
  }
}

function showAuth(message = '') {
  $('#startup-screen').hidden = true;
  if (listening) stopListening();
  stopVoiceReply();
  $$('dialog[open]').forEach((dialog) => dialog.close());
  pendingVoiceEntry = null;
  voiceConversation = null;
  $('#app-shell').hidden = true;
  $('#auth-screen').hidden = false;
  setAuthMode('login');
  setAuthError(message);
}

function showApp() {
  $('#startup-screen').hidden = true;
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

function requestVoiceCapabilities() {
  if (voiceCapabilitiesLoaded) {
    return Promise.resolve({ speech_to_text: gnaniSttEnabled, speech_output: gnaniTtsEnabled });
  }
  if (voiceCapabilitiesPromise) return voiceCapabilitiesPromise;
  voiceCapabilitiesPromise = api('/api/v1/voice/capabilities')
    .then((capabilities) => {
      gnaniSttEnabled = Boolean(capabilities.speech_to_text);
      gnaniTtsEnabled = Boolean(capabilities.speech_output);
      voiceCapabilitiesLoaded = true;
      gnaniLastError = gnaniTtsEnabled ? '' : 'Gnani speech is not configured on the backend.';
      if (gnaniTtsEnabled) gnaniTtsWarningShown = false;
      return capabilities;
    })
    .catch(() => {
      gnaniLastError = 'Could not check Gnani services. Check the backend connection.';
      return null;
    })
    .finally(() => { voiceCapabilitiesPromise = null; });
  return voiceCapabilitiesPromise;
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
  if (!token || !API_BASE) {
    gnaniLastError = 'Log in again before using the Gnani voice response.';
    return false;
  }
  try {
    const response = await fetch(`${API_BASE}/api/v1/voice/speak`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: message, language_code: voiceLanguage }),
      cache: 'no-store',
    });
    if (!response.ok) {
      let detail = '';
      try { detail = (await response.json())?.detail || ''; } catch {}
      gnaniLastError = detail || `Gnani speech request failed (${response.status}).`;
      return false;
    }
    const stream = await response.text();
    const audioChunks = decodeGnaniTtsSse(stream);
    const wav = assembleWav(audioChunks) || assembleGnaniPcmWav(audioChunks);
    if (!wav) {
      gnaniLastError = 'Gnani returned no playable audio. Check the configured voice and TTS format.';
      return false;
    }
    const url = URL.createObjectURL(wav);
    try {
      const audio = new Audio(url);
      await new Promise((resolve, reject) => {
        audio.onended = resolve;
        audio.onerror = reject;
        audio.play().catch(reject);
      });
    } finally { URL.revokeObjectURL(url); }
    gnaniLastError = '';
    return true;
  } catch (error) {
    gnaniLastError = error?.name === 'NotAllowedError'
      ? 'The browser blocked audio playback. Tap the page once and try again.'
      : (error?.message || 'Could not reach Gnani speech output.');
    return false;
  }
}

function setAuthMode(mode) {
  const isLogin = mode === 'login';
  const isRegister = mode === 'register';
  const isForgot = mode === 'forgot';

  const loginForm = $('#login-form');
  const registerForm = $('#register-form');
  const forgotForm = $('#forgot-form');
  const authToggle = $('#auth-toggle');

  if (loginForm) loginForm.hidden = !isLogin;
  if (registerForm) registerForm.hidden = !isRegister;
  if (forgotForm) forgotForm.hidden = !isForgot;

  if (isLogin) {
    $('#auth-title').textContent = 'Welcome back';
    $('#auth-subtitle').textContent = 'Sign in with your Gmail and password.';
    if (authToggle) {
      authToggle.hidden = false;
      authToggle.textContent = 'New here? Create an account';
    }
  } else if (isRegister) {
    $('#auth-title').textContent = 'Set up your shop';
    $('#auth-subtitle').textContent = 'Enter your Gmail address. We will verify with OTP.';
    if (authToggle) {
      authToggle.hidden = false;
      authToggle.textContent = 'Already have an account? Log in';
    }
  } else if (isForgot) {
    $('#auth-title').textContent = 'Reset Password';
    $('#auth-subtitle').textContent = 'Enter your registered Gmail to receive an OTP.';
    if (authToggle) authToggle.hidden = true;
  }

  setAuthError('');
  setAuthInfo('');
}

function startOtpCooldown(button, cooldownSeconds = 30) {
  let remaining = cooldownSeconds;
  button.disabled = true;
  const originalText = button.textContent;
  button.textContent = `Resend in ${remaining}s`;

  const interval = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      clearInterval(interval);
      button.disabled = false;
      button.textContent = 'Resend OTP';
    } else {
      button.textContent = `Resend in ${remaining}s`;
    }
  }, 1000);
}

async function handleSendOtp(targetInputId, buttonId, otpSectionId, otpInputId, purpose) {
  const target = $(targetInputId).value.trim();
  if (!target) {
    setAuthError('Please enter your Gmail address first.');
    return;
  }
  const button = $(buttonId);
  setAuthError('');
  setAuthInfo('Sending verification OTP…');
  button.disabled = true;

  try {
    const result = await api('/api/v1/auth/otp/send', {
      method: 'POST',
      body: JSON.stringify({ target, purpose }),
    });

    $(otpSectionId).hidden = false;
    let message = result.message || 'OTP sent successfully!';
    if (result.dev_otp) {
      message = `OTP sent! (Test OTP: ${result.dev_otp})`;
      const otpInput = $(otpInputId);
      if (otpInput && !otpInput.value) {
        otpInput.value = result.dev_otp;
      }
    }
    setAuthInfo(message);
    startOtpCooldown(button, result.cooldown_seconds || 30);
  } catch (error) {
    setAuthError(error.message);
    button.disabled = false;
  }
}

async function authenticate(path, payload, successToast = 'You are logged in') {
  try {
    const result = await api(path, { method: 'POST', body: JSON.stringify(payload) });
    token = result.access_token;
    localStorage.setItem(TOKEN_KEY, token);
    merchant = result.merchant;
    await loadWorkspace();
    showApp();
    renderAll();
    void requestVoiceCapabilities();
    startAssistantVoiceWhenReady();
    toast(successToast);
  } catch (error) {
    setAuthError(error.message);
  }
}

// Send OTP click handlers
const registerSendOtpBtn = $('#register-send-otp-btn');
if (registerSendOtpBtn) {
  registerSendOtpBtn.addEventListener('click', () => {
    handleSendOtp('#register-target', '#register-send-otp-btn', '#register-otp-section', '#register-otp', 'registration');
  });
}

const forgotSendOtpBtn = $('#forgot-send-otp-btn');
if (forgotSendOtpBtn) {
  forgotSendOtpBtn.addEventListener('click', () => {
    handleSendOtp('#forgot-target', '#forgot-send-otp-btn', '#forgot-otp-section', '#forgot-otp', 'reset_password');
  });
}

// Navigation between forms
const forgotPasswordLink = $('#forgot-password-link');
if (forgotPasswordLink) {
  forgotPasswordLink.addEventListener('click', () => setAuthMode('forgot'));
}

const forgotBackBtn = $('#forgot-back-btn');
if (forgotBackBtn) {
  forgotBackBtn.addEventListener('click', () => setAuthMode('login'));
}

// Submit handlers
$('#login-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const identifier = ($('#login-identifier') ? $('#login-identifier').value : $('#login-email').value).trim();
  const password = $('#login-password').value;
  authenticate('/api/v1/auth/login', {
    identifier,
    password,
  }, 'You are logged in');
});

$('#register-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const target = $('#register-target').value.trim();
  const otp = $('#register-otp').value.trim();
  const password = $('#register-password').value;
  const name = $('#register-name').value.trim();
  const owner_name = $('#register-owner-name').value.trim() || null;
  const location = $('#register-location').value.trim() || null;

  if (!otp || otp.length < 4) {
    if ($('#register-otp-section') && $('#register-otp-section').hidden) {
      setAuthError("Pehle 'Send OTP' button par click karke Gmail par OTP mangwayein.");
    } else {
      setAuthError('Please enter the 6-digit OTP sent to your Gmail.');
    }
    return;
  }
  if (!password || password.length < 10) {
    setAuthError('Password must be at least 10 characters long.');
    return;
  }

  authenticate('/api/v1/auth/otp/register', {
    target,
    otp,
    password,
    name,
    owner_name,
    location,
  }, 'Shop account created and password set!');
});

const forgotForm = $('#forgot-form');
if (forgotForm) {
  forgotForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const target = $('#forgot-target').value.trim();
    const otp = $('#forgot-otp').value.trim();
    const new_password = $('#forgot-password').value;

    if (!otp || otp.length < 4) {
      if ($('#forgot-otp-section') && $('#forgot-otp-section').hidden) {
        setAuthError("Pehle 'Send OTP' button par click karke Gmail par OTP mangwayein.");
      } else {
        setAuthError('Please enter the 6-digit OTP code.');
      }
      return;
    }
    if (!new_password || new_password.length < 10) {
      setAuthError('New password must be at least 10 characters long.');
      return;
    }

    authenticate('/api/v1/auth/otp/reset-password', {
      target,
      otp,
      new_password,
    }, 'Password reset successfully! You are logged in.');
  });
}

$('#auth-toggle').addEventListener('click', () => {
  const registerForm = $('#register-form');
  setAuthMode(registerForm && !registerForm.hidden ? 'login' : 'register');
});
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
  const [me, remoteCustomers, entriesResult] = await Promise.all([
    api('/api/v1/auth/me'),
    api('/api/v1/customers'),
    loadAllEntries().then((entries) => ({ entries })).catch((error) => ({ error })),
  ]);
  const remoteEntries = entriesResult.entries ?? null;
  if (remoteEntries !== null) {
    workspaceLoadError = '';
  } else {
    const error = entriesResult.error;
    // Authentication and customer data should remain usable when a ledger page
    // is temporarily malformed/unavailable, but never pretend history loaded.
    workspaceLoadError = error.message || 'Ledger history could not be loaded. Retry before recording an entry.';
  }
  merchant = me;
  if (remoteEntries) {
    transactions = remoteEntries.map((entry) => ({
      id: entry.id,
      customerId: entry.customer_id,
      amount: Number(entry.amount),
      type: entry.entry_type === 'udhaar' ? 'credit' : 'payment',
      note: entry.note || '',
      createdAt: entry.created_at,
      transactionDate: entry.transaction_date || entry.created_at,
    }));
  }
  const activityByCustomer = new Map();
  for (const entry of transactions) {
    const current = activityByCustomer.get(entry.customerId);
    if (!current || new Date(entry.createdAt) > new Date(current)) activityByCustomer.set(entry.customerId, entry.createdAt);
  }
  customers = remoteCustomers.map((customer) => ({
    id: customer.id,
    name: customer.name,
    displayName: displayCustomerName(customer.name),
    phone: customer.phone || '',
    balance: Number(customer.balance),
    lastActivity: activityByCustomer.get(customer.id) || null,
  }));
  profile = {
    shopName: me.name,
    ownerName: me.owner_name || '',
    location: me.location || '',
    upiId: me.upi_id || '',
  };
}

async function loadAllEntries() {
  const pageSize = 1000;
  const all = [];
  for (let offset = 0; ; offset += pageSize) {
    let page;
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        page = await api(`/api/v1/ledger/entries?limit=${pageSize}&offset=${offset}`);
        if (!Array.isArray(page)) throw new Error('The backend returned an invalid ledger page. Please retry loading your khata.');
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (error.status === 401 || attempt === 2) break;
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      }
    }
    if (lastError) throw lastError;
    all.push(...page);
    if (page.length < pageSize) return all;
  }
}

$('#retry-workspace-load').addEventListener('click', async () => {
  if (retryingWorkspaceLoad) return;
  retryingWorkspaceLoad = true;
  $('#retry-workspace-load').disabled = true;
  try {
    await loadWorkspace();
    renderAll();
    if (!workspaceLoadError) toast('Your khata history is up to date.');
  } catch (error) {
    workspaceLoadError = error.message || 'Could not reload your khata. Check your connection and retry.';
    renderAll();
  } finally {
    retryingWorkspaceLoad = false;
    $('#retry-workspace-load').disabled = false;
  }
});

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
  $('#shop-upi-id-input').value = profile.upiId || '';
}
function renderDate() {
  const now = new Date();
  $('#today-label').textContent = now.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).toUpperCase();
  $('#today-date').textContent = now.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  now.setHours(0, 0, 0, 0);
  if (!chartEndDate) chartEndDate = dateKey(now);
  if (!chartStartDate) {
    const firstDay = new Date(now);
    firstDay.setDate(firstDay.getDate() - 6);
    chartStartDate = dateKey(firstDay);
  }
  $('#chart-start-date').max = dateKey(now);
  $('#chart-end-date').max = dateKey(now);
  $('#chart-start-date').value = chartStartDate;
  $('#chart-end-date').value = chartEndDate;
}
function renderActivity() {
  const list = $('#activity-list');
  const items = [...transactions].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 5);
  if (!items.length) {
    list.innerHTML = '<div class="activity-empty"><span class="empty-mark">＋</span><b>Your ledger starts here</b><p>When you record a credit or payment, it will appear here.</p><button class="text-link" data-open-entry>Record your first entry →</button></div>';
    list.querySelector('[data-open-entry]').addEventListener('click', () => openEntry());
    return;
  }
  list.innerHTML = items.map((entry) => `<div class="activity-row"><span class="activity-symbol ${entry.type}">${entry.type === 'credit' ? '↗' : '↙'}</span><div class="activity-person"><b>${esc(displayCustomerName(customerName(entry.customerId)))}</b><small>${esc(displayTime(entry.createdAt))} · ${entry.type === 'credit' ? 'Udhaar' : 'Payment'}${entry.note ? ` · ${esc(entry.note)}` : ''}</small></div><div class="activity-amount ${entry.type}">${entry.type === 'credit' ? '+' : '−'}${money(entry.amount)}<small>${entry.type === 'credit' ? 'Added' : 'Received'}</small></div></div>`).join('');
}
function renderHomeCustomers() {
  const element = $('#home-customers');
  const owing = customers.map((customer) => ({ ...customer, balance: balanceOf(customer.id) })).filter((customer) => customer.balance > 0).sort((a, b) => b.balance - a.balance).slice(0, 4);
  if (!customers.length) {
    element.innerHTML = '<div class="empty-state"><b>No customers yet</b><p>Add a customer to start keeping their khata.</p><button class="text-link" data-add-home-customer>＋ Add your first customer</button></div>';
    element.querySelector('[data-add-home-customer]').addEventListener('click', openCustomer);
    return;
  }
  element.innerHTML = owing.length ? owing.map((customer) => `<button type="button" class="customer-mini" data-customer-id="${esc(customer.id)}" aria-label="View ${esc(customer.displayName)} history"><span class="customer-initial">${esc(initials(customer.displayName))}</span><span class="customer-mini-info"><b>${esc(customer.displayName)}</b><small>Outstanding</small></span><span class="customer-balance">${money(customer.balance)}</span></button>`).join('') : '<div class="empty-state"><b>All caught up</b><span>No customer has an outstanding balance.</span></div>';
}
function renderCustomers() {
  const query = ($('#customer-search').value || '').trim().toLowerCase();
  const filter = $('#balance-filter').value;
  const rows = customers.map((customer) => ({ ...customer, balance: balanceOf(customer.id) }))
    .filter((customer) => `${customer.name} ${customer.displayName} ${customer.phone}`.toLowerCase().includes(query))
    .filter((customer) => filter === 'owing' ? customer.balance > 0 : filter === 'settled' ? customer.balance === 0 : filter === 'advance' ? customer.balance < 0 : true)
    .sort((a, b) => a.name.localeCompare(b.name));
  $('#customer-count').textContent = `${rows.length} ${rows.length === 1 ? 'customer' : 'customers'}`;
  const body = $('#customer-rows');
  if (!rows.length) {
    body.innerHTML = customers.length ? '<tr><td colspan="6" class="table-empty">No customers match that search.</td></tr>' : '<tr><td colspan="6" class="table-empty">Your customer list is empty. Add a customer to start a khata.</td></tr>';
    return;
  }
  body.innerHTML = rows.map((customer) => `<tr class="customer-clickable-row" data-customer-id="${esc(customer.id)}"><td><span class="table-person"><span class="customer-initial">${esc(initials(customer.displayName))}</span>${esc(customer.displayName)}</span></td><td>${esc(customer.phone || '—')}</td><td>${esc(displayTime(customer.lastActivity))}</td><td><b>${money(Math.max(0, customer.balance))}</b>${customer.balance < 0 ? `<small class="advance-note"> · Advance ${money(-customer.balance)}</small>` : ''}</td><td><span class="status-badge ${customer.balance <= 0 ? 'settled' : ''}">${customer.balance > 0 ? 'Outstanding' : customer.balance < 0 ? 'Advance' : 'Settled'}</span></td><td><div class="customer-row-actions"><button type="button" class="row-history-button" data-view-customer="${esc(customer.id)}">View history →</button><button type="button" class="customer-delete-button" data-delete-customer="${esc(customer.id)}" aria-label="Delete ${esc(customer.displayName)}" title="Delete customer">Delete</button></div></td></tr>`).join('');
}
async function deleteCustomer(customerId) {
  const customer = customers.find((item) => item.id === customerId);
  if (!customer) return;
  if (!window.confirm(`Delete ${customer.displayName || displayCustomerName(customer.name)}? This permanently removes the customer and all of their ledger history.`)) return;
  const button = $(`[data-delete-customer="${CSS.escape(customerId)}"]`);
  if (button) button.disabled = true;
  try {
    await api(`/api/v1/customers/${encodeURIComponent(customerId)}`, { method: 'DELETE' });
    await loadWorkspace();
    renderAll();
    toast(`${customer.displayName || displayCustomerName(customer.name)} and their ledger history were deleted.`);
  } catch (error) {
    if (button) button.disabled = false;
    toast(error.message || 'Could not delete this customer.');
  }
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
  $('#customer-detail-name').textContent = displayCustomerName(customer.name);
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
  const today = dateKey(new Date());
  const viewItems = transactions.filter((entry) => ledgerView === 'payments-today' ? dateKey(entry.createdAt) === today && entry.type === 'payment' : ledgerView === 'entries-today' ? dateKey(entry.createdAt) === today : true);
  const items = [...viewItems].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  $('#ledger-view-label').textContent = ledgerView === 'payments-today' ? 'Payments received today' : ledgerView === 'entries-today' ? 'All entries recorded today' : 'All recorded transactions';
  $('#ledger-view-reset').hidden = ledgerView === 'all';
  if (!items.length) {
    body.innerHTML = `<tr><td colspan="5" class="table-empty">${ledgerView === 'all' ? 'Transactions you record will appear here.' : 'No matching entries for this view.'}</td></tr>`;
    return;
  }
  body.innerHTML = items.map((entry) => `<tr><td>${esc(new Date(entry.createdAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }))}</td><td>${esc(displayCustomerName(customerName(entry.customerId)))}</td><td>${esc(entry.note || '—')}</td><td><span class="status-badge ${entry.type === 'payment' ? 'settled' : ''}">${entry.type === 'credit' ? 'Udhaar' : 'Payment'}</span></td><td><b>${entry.type === 'credit' ? '+' : '−'}${money(entry.amount)}</b></td></tr>`).join('');
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
  const firstDay = new Date(`${chartStartDate}T12:00:00`);
  const lastDay = new Date(`${chartEndDate}T12:00:00`);
  const sevenDayStart = new Date(lastDay);
  sevenDayStart.setDate(sevenDayStart.getDate() - 6);
  const showWeekdayLabels = dateKey(firstDay) === dateKey(sevenDayStart) && dateKey(lastDay) === dateKey(new Date());
  for (const day = new Date(firstDay); day <= lastDay; day.setDate(day.getDate() + 1)) {
    const key = dateKey(day);
    const entries = transactions.filter((entry) => dateKey(entry.transactionDate || entry.createdAt) === key);
    days.push({
      label: showWeekdayLabels
        ? day.toLocaleDateString('en-IN', { weekday: 'short' })
        : day.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }),
      title: day.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }),
      credit: sums(entries, 'credit'), payment: sums(entries, 'payment'),
    });
  }
  const dateFormat = { day: 'numeric', month: 'short', year: 'numeric' };
  const rangeText = `${firstDay.toLocaleDateString('en-IN', dateFormat)} – ${lastDay.toLocaleDateString('en-IN', dateFormat)}`;
  $('#chart-range-label').textContent = showWeekdayLabels
    ? 'LAST 7 DAYS'
    : rangeText.toUpperCase();
  const max = Math.max(1, ...days.flatMap((day) => [day.credit, day.payment]));
  root.style.setProperty('--chart-day-count', String(days.length));
  root.style.minWidth = days.length > 7 ? `${days.length * 38}px` : '100%';
  root.innerHTML = days.map((day) => `<div class="week-day" title="${esc(day.title)} · Credit ${money(day.credit)} · Payment ${money(day.payment)}"><div class="week-bars"><span class="week-credit" style="height:${Math.max(day.credit ? 5 : 0, day.credit / max * 100)}%"></span><span class="week-payment" style="height:${Math.max(day.payment ? 5 : 0, day.payment / max * 100)}%"></span></div><small>${esc(day.label)}</small></div>`).join('');
}
$('#chart-date-filter').addEventListener('submit', (event) => {
  event.preventDefault();
  const start = $('#chart-start-date').value;
  const end = $('#chart-end-date').value;
  if (!start || !end || start > end) { toast('Choose a valid date range.'); return; }
  const startDate = new Date(`${start}T12:00:00`);
  const endDate = new Date(`${end}T12:00:00`);
  const dayCount = Math.round((endDate - startDate) / 86400000) + 1;
  if (dayCount > 366) { toast('Choose a range of up to one year.'); return; }
  chartStartDate = start;
  chartEndDate = end;
  renderWeeklyChart();
});
$('#chart-reset-date').addEventListener('click', () => {
  const end = new Date();
  end.setHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setDate(start.getDate() - 6);
  chartStartDate = dateKey(start);
  chartEndDate = dateKey(end);
  $('#chart-start-date').value = chartStartDate;
  $('#chart-end-date').value = chartEndDate;
  renderWeeklyChart();
});
function renderAll() {
  const warning = $('#workspace-load-warning');
  warning.hidden = !workspaceLoadError;
  $('#workspace-load-message').textContent = workspaceLoadError
    ? `${workspaceLoadError} New entries are disabled until the history loads.`
    : '';
  $('#retry-workspace-load').disabled = retryingWorkspaceLoad;
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
  const crumbPage = $('#crumb-page');
  if (crumbPage) crumbPage.textContent = page === 'customer' ? 'Customer history' : page === 'khata' ? 'Digital khata' : page === 'analytics' ? 'Analytics' : page === 'profile' ? 'Profile' : 'Overview';
  if (page === 'khata') renderCustomers();
  if (page === 'customer') renderCustomerDetail();
  if (page === 'analytics') renderSummary();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
$$('[data-page]:not(.profile-nav-link)').forEach((button) => button.addEventListener('click', () => go(button.dataset.page)));
$$('[data-metric-view]').forEach((button) => button.addEventListener('click', () => {
  const view = button.dataset.metricView;
  $('#customer-search').value = '';
  if (view === 'outstanding') { $('#balance-filter').value = 'owing'; ledgerView = 'all'; }
  else { $('#balance-filter').value = 'all'; ledgerView = view; }
  go('khata');
  if (view !== 'outstanding') requestAnimationFrame(() => $('.transactions-section').scrollIntoView({ behavior: 'smooth', block: 'start' }));
}));
$('#ledger-view-reset').addEventListener('click', () => { ledgerView = 'all'; renderTransactions(); });
$$('[data-goto]').forEach((button) => button.addEventListener('click', () => go(button.dataset.goto)));
$$('[data-open-entry]').forEach((button) => button.addEventListener('click', () => openEntry()));
$('#customer-rows').addEventListener('click', (event) => {
  const historyButton = event.target.closest('[data-view-customer]');
  if (historyButton) {
    openCustomerDetail(historyButton.dataset.viewCustomer);
    return;
  }
  const deleteButton = event.target.closest('[data-delete-customer]');
  if (deleteButton) {
    event.stopPropagation();
    deleteCustomer(deleteButton.dataset.deleteCustomer);
    return;
  }
  const row = event.target.closest('tr[data-customer-id]');
  if (row) openCustomerDetail(row.dataset.customerId);
});
$('#home-customers').addEventListener('click', (event) => {
  const customerButton = event.target.closest('[data-customer-id]');
  if (customerButton) openCustomerDetail(customerButton.dataset.customerId);
});
$('#customer-back').addEventListener('click', () => go('khata'));
$('#customer-detail-new-entry').addEventListener('click', () => openEntry(selectedCustomerId));
function paymentQrFile() {
  const encoded = window.VOICEKHATA_PAYMENT_QR_BASE64 || '';
  if (!encoded) return null;
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new File([bytes], 'VoiceKhata-payment-QR.png', { type: 'image/png' });
}

$('#customer-payment-request-whatsapp').addEventListener('click', async () => {
  const customer = customers.find((item) => item.id === selectedCustomerId);
  if (!customer) return;
  if (workspaceLoadError) { toast('Load the complete khata history before requesting payment.'); return; }
  const due = balanceOf(customer.id);
  if (due <= 0) { toast('This customer has no outstanding balance.'); return; }
  if (!profile.upiId) {
    toast('Add your shop UPI ID in Profile before requesting payment.');
    openProfilePopup(true);
    requestAnimationFrame(() => $('#popup-shop-upi-id').focus());
    return;
  }
  const digits = String(customer.phone || '').replace(/\D/g, '');
  const phone = digits.length === 10 ? `91${digits}` : digits.length === 12 && digits.startsWith('91') ? digits : '';
  const customerName = displayCustomerName(customer.name);
  const shopName = profile.shopName || 'our shop';
  const amount = money(due);
  const message = `Hello ${customerName}, your outstanding balance at ${shopName} is ${amount}. You can pay directly to this UPI ID: ${profile.upiId}. Please let me know after payment so I can verify it and update your khata.\n\nनमस्ते ${customerName} जी, ${shopName} के खाते में आपके ${amount} बाकी हैं। कृपया इस UPI ID पर भुगतान करें: ${profile.upiId}। भुगतान करने के बाद मुझे बता दें, ताकि मैं पुष्टि करके आपका खाता अपडेट कर सकूँ।`;
  const qrUrl = new URL('./payment-qr.png', window.location.href).href;
  const messageWithQrLink = `${message}\n\nPayment QR: ${qrUrl}`;
  const qrData = window.VOICEKHATA_PAYMENT_QR_BASE64 || '';

  // The Android companion can attach the QR directly to its system share sheet.
  if (qrData && window.VoiceKhataNative?.sharePaymentQr?.(qrData, messageWithQrLink)) {
    toast('Choose WhatsApp and the customer to share the payment request with its QR. Verify the payment yourself before recording it.');
    return;
  }

  // Browsers that support file sharing can send the QR image and caption together.
  const qrFile = paymentQrFile();
  if (qrFile && navigator.share && navigator.canShare?.({ files: [qrFile] })) {
    try {
      await navigator.share({ files: [qrFile], title: `Payment request for ${customerName}`, text: messageWithQrLink });
      toast('Choose WhatsApp and the customer to share the payment request with its QR. Verify the payment yourself before recording it.');
      return;
    } catch (error) {
      if (error?.name === 'AbortError') return;
    }
  }

  // Keep direct-to-customer chat on browsers without image sharing; the QR link
  // remains in the prefilled WhatsApp message so the customer can open it.
  const target = phone ? `https://wa.me/${phone}?text=${encodeURIComponent(messageWithQrLink)}` : `https://wa.me/?text=${encodeURIComponent(messageWithQrLink)}`;
  window.open(target, '_blank', 'noopener,noreferrer');
  toast('Payment request opened in WhatsApp with the payment QR link. Verify the payment yourself before recording it.');
});
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
  if (workspaceLoadError) {
    toast('Load your complete khata history before recording a new entry.');
    return;
  }
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
    return `<option value="${esc(customer.id)}">${esc(displayCustomerName(customer.name))}${identity} · balance ${money(balanceOf(customer.id))}</option>`;
  }).join('');
  select.innerHTML = `<option value="" disabled>Choose a customer</option>${options}`;
  select.value = selectedId || (ordered.length === 1 ? ordered[0].id : '');
}
function setProfilePopupEditing(editing) {
  ['#popup-shop-name', '#popup-owner-name', '#popup-shop-location', '#popup-shop-upi-id'].forEach((selector) => { $(selector).disabled = !editing; });
  $('#profile-edit').hidden = editing;
  $('#profile-cancel').hidden = !editing;
  $('#profile-save').hidden = !editing;
  $('#profile-delete').hidden = editing;
  $('#profile-dialog-title').textContent = editing ? 'Edit profile' : 'Profile details';
}
function openProfilePopup(editing = false) {
  $('#popup-shop-name').value = profile.shopName || '';
  $('#popup-owner-name').value = profile.ownerName || '';
  $('#popup-shop-location').value = profile.location || '';
  $('#popup-shop-upi-id').value = profile.upiId || '';
  $('#popup-account-email').textContent = merchant?.email || 'No email saved';
  $('#popup-account-phone').textContent = merchant?.phone || 'No phone saved';
  setProfilePopupEditing(editing);
  $('#profile-dialog').showModal();
  if (editing) requestAnimationFrame(() => $('#popup-shop-name').focus());
}
$('#profile-link').addEventListener('click', () => openProfilePopup());
$$('.profile-nav-link').forEach((button) => button.addEventListener('click', () => openProfilePopup()));
$('#shop-profile').addEventListener('click', () => openProfilePopup());
$('#profile-edit').addEventListener('click', () => {
  setProfilePopupEditing(true);
  requestAnimationFrame(() => $('#popup-shop-name').focus());
});
$('#profile-cancel').addEventListener('click', () => {
  setProfilePopupEditing(false);
  $('#popup-shop-name').value = profile.shopName || '';
  $('#popup-owner-name').value = profile.ownerName || '';
  $('#popup-shop-location').value = profile.location || '';
  $('#popup-shop-upi-id').value = profile.upiId || '';
});
$('#profile-popup-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const saveButton = $('#profile-save');
  saveButton.disabled = true;
  try {
    merchant = await api('/api/v1/auth/me', {
      method: 'PATCH',
      body: JSON.stringify({
        name: $('#popup-shop-name').value.trim(),
        owner_name: $('#popup-owner-name').value.trim() || null,
        location: $('#popup-shop-location').value.trim() || null,
        upi_id: $('#popup-shop-upi-id').value.trim() || null,
      }),
    });
    profile = { shopName: merchant.name, ownerName: merchant.owner_name || '', location: merchant.location || '', upiId: merchant.upi_id || '' };
    renderAll();
    setProfilePopupEditing(false);
    $('#profile-dialog').close();
    toast('Profile saved');
  } catch (error) {
    toast(error.message);
  } finally {
    saveButton.disabled = false;
  }
});
$('#profile-delete').addEventListener('click', () => {
  $('#delete-shop-name-confirm').textContent = profile.shopName;
  $('#delete-shop-name-input').value = '';
  $('#confirm-delete-profile').disabled = true;
  $('#profile-dialog').close();
  $('#delete-profile-dialog').showModal();
});
$('#delete-shop-name-input').addEventListener('input', (event) => {
  $('#confirm-delete-profile').disabled = event.target.value.trim() !== (profile.shopName || '').trim();
});
$('#cancel-delete-profile').addEventListener('click', () => {
  $('#delete-profile-dialog').close();
  openProfilePopup();
});
$('#confirm-delete-profile').addEventListener('click', async () => {
  const button = $('#confirm-delete-profile');
  if (button.disabled) return;
  button.disabled = true;
  button.textContent = 'Deleting…';
  try {
    await api('/api/v1/auth/me', { method: 'DELETE' });
    token = '';
    merchant = null;
    customers = [];
    transactions = [];
    localStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(PENDING_ENTRY_KEY);
    pendingLedgerRequest = null;
    $('#delete-profile-dialog').close();
    showAuth('Your shop account and its data have been deleted.');
  } catch (error) {
    toast(error.message || 'Could not delete this account.');
  } finally {
    button.textContent = 'Delete account and data';
  }
});
$('#profile-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    merchant = await api('/api/v1/auth/me', {
      method: 'PATCH',
      body: JSON.stringify({
        name: $('#shop-name-input').value.trim(),
        owner_name: $('#owner-name-input').value.trim() || null,
        location: $('#shop-location-input').value.trim() || null,
        upi_id: $('#shop-upi-id-input').value.trim() || null,
      }),
    });
    profile = { shopName: merchant.name, ownerName: merchant.owner_name || '', location: merchant.location || '', upiId: merchant.upi_id || '' };
    renderAll();
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
    toast(`${displayCustomerName(name)} added to your khata`);
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
            toast(`${displayCustomerName(matches[0].name)} is already in your khata. Choose udhaar or payment for them; use a distinguishing name for a different person.`);
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
$('#customer-search').addEventListener('input', renderCustomers);
$('#balance-filter').addEventListener('change', renderCustomers);
$('#voice-language').disabled = true;
$('#voice-language').textContent = 'HI+EN';
$('#voice-language').setAttribute('aria-label', 'Hindi and Hinglish voice input');
$('#voice-language').title = 'Hindi voice input with common English words';

const NUMBER_WORDS = { zero:0, 'शून्य':0, sifar:0, one:1, ek:1, 'एक':1, two:2, do:2, 'दो':2, three:3, teen:3, 'तीन':3, four:4, char:4, chaar:4, 'चार':4, five:5, paanch:5, panch:5, 'पांच':5, 'पाँच':5, six:6, chhe:6, 'छह':6, 'छे':6, seven:7, saat:7, 'सात':7, eight:8, aath:8, 'आठ':8, nine:9, nau:9, 'नौ':9, ten:10, das:10, 'दस':10, eleven:11, gyarah:11, 'ग्यारह':11, twelve:12, barah:12, 'बारह':12, thirteen:13, terah:13, 'तेरह':13, fourteen:14, chaudah:14, 'चौदह':14, fifteen:15, pandrah:15, 'पंद्रह':15, sixteen:16, solah:16, 'सोलह':16, seventeen:17, satrah:17, 'सत्रह':17, eighteen:18, atharah:18, 'अठारह':18, nineteen:19, unnis:19, 'उन्नीस':19, twenty:20, bees:20, 'बीस':20, thirty:30, tees:30, 'तीस':30, forty:40, chalis:40, 'चालीस':40, fifty:50, pachaas:50, 'पचास':50, sixty:60, saath:60, 'साठ':60, seventy:70, sattar:70, 'सत्तर':70, eighty:80, assi:80, 'अस्सी':80, ninety:90, nabbe:90, 'नब्बे':90, hundred:100, sau:100, 'सौ':100, thousand:1000, hazaar:1000, 'हजार':1000, lakh:100000, lac:100000 };
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
async function retrySafeVoiceSave(path, options) {
  try {
    return await api(path, options);
  } catch (error) {
    // A lost response may mean the server committed the entry. Retrying the
    // same voice-session ID is safe: the backend rejects duplicate commits.
    if (error.status === 400 || error.status === 401 || error.status === 403 || error.status === 422) throw error;
    await new Promise((resolve) => setTimeout(resolve, 500));
    return api(path, options);
  }
}
function prepareVoiceEntry(raw, sessionId = null, parsedEntry = null) {
  const parsed = parsedEntry ? {
    customer: parsedEntry.customer_name,
    customerId: parsedEntry.customer_id || null,
    ambiguousCustomerIds: [],
    suggestedCustomerIds: [],
    amount: Number(parsedEntry.amount),
    type: parsedEntry.entry_type === 'jama' ? 'payment' : 'credit',
    typeSpecified: true,
    raw: raw.trim(),
  } : parseCommand(raw);
  if (!parsed) { cancelVoiceSession(sessionId); return; }
  if (parsed.error) { cancelVoiceSession(sessionId); toast(parsed.error); speakText(parsed.error); return; }
  if (parsedEntry?.batchEntries?.length > 1) parsed.batchEntries = parsedEntry.batchEntries;
  parsed.sessionId = sessionId;
  pendingVoiceEntry = parsed;
  beginVoiceConfirmation(parsed);
}
function beginVoiceConfirmation(entry) {
  voiceConversation = {
    entry,
    customerResolved: false,
    candidates: [],
    candidateKind: '',
    newCustomerName: entry.newCustomerName || '',
    phoneCollected: Boolean(entry.phoneCollected),
  };
  pendingVoiceEntry = entry;
  advanceVoiceConversation();
}
function fallbackConversationToForm(entry, message) {
  stopVoiceReply();
  cancelVoiceSession(entry.sessionId);
  pendingVoiceEntry = null;
  voiceConversation = null;
  if (isHandsFreeVoiceSession()) {
    failHandsFreeVoiceSession('माफ़ कीजिए, आवाज़ साफ़ नहीं सुनाई दी। कुछ सेव नहीं हुआ। दोबारा assistant button दबाकर कोशिश करें।');
    return;
  }
  setVoiceReady('Nothing was saved. Start voice entry again when ready.');
  if (message) toast(`${message} Nothing was saved.`);
}
async function askConversationQuestion(entry, prompt, onAnswer, options = {}) {
  await requestVoiceCapabilities();
  pendingVoiceEntry = entry;
  const nativeReplyCaptureAvailable = isHandsFreeVoiceSession() && typeof window.VoiceKhataNative?.startReplyCapture === 'function';
  const browserReplyCaptureAvailable = window.MediaRecorder && navigator.mediaDevices?.getUserMedia && (window.AudioContext || window.webkitAudioContext);
  const canUseGnaniForAnswers = gnaniSttEnabled && (nativeReplyCaptureAvailable || browserReplyCaptureAvailable);
  if (!canUseGnaniForAnswers || !gnaniTtsEnabled) {
    fallbackConversationToForm(entry, 'Hands-free questions are not available in this browser.');
    return;
  }
  awaitingVoiceReply = true;
  updateHandsFreeStatus('सवाल सुनिए…');
  $('#voice-title').textContent = 'Please answer by voice';
  $('#voice-subtitle').textContent = 'I will ask one question at a time.';
  $('#voice-caption').innerHTML = '<span class="voice-dot"></span><span>Speaking a question…</span>';
  let spokenPrompt = prompt;
  const state = voiceConversation;
  const candidates = (state?.candidates || []).map((customer) => customer.phone
    ? `${customer.name} (ending ${customer.phone.replace(/\D/g, '').slice(-4)})`
    : customer.name).slice(0, 10);
  if (entry.sessionId && options.generateQuestionWithGemini !== false) {
    api(`/api/v1/voice/sessions/${entry.sessionId}/question`, {
      method: 'POST',
      body: JSON.stringify({
        draft_question: prompt,
        current_entry: {
          customer_name: entry.customer || '',
          amount: entry.amount == null ? null : String(entry.amount),
          entry_type: entry.type === 'payment' ? 'jama' : 'udhaar',
        },
        candidate_names: candidates,
        language_code: voiceLanguage,
      }),
    }).then((result) => {
      if (result.parser_notice && !geminiQuestionWarningShown) {
        geminiQuestionWarningShown = true;
        toast(result.parser_notice);
      }
      spokenPrompt = result.question || prompt;
    }).catch(() => {
      if (!geminiQuestionWarningShown) {
        geminiQuestionWarningShown = true;
        toast('Gemini question service is unavailable. Using a short built-in question.');
      }
    }).finally(() => {
      if (!awaitingVoiceReply || pendingVoiceEntry !== entry) return;
      speakQuestionAndListen();
    });
  } else {
    speakQuestionAndListen();
  }
  function speakQuestionAndListen() {
    const activePrompt = spokenPrompt;
  const handleAnswer = async (heard) => {
    if (!entry.sessionId || options.interpretAnswerWithGemini === false) { onAnswer(heard); return; }
    const awaitingNewCustomerName = voiceConversation?.entry === entry && voiceConversation.awaitingNewCustomerName;
    let interpretation;
    try {
      interpretation = await api(`/api/v1/voice/sessions/${entry.sessionId}/reply`, {
        method: 'POST',
        body: JSON.stringify({
          question: activePrompt,
          transcript: heard,
          current_entry: {
            customer_name: entry.customer || '',
            customer_id: entry.customerId || null,
            amount: entry.amount == null ? null : String(entry.amount),
            entry_type: entry.type === 'payment' ? 'jama' : 'udhaar',
            relative_date: 'today',
            note: entry.raw || '',
          },
        }),
      });
    } catch {
      // Keep the local conversation usable if Gemini is temporarily unavailable.
      onAnswer(heard);
      return;
    }
    if (interpretation.parser_notice && !geminiQuestionWarningShown) {
      geminiQuestionWarningShown = true;
      toast(interpretation.parser_notice);
    }
    const revised = interpretation.updated_entry || {};
    if (awaitingNewCustomerName) {
      // This turn is collecting a proposed NEW customer's name. Do not let a
      // Gemini match to an existing ID turn that answer into account selection.
      // Keep yes/no answers intact; use Gemini's Latin-script name when the
      // shopkeeper supplied a name so duplicate checks can ask for a distinction.
      const intent = voiceIntent(transcriptWords(heard));
      const answer = intent.yes || intent.no || intent.isNew
        ? heard
        : (revised.customer_name || interpretation.normalized_answer || heard);
      onAnswer(answer);
      return;
    }
    if (revised.customer_name) entry.customer = revised.customer_name;
    if (revised.customer_id) entry.customerId = revised.customer_id;
    if (revised.amount != null && Number(revised.amount) > 0) entry.amount = Number(revised.amount);
    if (revised.entry_type === 'udhaar' || revised.entry_type === 'jama') {
      entry.type = revised.entry_type === 'jama' ? 'payment' : 'credit';
      entry.typeSpecified = true;
    }
    const heardWords = transcriptWords(heard);
    if (responseHas(heardWords, new Set(['cancel', 'रद्द', 'stop', 'बंद']))) {
      cancelVoiceConversation(entry);
      return;
    }
    if (interpretation.action === 'CLARIFY') {
      askConversationQuestion(entry, interpretation.spoken_response || prompt, onAnswer);
      return;
    }
    if (interpretation.action === 'CORRECT') {
      const state = voiceConversation?.entry === entry ? voiceConversation : {
        entry, customerResolved: Boolean(entry.customerId || entry.newCustomerName), candidates: [], candidateKind: '', newCustomerName: entry.newCustomerName || '',
      };
      voiceConversation = state;
      // A recognized name alone must not select an existing account. When the
      // conversation was still resolving the customer, re-run the explicit
      // existing-vs-new question even if Gemini matched the spoken name to an
      // existing customer ID. This prevents credit being silently assigned to
      // someone with the same name.
      state.customerResolved = state.customerResolved || Boolean(state.newCustomerName);
      advanceVoiceConversation();
      return;
    }
    onAnswer(interpretation.normalized_answer || heard);
  };
  speakText(activePrompt).then((played) => {
    if (!awaitingVoiceReply || pendingVoiceEntry !== entry) return;
    if (!played) { fallbackConversationToForm(entry, 'Could not play the voice question.'); return; }
    updateHandsFreeStatus('जवाब सुन रहा हूँ…');
    listenForVoiceConfirmation(entry, (answer) => {
      handsFreeQuestionRetries = 0;
      handleAnswer(answer);
    }, (message) => {
      if (isHandsFreeVoiceSession() && handsFreeQuestionRetries < 2) {
        handsFreeQuestionRetries += 1;
        retryHandsFreeQuestion(entry, activePrompt, onAnswer);
        return;
      }
      fallbackConversationToForm(entry, message);
    });
  });
  }
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
function parseMobileNumberReply(raw) {
  const text = normaliseDigits(String(raw || '').trim());
  let digits = (text.match(/\d/g) || []).join('');
  if (![10, 11, 12].includes(digits.length)) {
    const ignored = new Set(['mobile', 'phone', 'number', 'mera', 'mere', 'hai', 'ji', 'नंबर', 'मोबाइल', 'फोन', 'मेरा', 'मेरे', 'है', 'जी']);
    const tokens = transcriptWords(text);
    const spokenDigits = [];
    for (const token of tokens) {
      if (ignored.has(token)) continue;
      const digit = NUMBER_WORDS[token];
      if (digit == null || digit < 0 || digit > 9) return null;
      spokenDigits.push(String(digit));
    }
    digits = spokenDigits.join('');
  }
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return /^[6-9]\d{9}$/.test(digits) ? digits : null;
}
function customerHasPhone(phone) {
  return customers.some((customer) => String(customer.phone || '').replace(/\D/g, '') === phone);
}
function collectNewCustomerPhone(entry, prompt = 'मोबाइल नंबर बोलें। नहीं देना हो तो “स्किप” कहें।') {
  askConversationQuestion(entry, prompt, (heard) => {
    const state = voiceConversation;
    if (!state) return;
    const normalizedAnswer = String(heard || '').normalize('NFC').trim().toLocaleLowerCase('en-IN');
    const words = transcriptWords(normalizedAnswer);
    const skip = responseHas(words, new Set([
      'skip', 'स्किप', 'chhodo', 'chhod', 'mat', 'nahi', 'nahin', 'no', 'not', 'dont',
      'छोड़ें', 'छोड़ें', 'छोड़', 'छोड़ना', 'छोड़िए', 'नहीं', 'नही', 'मत',
    ])) || /(?:नंबर|फोन|मोबाइल)\s+(?:नहीं|नही|मत|नहीं देना|नहीं बताना)/iu.test(normalizedAnswer)
      || /\b(?:don't|do not|not)\s+(?:want to\s+)?(?:share|give|provide)\b/iu.test(normalizedAnswer)
      || /\b(?:don't|do not)\s+want(?: to)?\b/iu.test(normalizedAnswer)
      || /\b(?:no|not)\s+(?:phone|mobile|number)\b/iu.test(normalizedAnswer);
    const phone = parseMobileNumberReply(heard);
    if (!phone && skip) {
      state.newCustomerPhone = null;
      state.phoneCollected = true;
      advanceVoiceConversation();
      return;
    }
    if (!phone) {
      collectNewCustomerPhone(entry, '10 अंकों का नंबर बोलें, या “स्किप” कहें।');
      return;
    }
    if (customerHasPhone(phone)) {
      collectNewCustomerPhone(entry, 'यह नंबर पहले से है। दूसरा नंबर बोलें या “स्किप” कहें।');
      return;
    }
    state.newCustomerPhone = phone;
    state.phoneCollected = true;
    advanceVoiceConversation();
  }, { interpretAnswerWithGemini: false, generateQuestionWithGemini: false });
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
  state.awaitingNewCustomerName = true;
  const name = state.entry.customer;
  const prompt = requireDistinct
    ? `${name} पहले से है। नए ग्राहक का अलग नाम?`
    : `नया ${name}, इसी नाम से सेव करूँ या अलग नाम?`;
  askConversationQuestion(state.entry, prompt, (heard) => {
    state.awaitingNewCustomerName = false;
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
      state.awaitingNewCustomerName = true;
      askConversationQuestion(state.entry, `ठीक। नए ग्राहक का अलग नाम?`, (differentName) => {
        state.awaitingNewCustomerName = false;
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
      ? `${entry.customer} पहले से है। पुराना ग्राहक या नया ग्राहक?`
      : `कौन सा ${details}? पुराना ग्राहक या नया ग्राहक?`;
    askConversationQuestion(entry, prompt, (heard) => {
      const words = transcriptWords(heard);
      const intent = voiceIntent(words);
      if (intent.old) {
        if (candidates.length === 1) { resolveVoiceCustomer(candidates[0]); return; }
        const selected = voiceReplyChoice(entry, heard);
        if (selected) { resolveVoiceCustomer(selected); return; }
        askConversationQuestion(entry, `कौन सा खाता? फोन के आखिरी चार अंक?`, (accountReply) => {
          const choice = voiceReplyChoice(entry, accountReply);
          if (choice) resolveVoiceCustomer(choice);
          else fallbackConversationToForm(entry, 'I could not identify the old account.');
        });
        return;
      }
      if (intent.isNew) { beginNewVoiceCustomerName(true); return; }
      askConversationQuestion(entry, `पुराना ग्राहक या नया ग्राहक?`, arguments_ => {
        const next = voiceIntent(transcriptWords(arguments_));
        if (next.old && candidates.length === 1) resolveVoiceCustomer(candidates[0]);
        else if (next.isNew) beginNewVoiceCustomerName(true);
        else fallbackConversationToForm(entry, 'I could not tell which customer you meant.');
      });
    });
    return;
  }
  setVoiceCustomerCandidates([], 'new');
  askConversationQuestion(entry, `${entry.customer} नहीं मिला। नया ग्राहक है?`, (heard) => {
    const intent = voiceIntent(transcriptWords(heard));
    if (intent.yes || intent.isNew) { beginNewVoiceCustomerName(false); return; }
    if (intent.no) {
      askConversationQuestion(entry, `पुराने ग्राहक का पूरा नाम?`, (nameReply) => {
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
    askConversationQuestion(entry, `कितने रुपये?`, (heard) => {
      const amount = parseAmountReply(heard);
      if (!amount) {
        askConversationQuestion(entry, `रकम साफ़ बोलें, जैसे पाँच सौ।`, (retry) => {
          const retryAmount = parseAmountReply(retry);
          if (!retryAmount) fallbackConversationToForm(entry, 'I could not understand the amount.');
          else { entry.amount = retryAmount; advanceVoiceConversation(); }
        });
      } else { entry.amount = amount; advanceVoiceConversation(); }
    });
    return;
  }
  if (!entry.typeSpecified) {
    askConversationQuestion(entry, `उधार या जमा?`, (heard) => {
      const words = transcriptWords(heard);
      if (responseHas(words, new Set(['उधार', 'उधर', 'उधारी', 'udhaar', 'udhar', 'credit']))) {
        entry.type = 'credit'; entry.typeSpecified = true; advanceVoiceConversation(); return;
      }
      if (responseHas(words, new Set(['जमा', 'jama', 'payment', 'paid', 'मिले', 'मिला', 'received']))) {
        entry.type = 'payment'; entry.typeSpecified = true; advanceVoiceConversation(); return;
      }
      askConversationQuestion(entry, `उधार या जमा, कौन सा?`, (retry) => {
        const next = transcriptWords(retry);
        if (responseHas(next, new Set(['उधार', 'उधर', 'उधारी', 'udhaar', 'udhar', 'credit']))) { entry.type = 'credit'; entry.typeSpecified = true; advanceVoiceConversation(); }
        else if (responseHas(next, new Set(['जमा', 'jama', 'payment', 'paid', 'मिले', 'मिला', 'received']))) { entry.type = 'payment'; entry.typeSpecified = true; advanceVoiceConversation(); }
        else fallbackConversationToForm(entry, 'I could not understand udhaar or payment.');
      });
    });
    return;
  }
  if (!state.customerResolved) { startVoiceCustomerResolution(); return; }
  if (state.newCustomerName && !state.phoneCollected) {
    collectNewCustomerPhone(entry);
    return;
  }
  entry.customer = state.newCustomerName || entry.customer;
  entry.newCustomerPhone = state.newCustomerPhone || null;
  entry.newCustomerName = state.newCustomerName || '';
  entry.phoneCollected = state.phoneCollected;
  pendingVoiceEntry = entry;
  voiceConversation = null;
  $('#voice-title').textContent = 'Saving your entry';
  $('#voice-subtitle').textContent = 'Adding it to your khata now.';
  $('#voice-caption').innerHTML = `<span class="voice-dot"></span><span>${esc(displayCustomerName(entry.customer))} · ${money(entry.amount)} · ${entry.type === 'credit' ? 'Udhaar' : 'Payment'}</span>`;
  $('#confirm-transaction').click();
}
function releaseVoiceReplyAudio() {
  if (voiceReplyProcessedStream) { voiceReplyProcessedStream.getTracks().forEach((track) => track.stop()); voiceReplyProcessedStream = null; }
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
  if (isHandsFreeVoiceSession() && typeof window.VoiceKhataNative?.startReplyCapture === 'function') {
    nativeVoiceReplyHandlers = { entry, onReply, onFallback: finishFallback };
    $('#voice-caption').innerHTML = '<span class="voice-dot"></span><span>Listening… speak your answer</span>';
    updateHandsFreeStatus('जवाब सुन रहा हूँ…');
    if (!window.VoiceKhataNative.startReplyCapture()) {
      nativeVoiceReplyHandlers = null;
      finishFallback('Could not start the phone microphone. Please try again.');
    }
    return;
  }
  (async () => {
    try {
      voiceReplyStream = await navigator.mediaDevices.getUserMedia(voiceMicrophoneConstraints());
      if (!awaitingVoiceReply || pendingVoiceEntry !== entry) { releaseVoiceReplyAudio(); return; }
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext || !window.MediaRecorder) throw new Error('This browser cannot record voice answers.');
      voiceReplyContext = new AudioContext();
      if (voiceReplyContext.state === 'suspended') await voiceReplyContext.resume();
      const enhanced = createEnhancedAudioPath(voiceReplyStream, voiceReplyContext);
      voiceReplyProcessedStream = enhanced.stream;
      const analyserNode = enhanced.analyser;
      const samples = new Uint8Array(analyserNode.fftSize);
      const mimeType = typeof MediaRecorder.isTypeSupported === 'function'
        ? ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find((type) => MediaRecorder.isTypeSupported(type))
        : '';
      voiceReplyRecorder = mimeType ? new MediaRecorder(voiceReplyProcessedStream, { mimeType }) : new MediaRecorder(voiceReplyProcessedStream);
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
          updateHandsFreeStatus('आपका जवाब समझ रहा हूँ…');
          const wav = await encodeWav16k(audio);
          const form = new FormData();
          form.append('audio', wav, 'voice-answer.wav');
          form.append('language_code', voiceLanguage);
          const result = await api('/api/v1/voice/transcribe', { method: 'POST', body: form });
          if (!awaitingVoiceReply || pendingVoiceEntry !== entry) return;
          handled = true;
          stopVoiceReply();
          if (onReply) onReply(result.transcript);
          else if (onFallback) onFallback('I could not process that voice reply.');
          else fallbackConversationToForm(entry, 'I could not process that voice reply.');
        } catch (error) {
          finishFallback(error.message || 'Could not understand your answer. Please try again.');
        }
      };
      voiceReplyRecorder.start(200);
      $('#voice-caption').innerHTML = '<span class="voice-dot"></span><span>Listening… speak your answer</span>';
      updateHandsFreeStatus('जवाब सुन रहा हूँ…');
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
  if (nativeVoiceReplyHandlers) {
    nativeVoiceReplyHandlers = null;
    try { window.VoiceKhataNative?.cancelReplyCapture?.(); } catch {}
  }
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
  if (isHandsFreeVoiceSession()) {
    failHandsFreeVoiceSession('माफ़ कीजिए, आपका जवाब सुनाई नहीं दिया। कुछ सेव नहीं हुआ। दोबारा assistant button दबाकर कोशिश करें।');
    return;
  }
  stopVoiceReply();
  pendingVoiceEntry = null;
  voiceConversation = null;
  cancelVoiceSession(entry.sessionId);
  setVoiceReady('Nothing was saved. Start voice entry again when ready.');
  if (message) toast(`${message} Nothing was saved. Please start voice entry again.`);
}
function listenForVoiceConfirmation(entry, onReply = null, onFallback = null) {
  if (!awaitingVoiceReply || pendingVoiceEntry !== entry) return;
  if (isHandsFreeVoiceSession() && typeof window.VoiceKhataNative?.startReplyCapture === 'function') {
    listenForGnaniReply(entry, onReply, onFallback);
    return;
  }
  if (gnaniSttEnabled && window.MediaRecorder && navigator.mediaDevices?.getUserMedia && (window.AudioContext || window.webkitAudioContext)) {
    listenForGnaniReply(entry, onReply, onFallback);
    return;
  }
  if (onFallback) onFallback('Gnani speech recognition is not available.');
  else showVoiceReplyFallback(entry, 'Gnani speech recognition is not available.');
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
function cancelVoiceConversation(entry) {
  stopVoiceReply();
  pendingVoiceEntry = null;
  voiceConversation = null;
  cancelVoiceSession(entry.sessionId);
  setVoiceReady('Entry cancelled. Nothing was saved.');
  const reply = 'ठीक, एंट्री रद्द। कुछ सेव नहीं हुआ।';
  if (isHandsFreeVoiceSession()) finishHandsFreeAfterSpeech(reply);
  else speakText(reply);
}
let confirmingVoiceEntry = false;
$('#confirm-transaction').addEventListener('click', async () => {
  if (!pendingVoiceEntry || confirmingVoiceEntry) return;
  confirmingVoiceEntry = true;
  const confirmButton = $('#confirm-transaction');
  confirmButton.disabled = true;
  const entry = pendingVoiceEntry;
  pendingVoiceEntry = null;
  voiceConversation = null;
  try {
    if (entry.batchEntries?.length > 1) {
      if (entry.batchEntries.some((item) => !item.customer_id)) {
        cancelVoiceSession(entry.sessionId);
        setVoiceReady('Nothing was saved. Please record one customer at a time.');
        toast('One or more customer names need clarification. Please record one customer at a time.');
        if (isHandsFreeVoiceSession()) finishHandsFreeAfterSpeech('ग्राहक का नाम साफ़ नहीं है। सुरक्षा के लिए कुछ सेव नहीं हुआ। एक बार में एक ग्राहक की एंट्री बोलें।');
        else speakText('ग्राहक का नाम साफ़ नहीं है। सुरक्षा के लिए कुछ सेव नहीं हुआ। एक बार में एक ग्राहक की एंट्री बोलें।');
        return;
      }
      await retrySafeVoiceSave(`/api/v1/voice/sessions/${entry.sessionId}/confirm-all`, { method: 'POST' });
      await loadWorkspace();
      renderAll();
      setVoiceReady(`${entry.batchEntries.length} entries saved. Your khata is up to date.`);
      toast(`${entry.batchEntries.length} entries saved to your khata`);
      const savedMessage = `${entry.batchEntries.length} एंट्री खाते में दर्ज हुईं।`;
      if (isHandsFreeVoiceSession()) finishHandsFreeAfterSpeech(savedMessage);
      else speakText(savedMessage);
      return;
    }
    let customerId = entry.customerId;
    if (entry.ambiguousCustomerIds?.length || entry.suggestedCustomerIds?.length) {
      pendingVoiceEntry = entry;
      beginVoiceConfirmation(entry);
      return;
    }
    if (!customerId) {
      const created = await api('/api/v1/customers', { method: 'POST', body: JSON.stringify({ name: entry.customer, phone: entry.newCustomerPhone || null }) });
      customerId = created.id;
    }
    const payload = {
      customer_id: customerId,
      amount: entry.amount,
      entry_type: entry.type === 'credit' ? 'udhaar' : 'jama',
      note: entry.raw || null,
    };
    if (entry.sessionId) {
      await retrySafeVoiceSave(`/api/v1/voice/sessions/${entry.sessionId}/confirm`, { method: 'POST', body: JSON.stringify(payload) });
      await loadWorkspace();
      renderAll();
    } else {
      await createLedgerEntry(customerId, entry.amount, entry.type, entry.raw);
    }
    setVoiceReady('Entry saved. Your khata is up to date.');
    toast('Confirmed entry saved to your khata');
    const savedCustomerName = customerName(customerId);
    const savedMessage = `${savedCustomerName} के ${Number(entry.amount).toLocaleString('hi-IN')} रुपये ${entry.type === 'credit' ? 'उधार' : 'जमा'} दर्ज हुए।`;
    if (isHandsFreeVoiceSession()) finishHandsFreeAfterSpeech(savedMessage);
    else speakText(savedMessage);
  } catch (error) {
    if (entry.sessionId && error.status === 409) {
      try {
        await loadWorkspace();
        renderAll();
        toast('This voice entry was already handled. Your ledger has been refreshed.');
        if (isHandsFreeVoiceSession()) finishHandsFreeAfterSpeech('यह voice entry पहले ही दर्ज हो चुकी है। आपका खाता अपडेट कर दिया है।');
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
          beginVoiceConfirmation(pendingVoiceEntry);
          toast(matches.length === 1
            ? `${matches[0].name} already exists. I’ll ask which account you mean.`
            : `More than one ${matches[0].name} exists. I’ll ask which account you mean.`);
          return;
        }
      } catch (refreshError) {
        toast(`Customer already exists, but the list could not refresh: ${refreshError.message}`);
        if (isHandsFreeVoiceSession()) failHandsFreeVoiceSession('ग्राहक की जानकारी जाँच नहीं हो पाई। कुछ सेव नहीं हुआ। नेटवर्क ठीक होने पर फिर कोशिश करें।');
        return;
      }
    }
    if (entry.sessionId && !pendingVoiceEntry) {
      // Do not leave a failed voice save in a confirmation dialog. The voice
      // session can only create one ledger entry, so an ambiguous result must
      // be checked against the refreshed ledger before another attempt.
      voiceConversation = null;
      if (isHandsFreeVoiceSession()) {
        failHandsFreeVoiceSession('एंट्री सेव होने की पुष्टि नहीं मिल पाई। दोबारा बोलने से पहले खाता जाँचें।');
        return;
      }
      setVoiceReady('Entry was not saved. Start voice entry again after checking your connection.');
      toast('Could not save the entry. Nothing was saved; check your connection and try again.');
      speakText('एंट्री सेव नहीं हुई। कृपया इंटरनेट जाँचकर दोबारा बोलें।');
      return;
    }
    toast(error.message);
    if (isHandsFreeVoiceSession()) failHandsFreeVoiceSession('एंट्री सेव नहीं हो पाई। कुछ सेव नहीं हुआ। नेटवर्क जाँचकर फिर कोशिश करें।');
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
function voiceMicrophoneConstraints() {
  const audio = {
    channelCount: { ideal: 1 },
    echoCancellation: { ideal: true },
    noiseSuppression: { ideal: true },
    autoGainControl: { ideal: true },
  };
  const supported = navigator.mediaDevices?.getSupportedConstraints?.() || {};
  if (supported.voiceIsolation) audio.voiceIsolation = { ideal: true };
  return { audio };
}
function createEnhancedAudioPath(stream, context) {
  const source = context.createMediaStreamSource(stream);
  const highPass = context.createBiquadFilter();
  highPass.type = 'highpass';
  highPass.frequency.value = 90;
  highPass.Q.value = 0.707;
  const lowPass = context.createBiquadFilter();
  lowPass.type = 'lowpass';
  lowPass.frequency.value = 7600;
  lowPass.Q.value = 0.707;
  const inputGain = context.createGain();
  inputGain.gain.value = 1.15;
  const compressor = context.createDynamicsCompressor();
  compressor.threshold.value = -25;
  compressor.knee.value = 18;
  compressor.ratio.value = 2.5;
  compressor.attack.value = 0.012;
  compressor.release.value = 0.22;
  const analyserNode = context.createAnalyser();
  analyserNode.fftSize = 512;
  analyserNode.smoothingTimeConstant = 0.55;
  const destination = context.createMediaStreamDestination();
  source.connect(highPass);
  highPass.connect(lowPass);
  lowPass.connect(inputGain);
  inputGain.connect(compressor);
  compressor.connect(analyserNode);
  analyserNode.connect(destination);
  return { stream: destination.stream, analyser: analyserNode };
}
async function attachWaveAnalyser() {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return micStream;
  try {
    audioContext = new AudioContext({ latencyHint: 'interactive' });
    if (audioContext.state === 'suspended') await audioContext.resume();
    const enhanced = createEnhancedAudioPath(micStream, audioContext);
    analyser = enhanced.analyser;
    return enhanced.stream;
  } catch {
    if (audioContext) { await audioContext.close().catch(() => {}); audioContext = null; }
    analyser = null;
    return micStream;
  }
}
async function startGnaniRecording() {
  if (!window.MediaRecorder) throw new Error('This browser cannot record audio for Gnani.');
  try {
    const stream = await navigator.mediaDevices.getUserMedia(voiceMicrophoneConstraints());
    micStream = stream;
    const enhancedStream = await attachWaveAnalyser();
    const mimeType = typeof MediaRecorder.isTypeSupported === 'function'
      ? ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find((type) => MediaRecorder.isTypeSupported(type))
      : '';
    mediaRecorder = mimeType ? new MediaRecorder(enhancedStream, { mimeType }) : new MediaRecorder(enhancedStream);
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
    if (session.parser_notice) toast(session.parser_notice);
    if (session.spoken_response) {
      $('#voice-caption').innerHTML = `<span class="voice-dot"></span><span>${esc(session.spoken_response)}</span>`;
      const handsFreeFlowSpeaksResponse = isHandsFreeVoiceSession()
        && ['QUERY_TODAY_SUMMARY', 'QUERY_CUSTOMER_BALANCE', 'DISAMBIGUATION', 'UNKNOWN'].includes(session.intent);
      if (session.intent !== 'TRANSACTION' && !handsFreeFlowSpeaksResponse) speakText(session.spoken_response).catch(() => {});
    }
    if (session.intent === 'QUERY_TODAY_SUMMARY' || session.intent === 'QUERY_CUSTOMER_BALANCE' || session.intent === 'DISAMBIGUATION') {
      $('#voice-title').textContent = session.needs_clarification ? 'Please clarify' : 'Here is the answer';
      $('#voice-subtitle').textContent = session.spoken_response || 'I could not resolve that request.';
      if (!session.spoken_response) toast('I could not resolve that request. Try again.');
      else if (isHandsFreeVoiceSession()) finishHandsFreeAfterSpeech(session.spoken_response);
      return;
    }
    if (session.intent === 'UNKNOWN') {
      $('#voice-title').textContent = 'I could not understand';
      $('#voice-subtitle').textContent = session.spoken_response || 'Please say the customer name, amount, and udhaar or jama.';
      if (isHandsFreeVoiceSession()) {
        if (handsFreeTranscriptionRetries < 1) {
          handsFreeTranscriptionRetries += 1;
          retryHandsFreeCapture(session.spoken_response || 'माफ़ कीजिए, समझ नहीं आया। ग्राहक का नाम, रकम और उधार या जमा बोलिए।');
        } else failHandsFreeVoiceSession('माफ़ कीजिए, बात साफ़ समझ नहीं आई। कुछ सेव नहीं हुआ। बाद में फिर कोशिश करें।');
      }
      return;
    }
    handsFreeTranscriptionRetries = 0;
    $('#voice-title').textContent = 'Got it. Checking details';
    $('#voice-subtitle').textContent = 'I’ll clarify the customer if needed, then save the entry.';
    $('#voice-caption').innerHTML = `<span class="voice-dot"></span><span>${esc(session.transcript)}</span>`;
    const firstParsedEntry = session.entries?.length > 1
      ? { ...session.entries[0], batchEntries: session.entries }
      : session.entries?.[0];
    if (session.entries?.length > 1 && session.entries.some((item) => !item.customer_id)) {
      $('#voice-title').textContent = 'Please clarify customer names';
      $('#voice-subtitle').textContent = session.spoken_response || 'One or more customer names need clarification before saving.';
      toast('These entries need customer clarification before saving. Nothing was added to the ledger.');
      api(`/api/v1/voice/sessions/${session.id}/cancel`, { method: 'POST' }).catch(() => {});
      if (isHandsFreeVoiceSession()) failHandsFreeVoiceSession('एक से ज़्यादा ग्राहक मिले। सुरक्षा के लिए कुछ सेव नहीं किया। एक बार में एक ग्राहक की एंट्री बोलें।');
      return;
    }
    prepareVoiceEntry(session.transcript, session.id, firstParsedEntry);
  } catch (error) {
    setVoiceReady('Voice transcription did not finish. Try again or use New entry.');
    toast(error.message || 'Gnani could not transcribe this recording.');
    if (isHandsFreeVoiceSession()) {
      if (handsFreeTranscriptionRetries < 1) {
        handsFreeTranscriptionRetries += 1;
        retryHandsFreeCapture('आवाज़ समझने में दिक्कत हुई। एक बार फिर बोलिए।');
      } else failHandsFreeVoiceSession('आवाज़ समझने में दिक्कत हुई। कुछ सेव नहीं हुआ। नेटवर्क ठीक होने पर फिर कोशिश करें।');
    }
  }
}
async function startListening() {
  if (workspaceLoadError) { toast('Load your complete khata history before recording a new entry.'); return; }
  if (startingVoice || listening) return;
  if (!window.isSecureContext) { toast('Voice input needs HTTPS or localhost.'); return; }
  if (!navigator.mediaDevices?.getUserMedia) { toast('Microphone input is unavailable here. Use New entry instead.'); return; }
  startingVoice = true;
  const keepGestureButtonActive = voicePointerHoldActive;
  if (!keepGestureButtonActive) $('#voice-button').disabled = true;
  try {
    await requestVoiceCapabilities();
    if (!gnaniSttEnabled || !gnaniTtsEnabled) {
      toast(gnaniLastError || 'Gnani voice input and output must be enabled on the backend.');
      setVoiceReady('Gnani voice service is unavailable. Nothing was recorded.');
      return;
    }
    await startGnaniRecording();
  } catch (error) {
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
  if (workspaceLoadError) {
    if (isHandsFreeVoiceSession()) failHandsFreeVoiceSession('आपका खाता पूरा लोड नहीं हुआ। सुरक्षा के लिए अभी कोई एंट्री नहीं की। ऐप खोलकर Retry दबाएँ।');
    else toast('Load your khata history before using voice entry.');
    return;
  }
  if (window.VoiceKhataNative?.hasPendingAudio?.()) {
    window.voiceKhataNativeAudioReady();
    return;
  }
  // The native Android companion records immediately with AudioRecord. It
  // hands the WAV back here so the normal Gnani voice flow remains
  // the single path that can create a ledger transaction.
  if (window.VoiceKhataNative?.startCapture?.()) return;
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
window.voiceKhataNativeAudioReady = () => {
  try {
    const encoded = window.VoiceKhataNative?.consumeAudioBase64?.();
    if (!encoded) throw new Error('The recording is no longer available. Please record again.');
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    void transcribeGnaniAudio(new Blob([bytes], { type: 'audio/wav' }));
  } catch (error) {
    setVoiceReady('The recording could not be opened. Please try again.');
    toast(error.message || 'The recording could not be opened.');
  }
};
window.voiceKhataNativeReplyAudioReady = async () => {
  const handlers = nativeVoiceReplyHandlers;
  if (!handlers || !awaitingVoiceReply || pendingVoiceEntry !== handlers.entry) {
    try { window.VoiceKhataNative?.consumeAudioBase64?.(); } catch {}
    return;
  }
  try {
    const encoded = window.VoiceKhataNative?.consumeAudioBase64?.();
    if (!encoded) throw new Error('I did not receive your answer. Please say it again.');
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const form = new FormData();
    form.append('audio', new Blob([bytes], { type: 'audio/wav' }), 'voice-answer.wav');
    form.append('language_code', voiceLanguage);
    $('#voice-caption').innerHTML = '<span class="voice-dot"></span><span>Checking your answer…</span>';
    updateHandsFreeStatus('आपका जवाब समझ रहा हूँ…');
    const result = await api('/api/v1/voice/transcribe', { method: 'POST', body: form });
    if (nativeVoiceReplyHandlers !== handlers || !awaitingVoiceReply || pendingVoiceEntry !== handlers.entry) return;
    nativeVoiceReplyHandlers = null;
    stopVoiceReply();
    handlers.onReply(result.transcript);
  } catch (error) {
    if (nativeVoiceReplyHandlers !== handlers) return;
    nativeVoiceReplyHandlers = null;
    handlers.onFallback(error.message || 'Could not understand your answer. Please try again.');
  }
};
window.voiceKhataNativeReplyError = (message) => {
  const handlers = nativeVoiceReplyHandlers;
  if (!handlers) return;
  nativeVoiceReplyHandlers = null;
  handlers.onFallback(message || 'I did not hear your answer. Please try again.');
};
window.voiceKhataNativeError = (message) => {
  if (isHandsFreeVoiceSession()) failHandsFreeVoiceSession('आवाज़ समझने में दिक्कत हुई। कुछ सेव नहीं हुआ। दोबारा assistant button दबाकर कोशिश करें।');
  else toast(message || 'Voice recording could not be processed.');
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
    if (entry && voiceConversation) fallbackConversationToForm(entry, 'Voice questions stopped.');
    else if (entry) {
      pendingVoiceEntry = null;
      cancelVoiceSession(entry.sessionId);
      setVoiceReady('Nothing was saved. Start voice entry again when ready.');
    }
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
    void requestVoiceCapabilities();
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
