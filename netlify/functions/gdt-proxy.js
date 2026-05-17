export default async (req) => {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };

  const json = (data, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json', ...CORS }
    });

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid request body' }, 400);
  }

  const { path, params = {}, token, base } = body;

  if (!path) return json({ error: 'Missing path' }, 400);
  if (!token) return json({ error: 'Missing token' }, 400);
  if (!base) return json({ error: 'Missing base URL' }, 400);

  const qs = Object.keys(params).length
    ? '?' + new URLSearchParams(params).toString()
    : '';

  const url = base.replace(/\/$/, '') + path + qs;
  console.log(`gdt-proxy → GET ${url}`);

  let gdtResp;
  try {
    gdtResp = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': token.startsWith('Bearer ') ? token : `Bearer ${token}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      }
    });
  } catch (fetchErr) {
    console.error('gdt-proxy fetch error:', fetchErr.message);
    return json({ error: `Network error reaching GDT: ${fetchErr.message}` }, 502);
  }

  const responseText = await gdtResp.text();
  console.log(`gdt-proxy ← HTTP ${gdtResp.status} (${responseText.length} bytes)`);

  if (!responseText) {
    return json({ error: `GDT returned empty body (HTTP ${gdtResp.status})`, status: gdtResp.status }, 502);
  }

  let responseData;
  try {
    responseData = JSON.parse(responseText);
  } catch {
    return json({
      error: `GDT returned non-JSON (HTTP ${gdtResp.status})`,
      preview: responseText.substring(0, 200),
      status: gdtResp.status
    }, 502);
  }

  if (!gdtResp.ok) {
    return json({
      error: responseData.message || responseData.error || `GDT HTTP ${gdtResp.status}`,
      gdt_status: gdtResp.status,
      gdt_response: responseData
    }, gdtResp.status);
  }

  return json(responseData);
};
