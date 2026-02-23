// card-utils.mjs — Suit symbols, colors, card display helpers

export const SUIT_SYMBOLS = {
  hearts: '\u2665',
  diamonds: '\u2666',
  clubs: '\u2663',
  spades: '\u2660',
};

export const SUIT_COLORS = {
  hearts: '#c0392b',
  diamonds: '#c0392b',
  clubs: '#d4cdb8',
  spades: '#d4cdb8',
};

export const SUIT_SHORT = {
  hearts: 'H',
  diamonds: 'D',
  clubs: 'C',
  spades: 'S',
};

export function suitSymbol(suit) {
  return SUIT_SYMBOLS[suit] || '?';
}

export function suitColor(suit) {
  return SUIT_COLORS[suit] || '#000';
}

export function cardLabel(card) {
  return `${card.rank}${SUIT_SYMBOLS[card.suit]}`;
}

export function cardId(card) {
  return `${card.rank}_${card.suit}`;
}

// Sort hand: group by suit (trump first), then by rank descending
export function sortHand(cards, trumpSuit) {
  const suitOrder = trumpSuit
    ? [trumpSuit, ...['hearts', 'diamonds', 'clubs', 'spades'].filter(s => s !== trumpSuit)]
    : ['spades', 'hearts', 'diamonds', 'clubs'];

  const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

  return [...cards].sort((a, b) => {
    const suitDiff = suitOrder.indexOf(a.suit) - suitOrder.indexOf(b.suit);
    if (suitDiff !== 0) return suitDiff;
    return RANKS.indexOf(b.rank) - RANKS.indexOf(a.rank);
  });
}

