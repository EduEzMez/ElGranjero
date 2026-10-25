// Datos base del juego.
// IMPORTANTE: Sunflower Land cambia seguido (temporadas, rebalanceos de boosts).
// Estos valores son aproximados y sirven de punto de partida: verificalos contra
// el repo oficial (src/features/game/types/*.ts) y ajustalos desde la app o acá.

// Cultivos: precio de semilla en coins y tiempo de crecimiento en horas.
export const CROPS = [
  { name: "Sunflower", seed: 0.01, hours: 1 / 60 },
  { name: "Potato", seed: 0.1, hours: 5 / 60 },
  { name: "Rhubarb", seed: 0.15, hours: 10 / 60 },
  { name: "Pumpkin", seed: 0.2, hours: 0.5 },
  { name: "Zucchini", seed: 0.2, hours: 0.5 },
  { name: "Carrot", seed: 0.5, hours: 1 },
  { name: "Yam", seed: 0.5, hours: 1 },
  { name: "Cabbage", seed: 1, hours: 2 },
  { name: "Broccoli", seed: 1, hours: 2 },
  { name: "Soybean", seed: 1.5, hours: 3 },
  { name: "Beetroot", seed: 2, hours: 4 },
  { name: "Pepper", seed: 2, hours: 4 },
  { name: "Cauliflower", seed: 3, hours: 8 },
  { name: "Parsnip", seed: 5, hours: 12 },
  { name: "Eggplant", seed: 6, hours: 16 },
  { name: "Corn", seed: 7, hours: 20 },
  { name: "Onion", seed: 7, hours: 20 },
  { name: "Radish", seed: 7, hours: 24 },
  { name: "Wheat", seed: 5, hours: 24 },
  { name: "Turnip", seed: 5, hours: 24 },
  { name: "Kale", seed: 7, hours: 36 },
  { name: "Artichoke", seed: 7, hours: 36 },
  { name: "Barley", seed: 10, hours: 48 },
];

// Qué cultivos se pueden plantar en cada estación (aproximado).
export const SEASON_CROPS = {
  spring: ["Sunflower", "Potato", "Rhubarb", "Carrot", "Cabbage", "Soybean", "Corn", "Wheat", "Kale", "Barley"],
  summer: ["Sunflower", "Potato", "Zucchini", "Pepper", "Beetroot", "Cauliflower", "Eggplant", "Radish", "Wheat"],
  autumn: ["Potato", "Pumpkin", "Carrot", "Yam", "Broccoli", "Soybean", "Wheat", "Barley", "Artichoke"],
  winter: ["Potato", "Cabbage", "Beetroot", "Cauliflower", "Parsnip", "Onion", "Turnip", "Wheat", "Kale"],
};

export const SEASON_LABEL = { spring: "Primavera", summer: "Verano", autumn: "Otoño", winter: "Invierno" };

// Frutas: semilla en coins, horas entre cosechas y cosechas por semilla (promedio).
export const FRUITS = [
  { name: "Tomato", seed: 5, hours: 2, harvests: 3 },
  { name: "Lemon", seed: 15, hours: 4, harvests: 3 },
  { name: "Blueberry", seed: 30, hours: 6, harvests: 4 },
  { name: "Orange", seed: 50, hours: 8, harvests: 4 },
  { name: "Apple", seed: 70, hours: 12, harvests: 4 },
  { name: "Banana", seed: 70, hours: 12, harvests: 4 },
];

// Nodos de recursos: horas de reaparición y herramienta que consume cada golpe.
export const NODES = [
  { name: "Wood", label: "Madera", countKey: "Wood", hours: 2, tool: { name: "Axe", coins: 20, items: {} } },
  { name: "Stone", label: "Piedra", countKey: "Stone", hours: 4, tool: { name: "Pickaxe", coins: 20, items: { Wood: 3 } } },
  { name: "Iron", label: "Hierro", countKey: "Iron", hours: 8, tool: { name: "Stone Pickaxe", coins: 20, items: { Wood: 3, Stone: 5 } } },
  { name: "Gold", label: "Oro", countKey: "Gold", hours: 24, tool: { name: "Iron Pickaxe", coins: 80, items: { Wood: 3, Iron: 5 } } },
  { name: "Crimstone", label: "Crimstone", countKey: "Crimstone", hours: 24, tool: { name: "Gold Pickaxe", coins: 100, items: { Wood: 3, Gold: 3 } } },
  { name: "Oil", label: "Petróleo", countKey: "Oil", hours: 20, baseYield: 10, tool: { name: "Oil Drill", coins: 100, items: { Wood: 20, Iron: 9, Leather: 4 } } },
];

// Animales: producción por animal por día y alimento por animal por día (editable en la app).
export const ANIMALS = [
// perDay = unidades por animal en cada ciclo; el ciclo real (horas de sueño) se lee de la granja.
  { name: "Egg", label: "Huevos", animal: "gallinas", countKey: "Egg", perDay: 1, feedItem: "Corn", feedQty: 1 },
  { name: "Milk", label: "Leche", animal: "vacas", countKey: "Milk", perDay: 1, feedItem: "Wheat", feedQty: 1 },
  { name: "Wool", label: "Lana", animal: "ovejas", countKey: "Wool", perDay: 1, feedItem: "Wheat", feedQty: 1 },
];

