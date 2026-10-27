# DonGranjero 🌻

Panel para decidir qué recurso conviene explotar en tu granja de **Sunflower Land** para llegar a una meta mensual en dólares (por defecto US$ 30, editable).

## Qué hace

- Lee tu granja (por defecto la #441) desde la Community API: parcelas, parches, árboles, minas, animales, boosts colocados y equipados, estación.
- Trae los precios piso del Marketplace (sfl.world) y el precio de FLOWER en USD (DexScreener, red Base).
- Calcula el FLOWER neto por día de cada recurso, descontando comisión del Marketplace e insumos (semillas, herramientas, alimento) valuados a precio de mercado.
- Optimiza qué plantar en cada sesión con programación dinámica, según cuántas veces por día entrás y en qué horario.
- Compara tu proyección con la meta, te dice qué vender, qué no conviene vender y qué falta.
- Evalúa boosts que estés pensando comprar: aporte mensual y días de repago, contra tu presupuesto de reinversión.

## Estructura

```
public/            sitio estático (HTML, CSS, JS sin frameworks)
  js/data.js       datos del juego editables (cultivos, tiempos, boosts)
  js/engine.js     motor de cálculo
  js/app.js        interfaz
functions/api/     Pages Functions
  farm/[id].js     GET /api/farm/:id   (D1 → caché → API, con respaldo ante 429)
  market.js        GET /api/market     (precios, FLOWER/USD, dólar cripto)
  history.js       GET /api/history    (historial resumido desde D1)
shared/sfl.js      código compartido entre la web y el Worker
worker/            Worker programado (cron + D1 + Telegram), se despliega aparte
public/js/insights.js  entregas, inventario, calendario, bounties e historial
wrangler.toml
```

## Deploy en Cloudflare Pages

1. Subí el repo a GitHub.
2. Cloudflare → Workers & Pages → Create → Pages → Connect to Git → elegí el repo.
3. Build command: *(vacío)* · Build output directory: `public`.
4. Deploy. La carpeta `functions/` se publica sola como API.

Variables opcionales en Settings → Environment variables:

| Variable | Para qué |
|---|---|
| `SFL_API_KEY` | Si la Community API pide key (se envía como `x-api-key`). Cargala como secreto. |
| `SFL_API_BASE` / `SFL_FARM_PATH` | Cambiar el endpoint de la granja si se mueve. |
| `PRICES_URL` | Otra fuente de precios P2P. |
| `FLOWER_TOKEN` | Dirección del token FLOWER para el precio en USD. |

## Historial y avisos por Telegram (Worker programado)

Pages no puede ejecutar tareas programadas, así que hay un Worker aparte en `worker/` que corre cada 5 minutos. Guarda una foto diaria de la granja, los precios cada hora y tus ventas cobradas en una base D1. También manda por Telegram lo que está listo para cosechar. La web lee de esa misma base, así que también deja de depender del límite de consultas de la API.

### 1. Crear la base D1

```bash
npx wrangler d1 create dongranjero
```

Copiá el `database_id` que devuelve y pegalo en `worker/wrangler.toml`. Después creá las tablas:

```bash
npx wrangler d1 execute dongranjero --remote --file=worker/schema.sql
```

### 2. Conectar la base a la web

Pegá el mismo `database_id` en el `wrangler.toml` de la raíz (sección `[[d1_databases]]`) y hacé commit. Como el repo tiene ese archivo, Cloudflare toma los bindings de ahí y no del panel. Los secretos como `SFL_API_KEY` siguen cargados en el panel y no se tocan.

### 3. Bot de Telegram

1. En Telegram, hablale a **@BotFather**, mandá `/newbot` y seguí los pasos. Te da un token.
2. Mandale cualquier mensaje a tu bot nuevo.
3. Para saber tu chat id, hablale a **@userinfobot**: te responde con tu número de ID.

### 4. Desplegar el Worker

```bash
cd worker
npx wrangler secret put SFL_API_KEY
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put RUN_KEY     # cualquier clave, para pruebas manuales
npx wrangler deploy
```

En `worker/wrangler.toml` podés cambiar el ID de granja, cada cuánto consulta, el horario sin avisos (`QUIET_FROM` / `QUIET_TO`) y el link a tu web (`SITE_URL`).

### 5. Probar

- `https://dongranjero-cron.TU-USUARIO.workers.dev/test?key=TU_RUN_KEY` manda un mensaje de prueba a Telegram.
- `https://dongranjero-cron.TU-USUARIO.workers.dev/run?key=TU_RUN_KEY` fuerza una corrida completa.
- En la web, Ajustes → "Historial y avisos por Telegram" muestra cuándo corrió por última vez.

El historial necesita al menos dos días de fotos para mostrar el ingreso real y el ritmo de cosecha.

## Sincronización, alertas y comandos del bot

### 1. Tabla de ajustes

En la consola de D1 ejecutá:

```sql
CREATE TABLE IF NOT EXISTS settings (farm_id INTEGER PRIMARY KEY, updated_at TEXT NOT NULL, data TEXT NOT NULL);
```

### 2. Clave de sincronización

En Cloudflare → proyecto de Pages `elgranjero` → Configuración → Variables y secretos, agregá un **Secreto** `SYNC_KEY` con una clave larga que inventes. Redeployá. Después cargá esa misma clave en la web, en Ajustes → Sincronización.

### 3. Comandos del bot

Abrí una vez `https://dongranjero-cron.TU-SUBDOMINIO.workers.dev/telegram/setup?key=TU_RUN_KEY`. Desde ahí el bot responde `/hoy`, `/vender`, `/isla`, `/estado` y `/semana`, solo a tu chat.

### 4. Instalar en el celular

Abrí la web en Chrome (Android) → menú → "Instalar aplicación", o en Safari (iPhone) → Compartir → "Agregar a inicio".

## Desarrollo local

```bash
npx wrangler pages dev public
```

Abrí http://localhost:8788. Abrir `index.html` directo no sirve porque `/api` no existe sin Wrangler.

## Antes de confiar en los números

- **Verificá los endpoints.** La Community API y la API de sfl.world pueden cambiar de ruta o de formato. Si `/api/farm/441` o `/api/market` fallan, revisá la documentación y ajustá las variables. Mientras tanto podés pegar el JSON de la granja y cargar precios a mano desde Ajustes.
- **`public/js/data.js` es aproximado.** Tiempos, precios de semillas, herramientas, cultivos por estación y efectos de boosts se rebalancean seguido. Contrastalos con el repo oficial (`src/features/game/types/`).
- **Boosts.** Se detectan automáticamente los de la lista de `data.js`. Los items de tu granja que no estén en la lista aparecen en la pestaña Granja para que los cargues como boost manual si afectan la producción.
- **Liquidez.** El precio piso no garantiza que puedas vender todo a ese precio. Cargá en Ajustes cuántas unidades por día creés que absorbe el mercado y la app te avisa si te pasás.
- **Coins.** Por defecto las semillas y herramientas se muestran como coins por día y no se descuentan del FLOWER. Si querés, asigná un valor al coin en Ajustes.

Estimaciones con datos públicos y supuestos editables. No es asesoramiento financiero.
