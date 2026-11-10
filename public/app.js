const restaurantId = 'demo';
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
  $('active-status').classList.remove('hidden');
  $('token-heading').textContent = `Token ${token.id.slice(0, 8)}`;
  $('token-status').textContent = token.status;
  $('position').textContent = data.position ?? '—';
  $('progress-bar').style.width = data.position ? `${Math.max(12, Math.min(92, 100 / data.position))}%` : '12%';
  $('way-button').disabled = token.status !== 'WAITING';
  $('check-in-button').disabled = !['WAITING', 'ON_MY_WAY'].includes(token.status);
}
async function refresh() {
  if (!tokenId) return;
  try { showToken(await request(`/restaurants/${restaurantId}/tokens/${tokenId}`)); } catch (error) { $('status-error').textContent = error.message; }
}
async function loadTables() {
  const tableIds = ['table-2', 'table-4', 'table-6'];
  $('tables').innerHTML = tableIds.map((id) => `<div class="table"><strong>${id.replace('-', ' ').toUpperCase()}</strong><small>Staff action</small><button data-table="${id}">Mark free</button></div>`).join('');
  document.querySelectorAll('[data-table]').forEach((button) => button.addEventListener('click', async () => {
    button.disabled = true;
    try { await request(`/restaurants/${restaurantId}/tables/${button.dataset.table}/free`, { method: 'POST' }); button.textContent = 'Freed'; }
    catch (error) { button.disabled = false; $('status-error').textContent = error.message; }
  }));
}
$('join-form').addEventListener('submit', async (event) => {
  event.preventDefault(); $('join-error').textContent = '';
  try {
    const data = await request(`/restaurants/${restaurantId}/tokens`, { method: 'POST', body: JSON.stringify({ phone: $('phone').value, partySize: Number($('party-size').value) }) });
    tokenId = data.token.id; localStorage.setItem('lowqueue-token', tokenId); showToken(data);
  } catch (error) { $('join-error').textContent = error.message; }
});
$('way-button').addEventListener('click', async () => { try { await request(`/restaurants/${restaurantId}/tokens/${tokenId}/on-my-way`, { method: 'POST' }); await refresh(); } catch (error) { $('status-error').textContent = error.message; } });
$('check-in-button').addEventListener('click', async () => { try { await request(`/restaurants/${restaurantId}/tokens/${tokenId}/check-in`, { method: 'POST' }); await refresh(); } catch (error) { $('status-error').textContent = error.message; } });
$('cancel-button').addEventListener('click', async () => { try { await request(`/restaurants/${restaurantId}/tokens/${tokenId}`, { method: 'DELETE' }); localStorage.removeItem('lowqueue-token'); tokenId = null; location.reload(); } catch (error) { $('status-error').textContent = error.message; } });
loadTables(); refresh(); setInterval(refresh, 5000);
