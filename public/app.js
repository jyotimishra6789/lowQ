const restaurantId = new URLSearchParams(location.search).get('restaurant') || 'demo';
let tokenId = localStorage.getItem('lowqueue-token');
const $ = (id) => document.getElementById(id);
const request = async (url, options = {}) => {
  const response = await fetch(url, { headers: { 'content-type': 'application/json', ...(options.headers || {}) }, ...options });
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
async function refreshSummary() {
  try {
    const summary = await request(`/restaurants/${restaurantId}/summary`);
    $('waiting-count').textContent = summary.waiting;
    $('wait-estimate').textContent = `${summary.averageWaitMinutes}m`;
    $('tables-available').textContent = summary.tables.filter((table) => table.status === 'FREE').length;
    const tableStatus = new Map(summary.tables.map((table) => [table.id, table.status]));
    document.querySelectorAll('[data-table]').forEach((table) => table.classList.toggle('occupied', tableStatus.get(table.dataset.table) === 'OCCUPIED'));
  } catch (error) { $('status-error').textContent = error.message; }
}

async function refresh() {
  if (!tokenId) return;
  try { showToken(await request(`/restaurants/${restaurantId}/tokens/${tokenId}`)); }
  catch (error) { $('status-error').textContent = error.message; }
}

function openGuestPanel() { $('guest-panel').classList.add('visible'); $('phone').focus(); }
$('add-top').addEventListener('click', openGuestPanel);
$('open-staff').addEventListener('click', () => document.querySelector('.waitlist-card').scrollIntoView({ behavior: 'smooth' }));
$('close-guest').addEventListener('click', () => $('guest-panel').classList.remove('visible'));

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