export const LABELS = {
  Sunflower: "Girasol", Potato: "Papa", Rhubarb: "Ruibarbo", Pumpkin: "Calabaza", Zucchini: "Zucchini",
  Carrot: "Zanahoria", Yam: "Ñame", Cabbage: "Repollo", Broccoli: "Brócoli", Soybean: "Soja",
  Beetroot: "Remolacha", Pepper: "Pimiento", Cauliflower: "Coliflor", Parsnip: "Chirivía", Eggplant: "Berenjena",
  Corn: "Maíz", Onion: "Cebolla", Radish: "Rabanito", Wheat: "Trigo", Turnip: "Nabo", Kale: "Kale",
  Artichoke: "Alcaucil", Barley: "Cebada", Tomato: "Tomate", Lemon: "Limón", Blueberry: "Arándano",
  Orange: "Naranja", Apple: "Manzana", Banana: "Banana", Wood: "Madera", Stone: "Piedra", Iron: "Hierro",
  Gold: "Oro", Crimstone: "Crimstone", Oil: "Petróleo", Egg: "Huevos", Milk: "Leche", Wool: "Lana", Leather: "Cuero",
};

export const CATEGORY_LABEL = { crop: "Cultivo", fruit: "Fruta", node: "Minería y madera", animal: "Animal" };

// Boosts conocidos (aproximados). type: collectible (colocado en la granja), wearable (equipado), skill.
// targets: nombre de recurso o grupo ("crops", "fruits").
// yieldPct: +% de rendimiento · yieldAdd: +unidades por cosecha · timePct: % de tiempo (negativo = más rápido)
// group: boosts que no se acumulan entre sí (se toma el mejor).
export const BOOSTS = [
  { name: "Nancy", type: "collectible", targets: ["crops"], timePct: -15, group: "scarecrow" },
  { name: "Scarecrow", type: "collectible", targets: ["crops"], timePct: -15, yieldPct: 20, group: "scarecrow" },
  { name: "Kuebiko", type: "collectible", targets: ["crops"], timePct: -15, yieldPct: 20, group: "scarecrow" },
  { name: "Lunar Calendar", type: "collectible", targets: ["crops"], timePct: -10 },
  { name: "Lab Grown Carrot", type: "collectible", targets: ["Carrot"], yieldAdd: 0.2 },
  { name: "Lab Grown Pumpkin", type: "collectible", targets: ["Pumpkin"], yieldAdd: 0.3 },
  { name: "Lab Grown Radish", type: "collectible", targets: ["Radish"], yieldAdd: 0.4 },
  { name: "Easter Bunny", type: "collectible", targets: ["Carrot"], yieldPct: 20 },
  { name: "Pablo The Bunny", type: "collectible", targets: ["Carrot"], yieldAdd: 0.1 },
  { name: "Mysterious Parsnip", type: "collectible", targets: ["Parsnip"], timePct: -50 },
  { name: "Victoria Sisters", type: "collectible", targets: ["Pumpkin"], yieldPct: 20 },
  { name: "Freya Fox", type: "collectible", targets: ["Pumpkin"], yieldAdd: 0.5 },
  { name: "Cabbage Boy", type: "collectible", targets: ["Cabbage"], yieldAdd: 0.25 },
  { name: "Karkinos", type: "collectible", targets: ["Cabbage"], yieldAdd: 0.1 },
  { name: "Kernaldo", type: "collectible", targets: ["Corn"], timePct: -25 },
  { name: "Squirrel Monkey", type: "collectible", targets: ["Orange"], timePct: -50 },
  { name: "Black Bearry", type: "collectible", targets: ["Blueberry"], yieldAdd: 1 },
  { name: "Lady Bug", type: "collectible", targets: ["Apple"], yieldAdd: 0.25 },
  { name: "Banana Chicken", type: "collectible", targets: ["Banana"], yieldAdd: 0.1 },
  { name: "Woody the Beaver", type: "collectible", targets: ["Wood"], yieldPct: 20 },
  { name: "Apprentice Beaver", type: "collectible", targets: ["Wood"], timePct: -50 },
  { name: "Tiki Totem", type: "collectible", targets: ["Wood"], yieldAdd: 0.1 },
  { name: "Tunnel Mole", type: "collectible", targets: ["Stone"], yieldAdd: 0.25 },
  { name: "Rocky the Mole", type: "collectible", targets: ["Iron"], yieldAdd: 0.25 },
  { name: "Iron Idol", type: "collectible", targets: ["Iron"], yieldAdd: 1 },
  { name: "Nugget", type: "collectible", targets: ["Gold"], yieldAdd: 0.25 },
  { name: "Sunflower Amulet", type: "wearable", targets: ["Sunflower"], yieldPct: 10 },
  { name: "Carrot Amulet", type: "wearable", targets: ["Carrot"], timePct: -20 },
  { name: "Beetroot Amulet", type: "wearable", targets: ["Beetroot"], yieldPct: 20 },
];

export const DEFAULTS = {
  farmId: 441,
  targetUsd: 30,
  budgetUsd: 5,
  sessions: 5,
  firstHour: 8,
  lastHour: 23,
  marketFee: 10, // % que retiene el Marketplace al vender (si marketFeeAuto, se usa el de tus ventas)
  marketFeeAuto: true,
  useObservedTimes: true, // usar los tiempos reales que guarda el juego en cada nodo
  rapidRoot: null, // null = automático según si tus parcelas tienen Rapid Root
  cashoutFee: 5, // % estimado de swap/bridge al pasar FLOWER a USD
  coinToFlower: 0, // valor de 1 coin en FLOWER (0 = los coins se muestran aparte)
  flowerUsdOverride: null,
  priceOverrides: {},
  countOverrides: {},
  enabledCrops: null, // null = automático según la estación
  customBoosts: [],
  disabledBoosts: [],
  candidates: [],
  animalCfg: {},
  liquidity: {}, // unidades/día que estimás que el mercado absorbe sin tirar el precio
  excluded: [],
};
