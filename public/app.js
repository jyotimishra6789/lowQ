const restaurantId = new URLSearchParams(location.search).get('restaurant') || 'demo';
const view = new URLSearchParams(location.search).get('view') || 'guest';
let staffAuthenticated = false;
let tokenId = localStorage.getItem('lowqueue-token');
const $ = (id) => document.getElementById(id);
const request = async (url, options = {}) => {
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined && !headers['content-type']) headers['content-type'] = 'application/json';
  const response = await fetch(url, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
};

function showToken(data) {
  const token = data.token;
  $('empty-status').classList.add('hidden');
  $('active-status').classList.add('hidden');
  $('guest-status').classList.remove('hidden');
  $('token-heading').textContent = `Token ${token.id.slice(0, 8)}`;
  $('token-status').textContent = token.status.replaceAll('_', ' ');
  $('party-label').textContent = `Party of ${token.partySize}`;
  $('position').textContent = data.position ?? '—';
  $('waiting-count').textContent = data.position ?? 1;
  $('wait-estimate').textContent = `${Math.max(0, (data.position ?? 1) * 5)}m`;
  $('way-button').disabled = token.status !== 'WAITING';
  $('check-in-button').disabled = !['WAITING', 'ON_MY_WAY'].includes(token.status);
  $('guest-list').innerHTML = `<tr>
    <td>${data.position ?? '—'}</td><td>Current guest</td><td>${token.partySize}</td>
    <td><span class="status-chip ${token.status === 'WAITING' ? 'waiting' : ''}">${token.status.replaceAll('_', ' ')}</span></td>
    <td>${data.position ?? '—'}</td><td><button class="row-action" data-action="check">Manage</button></td>
  </tr>`;
  $('guest-list').querySelector('[data-action="check"]').addEventListener('click', () => $('guest-panel').classList.add('visible'));
}
async function speak(text) {
  const response = await fetch('/voice/text-to-speech', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, voice: 'Nalini', language: 'en-IN' })
  });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'Text-to-speech failed');
  const audio = new Audio(URL.createObjectURL(await response.blob()));
  await audio.play();
}
async function transcribeVoice() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    throw new Error('Voice recording is not supported by this browser');
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const recorder = new MediaRecorder(stream);
  const chunks = [];
  recorder.ondataavailable = (event) => chunks.push(event.data);
  const recording = new Promise((resolve) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }));
  });
  recorder.start();
  $('voice-label').textContent = 'Listening… click again to stop';
  $('voice-record').textContent = '⏹ Stop recording';
  return { recorder, stream, recording };
}
let activeRecording;
function setupView() {
  const staffMode = view === 'staff';
  $('add-top').classList.toggle('hidden', staffMode);
  $('open-staff').classList.toggle('hidden', staffMode);
  $('guest-panel').classList.toggle('hidden', staffMode);
  $('staff-login').classList.toggle('hidden', !staffMode);
}
function setStaffAuthenticated(authenticated) {
  staffAuthenticated = authenticated;
  $('staff-login').classList.toggle('hidden', authenticated || view !== 'staff');
  $('staff-tools').classList.toggle('hidden', !authenticated);
  $('staff-announce').classList.toggle('hidden', !authenticated);
}
async function refreshSummary() {
  try {
    const summary = await request(`/restaurants/${restaurantId}/summary`);
    $('waiting-count').textContent = summary.waiting;
    $('wait-estimate').textContent = `${summary.averageWaitMinutes}m`;
    $('tables-available').textContent = summary.tables.filter((table) => table.status === 'FREE').length;
    const tableStatus = new Map(summary.tables.map((table) => [table.id, table.status]));
    document.querySelectorAll('[data-table]').forEach((table) => table.classList.toggle('occupied', tableStatus.get(table.dataset.table) === 'OCCUPIED'));
    if (staffAuthenticated) {
      $('table-actions').innerHTML = summary.tables.map((table) =>
        `<button class="row-action" data-free-table="${table.id}">${table.id}: ${table.status === 'FREE' ? 'Free' : 'Mark free'}</button>`
      ).join('');
      $('table-actions').querySelectorAll('[data-free-table]').forEach((button) => button.addEventListener('click', async () => {
        try {
          await request(`/restaurants/${restaurantId}/tables/${button.dataset.freeTable}/free`, { method: 'POST' });
          await refreshSummary();
        } catch (error) { $('status-error').textContent = error.message; }
      }));
    }
  } catch (error) { $('status-error').textContent = error.message; }
}

async function refresh() {
  if (!tokenId || view === 'staff') return;
  try { showToken(await request(`/restaurants/${restaurantId}/tokens/${tokenId}`)); }
  catch (error) { $('status-error').textContent = error.message; }
}

