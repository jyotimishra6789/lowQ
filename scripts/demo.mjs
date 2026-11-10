const baseUrl = process.env.LOWQUEUE_URL || 'http://127.0.0.1:3000';
const restaurantId = process.env.LOWQUEUE_RESTAURANT || 'demo';
const phone = `+91 90000 ${String(Date.now()).slice(-5)}`;
const customerUrl = `${baseUrl}/?restaurant=${encodeURIComponent(restaurantId)}`;
const staffUrl = `${customerUrl}&view=staff`;
let staffCookie;

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(staffCookie ? { cookie: staffCookie } : {}),
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${path}: ${data.error || response.statusText}`);
  return data;
}

async function main() {
  console.log(`Customer view: ${customerUrl}`);
  console.log(`Restaurant view: ${staffUrl}`);
  await request(`/restaurants/${restaurantId}/summary`);
  if (process.env.STAFF_USERNAME && process.env.STAFF_PASSWORD) {
    const login = await fetch(`${baseUrl}/auth/staff/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: process.env.STAFF_USERNAME,
        password: process.env.STAFF_PASSWORD
      })
    });
    if (!login.ok && login.status !== 503) throw new Error(`Staff login failed with status ${login.status}`);
    if (login.status === 503) {
      console.warn('Staff credentials are not configured; continuing in local open mode');
    }
    if (login.status === 503) {
      staffCookie = undefined;
    } else {
      const cookies = typeof login.headers.getSetCookie === 'function'
        ? login.headers.getSetCookie()
        : [login.headers.get('set-cookie')].filter(Boolean);
      staffCookie = cookies[0]?.split(';', 1)[0];
    }
  }

  const created = await request(`/restaurants/${restaurantId}/tokens`, {
    method: 'POST',
    headers: { 'idempotency-key': `demo-${Date.now()}` },
    body: JSON.stringify({ phone, partySize: 2, source: 'remote' })
  });
  const tokenId = created.token.id;
  console.log(`Created demo token ${tokenId.slice(0, 8)} for ${phone}`);
  await wait(1500);

  await request(`/restaurants/${restaurantId}/tokens/${tokenId}/on-my-way`, { method: 'POST' });
  console.log('Guest is on the way');
  await wait(1500);

  await request(`/restaurants/${restaurantId}/tokens/${tokenId}/check-in`, { method: 'POST' });
  console.log('Guest checked in');
  await wait(1500);

  const freed = await request(`/restaurants/${restaurantId}/tables/table-2/free`, { method: 'POST' });
  console.log(`Table assignment: ${freed.effects.map((effect) => effect.type).join(', ')}`);
  await wait(1800);

  await request(`/restaurants/${restaurantId}/tokens/${tokenId}/ready`, { method: 'POST' });
  console.log('Restaurant called the guest');
  await wait(1800);

  await request(`/restaurants/${restaurantId}/tokens/${tokenId}/seated`, { method: 'POST' });
  console.log('Guest seated; automated demo complete');
}

main().catch((error) => {
  console.error(`Demo failed: ${error.message}`);
  process.exitCode = 1;
});
