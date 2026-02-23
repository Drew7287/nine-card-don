// game-engine.mjs — Pure game logic, no I/O

const SUITS = ['hearts', 'diamonds', 'clubs', 'spades'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const SEATS = ['N', 'E', 'S', 'W'];

// Point values for trump scoring (only trump suit cards score these)
const TRUMP_POINTS = { 'A': 4, 'K': 3, 'Q': 2, 'J': 1, '9': 9, '5': 10 };
// Non-trump five is worth 5
const NON_TRUMP_FIVE_POINTS = 5;
// "Game" bonus: count these values across all tricks won
const GAME_VALUES = { 'A': 4, 'K': 3, 'Q': 2, 'J': 1, '10': 10 };
const GAME_BONUS = 8;
const WIN_SCORE = 121;

export function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ suit, rank });
    }
  }
  return deck;
}

export function shuffle(deck) {
  const d = [...deck];
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

export function deal(deck) {
  // Deal 9 cards to each of 4 players (N, E, S, W)
  const hands = { N: [], E: [], S: [], W: [] };
  let idx = 0;
  // Deal 3 cards at a time, 3 rounds
  for (let round = 0; round < 3; round++) {
    for (const seat of SEATS) {
      hands[seat].push(deck[idx++], deck[idx++], deck[idx++]);
    }
  }
  return hands;
}

export function createGameState(pitcherSeat = 'N') {
  const deck = shuffle(createDeck());
  const hands = deal(deck);
  return {
    hands,                    // { N: [...], E: [...], S: [...], W: [...] }
    trumpSuit: null,          // Set when pitcher plays first card
    pitched: false,           // Has first card been played?
    pitcherSeat,              // Who pitches this hand
    currentTrick: [],         // [{ seat, card }]
    ledSuit: null,            // Suit of first card in current trick
    currentPlayer: pitcherSeat,
    tricksWon: { NS: [], EW: [] }, // Each entry is an array of cards in the trick
    trickHistory: [],               // Full record of every trick for hand summary
    trickNumber: 0,
    scores: { NS: 0, EW: 0 },     // Cumulative score (persisted across hands, pegged live)
    handPoints: { NS: 0, EW: 0 }, // Points pegged this hand so far (for display)
    handComplete: false,
    gameOver: false,
    winner: null,
  };
}

export function getTeam(seat) {
  return (seat === 'N' || seat === 'S') ? 'NS' : 'EW';
}

export function getPartner(seat) {
  const partners = { N: 'S', S: 'N', E: 'W', W: 'E' };
  return partners[seat];
}

export function nextSeat(seat) {
  return SEATS[(SEATS.indexOf(seat) + 1) % 4];
}

export function nextPitcher(currentPitcher) {
  return nextSeat(currentPitcher);
}

function rankOrder(rank) {
  return RANKS.indexOf(rank);
}

export function cardKey(card) {
  return `${card.rank}_${card.suit}`;
}

export function cardsEqual(a, b) {
  return a.rank === b.rank && a.suit === b.suit;
}

/**
 * Get valid cards a player can play from their hand.
 */
export function getPlayableCards(state, seat) {
  const hand = state.hands[seat];
  if (!hand || hand.length === 0) return [];

  // Pitcher's first card: anything goes (it sets trumps)
  if (!state.pitched) {
    return [...hand];
  }

  // Must follow led suit if possible
  if (state.currentTrick.length > 0 && state.ledSuit) {
    const suitCards = hand.filter(c => c.suit === state.ledSuit);
    if (suitCards.length > 0) return suitCards;
  }

  // Can't follow suit: play anything
  return [...hand];
}

/**
 * Play a card. Returns an object describing what happened.
 * Mutates state in place.
 */
export function playCard(state, seat, card) {
  if (state.handComplete || state.gameOver) {
    return { error: 'Hand or game is already over' };
  }
  if (state.currentPlayer !== seat) {
    return { error: `Not your turn. Current player: ${state.currentPlayer}` };
  }

  const hand = state.hands[seat];
  const idx = hand.findIndex(c => cardsEqual(c, card));
  if (idx === -1) {
    return { error: 'Card not in your hand' };
  }

  const playable = getPlayableCards(state, seat);
  if (!playable.some(c => cardsEqual(c, card))) {
    return { error: 'Must follow suit' };
  }

  // Remove card from hand
  hand.splice(idx, 1);

  // Handle pitch (first card of the hand)
  let pitchRevealed = false;
  if (!state.pitched) {
    state.trumpSuit = card.suit;
    state.pitched = true;
    pitchRevealed = true;
  }

  // Set led suit for the trick
  if (state.currentTrick.length === 0) {
    state.ledSuit = card.suit;
  }

  state.currentTrick.push({ seat, card });

  // Check if trick is complete (4 cards played)
  let trickResult = null;
  let handResult = null;

  if (state.currentTrick.length === 4) {
    trickResult = resolveTrick(state);
    state.trickNumber++;

    // Game won mid-hand (team pegged 121 during trick scoring)
    if (state.gameOver) {
      handResult = buildEarlyWinResult(state);
    }
    // Check if hand is complete (9 tricks)
    else if (state.trickNumber === 9) {
      handResult = resolveHand(state);
    }
  } else {
    state.currentPlayer = nextSeat(seat);
  }

  return {
    ok: true,
    pitchRevealed,
    trickResult,
    handResult,
  };
}

/**
 * Score the cards in a trick for the winning team.
 * Trump cards + non-trump fives are pegged immediately.
 */
function scoreTrickCards(cards, trumpSuit) {
  let points = 0;
  const scoringCards = [];
  for (const card of cards) {
    let cardPts = 0;
    if (card.suit === trumpSuit && TRUMP_POINTS[card.rank]) {
      cardPts = TRUMP_POINTS[card.rank];
    } else if (card.suit !== trumpSuit && card.rank === '5') {
      cardPts = NON_TRUMP_FIVE_POINTS;
    }
    if (cardPts > 0) {
      points += cardPts;
      scoringCards.push({ card, points: cardPts });
    }
  }
  return { points, scoringCards };
}

/**
 * Determine trick winner, peg points immediately, update state.
 */
function resolveTrick(state) {
  const trick = state.currentTrick;
  let winnerEntry = trick[0];

  for (let i = 1; i < trick.length; i++) {
    const entry = trick[i];
    if (beats(entry.card, winnerEntry.card, state.trumpSuit, state.ledSuit)) {
      winnerEntry = entry;
    }
  }

  const winnerTeam = getTeam(winnerEntry.seat);
  const trickCards = trick.map(e => e.card);
  state.tricksWon[winnerTeam].push(trickCards);

  // Peg points immediately
  const trickScore = scoreTrickCards(trickCards, state.trumpSuit);
  state.scores[winnerTeam] += trickScore.points;
  state.handPoints[winnerTeam] += trickScore.points;

  // Check for immediate win at 121 (game ends the instant a team pegs out)
  if (state.scores[winnerTeam] >= WIN_SCORE) {
    state.gameOver = true;
    state.handComplete = true;
    state.winner = winnerTeam;
  }

  // Record trick in history
  state.trickHistory.push({
    trickNumber: state.trickNumber + 1,
    cards: trick.map(e => ({ seat: e.seat, card: e.card })),
    winner: winnerEntry.seat,
    winnerTeam,
    points: trickScore.points,
    scoringCards: trickScore.scoringCards,
  });

  // Reset for next trick
  state.currentTrick = [];
  state.ledSuit = null;
  state.currentPlayer = winnerEntry.seat;

  return {
    winner: winnerEntry.seat,
    winnerTeam,
    cards: trick.map(e => ({ seat: e.seat, card: e.card })),
    points: trickScore.points,
    scoringCards: trickScore.scoringCards,
  };
}

/**
 * Does card A beat card B?
 * Normal rank order for all suits (including trump): A > K > Q > ... > 2
 */
function beats(a, b, trumpSuit, ledSuit) {
  const aIsTrump = a.suit === trumpSuit;
  const bIsTrump = b.suit === trumpSuit;

  // Trump beats non-trump
  if (aIsTrump && !bIsTrump) return true;
  if (!aIsTrump && bIsTrump) return false;

  // Same suit: higher rank wins
  if (a.suit === b.suit) {
    return rankOrder(a.rank) > rankOrder(b.rank);
  }

  // Different non-trump suits: first played (b) holds
  return false;
}

/**
 * Resolve end of hand: trump points already pegged, now compute "game" bonus.
 */
function resolveHand(state) {
  state.handComplete = true;

  const gameCount = { NS: 0, EW: 0 };
  const gameCountCards = { NS: [], EW: [] };
  const trumpScoringCards = { NS: [], EW: [] };

  // Collect all scoring cards from tricks won
  for (const team of ['NS', 'EW']) {
    for (const trickCards of state.tricksWon[team]) {
      for (const card of trickCards) {
        // Game count cards (A=4, K=3, Q=2, J=1, 10=10)
        if (GAME_VALUES[card.rank]) {
          gameCount[team] += GAME_VALUES[card.rank];
          gameCountCards[team].push({ card, value: GAME_VALUES[card.rank] });
        }
        // Trump scoring cards
        let trumpPts = 0;
        if (card.suit === state.trumpSuit && TRUMP_POINTS[card.rank]) {
          trumpPts = TRUMP_POINTS[card.rank];
        } else if (card.suit !== state.trumpSuit && card.rank === '5') {
          trumpPts = NON_TRUMP_FIVE_POINTS;
        }
        if (trumpPts > 0) {
          trumpScoringCards[team].push({ card, points: trumpPts });
        }
      }
    }
  }

  // Game bonus: higher total gets 8 points, tied = nobody
  const gameBonus = { NS: 0, EW: 0 };
  let gameBonusWinner = null;
  if (gameCount.NS > gameCount.EW) {
    gameBonus.NS = GAME_BONUS;
    gameBonusWinner = 'NS';
  } else if (gameCount.EW > gameCount.NS) {
    gameBonus.EW = GAME_BONUS;
    gameBonusWinner = 'EW';
  }

  // Peg the game bonus
  state.scores.NS += gameBonus.NS;
  state.scores.EW += gameBonus.EW;
  state.handPoints.NS += gameBonus.NS;
  state.handPoints.EW += gameBonus.EW;

  // Check for win at 121
  if (state.scores.NS >= WIN_SCORE || state.scores.EW >= WIN_SCORE) {
    state.gameOver = true;
    const pitcherTeam = getTeam(state.pitcherSeat);
    if (state.scores.NS >= WIN_SCORE && state.scores.EW >= WIN_SCORE) {
      state.winner = pitcherTeam;
    } else {
      state.winner = state.scores.NS >= WIN_SCORE ? 'NS' : 'EW';
    }
  }

  return {
    handPoints: { ...state.handPoints },
    trickHistory: state.trickHistory,
    gameCount,
    gameBonus,
    gameBonusWinner,
    scores: { ...state.scores },
    gameOver: state.gameOver,
    winner: state.winner,
  };
}

/**
 * Build a hand result when a team wins mid-hand by hitting 121.
 * No game bonus is awarded — game ends immediately on peg-out.
 */
function buildEarlyWinResult(state) {
  return {
    handPoints: { ...state.handPoints },
    trickHistory: state.trickHistory,
    gameCount: { NS: 0, EW: 0 },
    gameBonus: { NS: 0, EW: 0 },
    gameBonusWinner: null,
    scores: { ...state.scores },
    gameOver: true,
    winner: state.winner,
  };
}

/**
 * Start a new hand with the next pitcher. Preserves scores.
 */
export function newHand(prevState) {
  const newPitcher = nextPitcher(prevState.pitcherSeat);
  const state = createGameState(newPitcher);
  state.scores = { ...prevState.scores };
  return state;
}

/**
 * Build a personalized view for a specific seat.
 * Only shows this player's own cards; all others get card-back counts.
 */
export function personalView(state, seat) {
  const team = getTeam(seat);

  const view = {
    trumpSuit: state.trumpSuit,
    pitched: state.pitched,
    pitcherSeat: state.pitcherSeat,
    currentPlayer: state.currentPlayer,
    currentTrick: state.currentTrick,
    ledSuit: state.ledSuit,
    trickNumber: state.trickNumber,
    tricksWonCount: {
      NS: state.tricksWon.NS.length,
      EW: state.tricksWon.EW.length,
    },
    scores: state.scores,
    handPoints: state.handPoints,
    handComplete: state.handComplete,
    gameOver: state.gameOver,
    winner: state.winner,
    myHand: state.hands[seat],
    mySeat: seat,
    myTeam: team,
    playableCards: state.currentPlayer === seat ? getPlayableCards(state, seat) : [],
    // Card counts for opponents
    handCounts: {},
  };

  for (const s of SEATS) {
    if (s === seat) continue;
    view.handCounts[s] = state.hands[s].length;
  }

  return view;
}

/**
 * Perform a cut to decide who pitches first.
 * Each team representative (N for NS, E for EW) draws a card.
 * Higher rank wins; same rank = re-draw until one is higher.
 */
export function performCut() {
  let nsCutCard, ewCutCard;

  // Keep cutting until ranks differ (ties re-draw)
  do {
    const deck = shuffle(createDeck());
    nsCutCard = deck[0];
    ewCutCard = deck[1];
  } while (RANKS.indexOf(nsCutCard.rank) === RANKS.indexOf(ewCutCard.rank));

  const nsRank = RANKS.indexOf(nsCutCard.rank);
  const ewRank = RANKS.indexOf(ewCutCard.rank);

  const winningTeam = nsRank > ewRank ? 'NS' : 'EW';
  const chooser = winningTeam === 'NS' ? 'N' : 'E';

  return { nsCutCard, ewCutCard, winningTeam, chooser };
}

export { SUITS, RANKS, SEATS, WIN_SCORE };