function openGuestPanel() { $('guest-panel').classList.add('visible'); $('phone').focus(); }
$('add-top').addEventListener('click', openGuestPanel);
$('open-staff').addEventListener('click', () => document.querySelector('.waitlist-card').scrollIntoView({ behavior: 'smooth' }));
$('close-guest').addEventListener('click', () => $('guest-panel').classList.remove('visible'));
$('voice-record').addEventListener('click', async () => {
  try {
    if (activeRecording) {
      activeRecording.recorder.stop();
      activeRecording.stream.getTracks().forEach((track) => track.stop());
      const blob = await activeRecording.recording;
      activeRecording = undefined;
      $('voice-record').textContent = '🎙 Speak details';
      $('voice-label').textContent = 'Transcribing…';
      const form = new FormData();
      form.append('audio_file', blob, 'voice.webm');
      const response = await fetch('/voice/speech-to-text?languageCode=en-IN', { method: 'POST', body: form });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Speech-to-text failed');
      const transcript = String(result.text || result.transcript || '');
      const digits = transcript.replace(/\D/g, '');
      if (digits.length >= 10) $('phone').value = digits.slice(-10);
      const party = transcript.match(/\b(?:party|people|persons?)\s*(?:of|size)?\s*(\d+)\b/i);
      if (party) $('party-size').value = String(Math.min(6, Math.max(1, Number(party[1]))));
      $('voice-label').textContent = transcript || 'No speech detected';
    } else {
      activeRecording = await transcribeVoice();
    }
  } catch (error) {
    activeRecording = undefined;
    $('voice-record').textContent = '🎙 Speak details';
    $('voice-label').textContent = error.message;
  }
});
$('voice-status').addEventListener('click', async () => {
  try {
    if (!tokenId) throw new Error('Join the waitlist first');
    const data = await request(`/restaurants/${restaurantId}/tokens/${tokenId}`);
    await speak(`Your queue status is ${data.token.status.replaceAll('_', ' ').toLowerCase()}. Your position is ${data.position ?? 'not available'}.`);
  } catch (error) { $('status-error').textContent = error.message; }
});
$('staff-announce').addEventListener('click', async () => {
  try {
    const summary = await request(`/restaurants/${restaurantId}/summary`);
    await speak(`${summary.waiting} parties are waiting. ${summary.tables.filter((table) => table.status === 'FREE').length} tables are available.`);
  } catch (error) { $('status-error').textContent = error.message; }
});
$('staff-login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await request('/auth/staff/login', {
      method: 'POST',
      body: JSON.stringify({ username: $('staff-username').value, password: $('staff-password').value })
    });
    setStaffAuthenticated(true);
    await refreshSummary();
  } catch (error) { $('staff-login-error').textContent = error.message; }
});
$('staff-logout').addEventListener('click', async () => {
  await request('/auth/staff/logout', { method: 'POST' });
  setStaffAuthenticated(false);
});

setupView();
if (view === 'staff') {
  request('/auth/staff/me').then((data) => setStaffAuthenticated(data.authenticated)).catch(() => setStaffAuthenticated(false));
}

$('join-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('join-error').textContent = '';
  try {
    const data = await request(`/restaurants/${restaurantId}/tokens`, {
      method: 'POST',
      body: JSON.stringify({ phone: $('phone').value, partySize: Number($('party-size').value), source: 'remote' })
    });
    tokenId = data.token.id;
    localStorage.setItem('lowqueue-token', tokenId);
    $('guest-panel').classList.remove('visible');
    showToken(data);
  } catch (error) { $('join-error').textContent = error.message; }
});

$('way-button').addEventListener('click', async () => {
  try { await request(`/restaurants/${restaurantId}/tokens/${tokenId}/on-my-way`, { method: 'POST' }); await refresh(); }
  catch (error) { $('status-error').textContent = error.message; }
});
$('check-in-button').addEventListener('click', async () => {
  try { await request(`/restaurants/${restaurantId}/tokens/${tokenId}/check-in`, { method: 'POST' }); await refresh(); }
  catch (error) { $('status-error').textContent = error.message; }
});
$('cancel-button').addEventListener('click', async () => {
  try {
    await request(`/restaurants/${restaurantId}/tokens/${tokenId}`, { method: 'DELETE' });
    localStorage.removeItem('lowqueue-token'); tokenId = null; location.reload();
  } catch (error) { $('status-error').textContent = error.message; }
});

refresh();
refreshSummary();
setInterval(() => { refresh(); refreshSummary(); }, 5000);
const events = new EventSource(`/restaurants/${restaurantId}/events`);
events.addEventListener('queue', () => { refresh(); refreshSummary(); });
