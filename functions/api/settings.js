// GET/POST /api/settings?farm=441
// Guarda los ajustes de la web en D1 para sincronizar dispositivos y que el Worker los use
// (meta, comisiones, rendimientos medidos, retiros, alertas).
// Protegido con la clave SYNC_KEY (secreto de Pages) enviada en el header x-sync-key.
export async function onRequest({ request, env }) {
  if (!env.DB) return json({ error: "La base D1 no está conectada." }, 501);
  if (!env.SYNC_KEY) return json({ error: "Falta configurar el secreto SYNC_KEY en Cloudflare Pages." }, 501);
  if (request.headers.get("x-sync-key") !== env.SYNC_KEY) return json({ error: "Clave de sincronización incorrecta." }, 401);

  const url = new URL(request.url);
  const id = Number(url.searchParams.get("farm")) || 441;

  if (request.method === "GET") {
    const row = await env.DB.prepare("SELECT updated_at, data FROM settings WHERE farm_id = ?").bind(id).first();
    return json(row ? { updatedAt: row.updated_at, data: JSON.parse(row.data) } : { updatedAt: null, data: null });
  }

  if (request.method === "POST") {
    const body = await request.json().catch(() => null);
    if (!body || typeof body.data !== "object") return json({ error: "Datos inválidos." }, 400);
    const text = JSON.stringify(body.data);
    if (text.length > 200000) return json({ error: "Los ajustes son demasiado grandes." }, 413);
    const updatedAt = body.updatedAt || new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO settings (farm_id, updated_at, data) VALUES (?, ?, ?) ON CONFLICT(farm_id) DO UPDATE SET updated_at = excluded.updated_at, data = excluded.data"
    )
      .bind(id, updatedAt, text)
      .run();
    return json({ ok: true, updatedAt });
  }

  return json({ error: "Método no permitido." }, 405);
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
