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
functions/api/     Pages Functions (proxy con caché en el edge)
  farm/[id].js     GET /api/farm/:id
  market.js        GET /api/market
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
