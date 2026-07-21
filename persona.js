// persona.js — assign a stable, friendly identity to each session.
// Deterministic from the session id, so the same agent is always the same
// person (name + color + initial) even across server restarts.

const NAMES = [
  'Marcus', 'Priya', 'Dax', 'Nova', 'Kai', 'Luna', 'Rex', 'Zoe', 'Ivo', 'Mira',
  'Theo', 'Aria', 'Bruno', 'Sela', 'Otto', 'Vera', 'Finn', 'Iris', 'Cole', 'Nia',
  'Ravi', 'Elsa', 'Gus', 'Yara', 'Levi', 'Tess', 'Enzo', 'Maya', 'Jax', 'Lola',
  'Omar', 'Suki', 'Milo', 'Wren', 'Hugo', 'Cleo', 'Beau', 'Anya', 'Rio', 'Fern',
  'Silas', 'Juno', 'Dane', 'Esme', 'Knox', 'Lark', 'Pax', 'Vale', 'Bex', 'Zane',
];

// Pleasant, distinct hues for avatars/accents.
const COLORS = [
  '#5b8cff', '#35d07f', '#f5b53d', '#b47bff', '#ff6b9d', '#4ecdc4',
  '#ff8c42', '#7c6cff', '#2ecc71', '#e84393', '#00b8d4', '#ffb142',
];

function hash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h << 5) - h + str.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

// Deterministic identity; `offset` lets the caller probe for a free name when
// two different session ids would otherwise collide on the same name.
function personaAt(sessionId, offset = 0) {
  const h = hash(String(sessionId || 'unknown'));
  const name = NAMES[(h + offset) % NAMES.length];
  const color = COLORS[(h >> 4) % COLORS.length];
  return { name, color, initial: name[0].toUpperCase() };
}

function persona(sessionId) {
  return personaAt(sessionId, 0);
}

module.exports = { persona, personaAt, NAMES, COLORS };
