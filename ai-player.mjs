// ai-player.mjs — AI Brain: pure heuristic logic, no I/O

import { getPlayableCards, getTeam, getPartner, RANKS, SUITS } from './game-engine.mjs';

export const AI_NAMES = ['Bot Alun', 'Bot Dai', 'Bot Megan', 'Bot Sian'];
export const AI_DELAY_MIN = 800;
export const AI_DELAY_MAX = 2000;
export const PITCH_DELAY = 1500;
export const READY_DELAY = 1000;

const TRUMP_POINTS = { 'A': 4, 'K': 3, 'Q': 2, 'J': 1, '9': 9, '5': 10 };
const NON_TRUMP_FIVE = 5;

function rankValue(rank) {
  return RANKS.indexOf(rank);
}

/**
 * Decide whether AI should pitch self or partner.
 * Called before cards are dealt, so we just default to 'self'.
 * (The winning team generally wants to pitch.)
 */
export function aiChoosePitcher() {
  return 'self';
}

/**
 * Choose which card to play. Returns { suit, rank }.
 */
export function aiChooseCard(state, seat) {
  const playable = getPlayableCards(state, seat);
  if (playable.length === 0) return null;
  if (playable.length === 1) return playable[0];

  // First card of the hand — pitching (sets trump)
  if (!state.pitched) {
    return choosePitchCard(state, seat, playable);
  }

  // Leading a trick
  if (state.currentTrick.length === 0) {
    return chooseLeadCard(state, seat, playable);
  }

  // Following in a trick
  return chooseFollowCard(state, seat, playable);
}

// --- Pitching ---

function choosePitchCard(state, seat, playable) {
  const hand = state.hands[seat];

  // Find best suit to pitch: length * 2 + trump point values
  let bestSuit = null;
  let bestScore = -1;

  for (const suit of SUITS) {
    const suitCards = hand.filter(c => c.suit === suit);
    if (suitCards.length === 0) continue;

    let score = suitCards.length * 2;
    for (const card of suitCards) {
      if (TRUMP_POINTS[card.rank]) score += TRUMP_POINTS[card.rank];
    }

    if (score > bestScore) {
      bestScore = score;
      bestSuit = suit;
    }
  }

  // From best suit: lead Ace if held, else highest non-point card
  const trumpCards = playable.filter(c => c.suit === bestSuit);
  const ace = trumpCards.find(c => c.rank === 'A');
  if (ace) return ace;

  // Highest non-point card (avoid leading 5 or 9 as first pitch)
  const nonPoint = trumpCards.filter(c => c.rank !== '5' && c.rank !== '9');
  if (nonPoint.length > 0) {
    return nonPoint.reduce((best, c) => rankValue(c.rank) > rankValue(best.rank) ? c : best);
  }

  // All are point cards — lead highest
  return trumpCards.reduce((best, c) => rankValue(c.rank) > rankValue(best.rank) ? c : best);
}

// --- Leading a trick ---

function chooseLeadCard(state, seat, playable) {
  const trump = state.trumpSuit;

  // Lead trump Ace if held
  const trumpAce = playable.find(c => c.suit === trump && c.rank === 'A');
  if (trumpAce) return trumpAce;

  // Lead non-trump Aces (likely winners)
  const aces = playable.filter(c => c.rank === 'A' && c.suit !== trump);
  if (aces.length > 0) return aces[0];

  // Lead from longest non-trump suit
  const nonTrump = playable.filter(c => c.suit !== trump);
  if (nonTrump.length > 0) {
    const suitGroups = {};
    for (const c of nonTrump) {
      if (!suitGroups[c.suit]) suitGroups[c.suit] = [];
      suitGroups[c.suit].push(c);
    }

    let longestSuit = null;
    let maxLen = 0;
    for (const [suit, cards] of Object.entries(suitGroups)) {
      if (cards.length > maxLen) {
        maxLen = cards.length;
        longestSuit = suit;
      }
    }

    if (longestSuit) {
      const suitCards = suitGroups[longestSuit];
      return suitCards.reduce((best, c) => rankValue(c.rank) > rankValue(best.rank) ? c : best);
    }
  }

  // Only trump left — lead high but protect 5 and 9
  const trumpCards = playable.filter(c => c.suit === trump);
  if (trumpCards.length > 0) {
    const safeLeads = trumpCards.filter(c => c.rank !== '5' && c.rank !== '9');
    if (safeLeads.length > 0) {
      return safeLeads.reduce((best, c) => rankValue(c.rank) > rankValue(best.rank) ? c : best);
    }
  }

  // Fallback: lowest card
  return lowest(playable);
}

// --- Following in a trick ---

function chooseFollowCard(state, seat, playable) {
  const trump = state.trumpSuit;
  const { winningCard } = currentTrickWinner(state);
  const myTeam = getTeam(seat);
  const { winningSeat } = currentTrickWinner(state);
  const partnerWinning = getTeam(winningSeat) === myTeam;
  const trickPoints = trickPointValue(state.currentTrick, trump);

  // Check if we're following the led suit
  const followingSuit = playable[0].suit === state.ledSuit;

  if (followingSuit) {
    return followSuitPlay(playable, winningCard, partnerWinning, trickPoints, trump, state);
  } else {
    return cantFollowPlay(playable, winningCard, partnerWinning, trickPoints, trump, state);
  }
}

function followSuitPlay(playable, winningCard, partnerWinning, trickPoints, trump, state) {
  const beaters = playable.filter(c => cardBeats(c, winningCard, trump, state.ledSuit));

  if (partnerWinning && trickPoints < 5) {
    // Partner winning, low stakes — play lowest
    return lowest(playable);
  }

  if (beaters.length > 0) {
    if (trickPoints >= 5 || state.currentTrick.length === 3 || !partnerWinning) {
      // Important trick or opponent winning — take with lowest winner
      return lowest(beaters);
    }
  }

  // Can't beat or partner winning — play lowest
  return lowest(playable);
}

function cantFollowPlay(playable, winningCard, partnerWinning, trickPoints, trump, state) {
  const trumpCards = playable.filter(c => c.suit === trump);
  const nonTrump = playable.filter(c => c.suit !== trump);

  if (partnerWinning && trickPoints < 5) {
    // Partner winning, low stakes — discard lowest non-point
    return discardLowest(playable, trump);
  }

  if (trumpCards.length > 0 && !partnerWinning) {
    // Opponent winning — trump in
    if (winningCard.suit === trump) {
      // Need to over-trump
      const overTrumps = trumpCards.filter(c => rankValue(c.rank) > rankValue(winningCard.rank));
      if (overTrumps.length > 0) return lowest(overTrumps);
      // Can't over-trump — discard
      return discardLowest(nonTrump.length > 0 ? nonTrump : playable, trump);
    }
    // Winner is not trump — any trump wins. Use lowest, protect 5
    const safeTrumps = trumpCards.filter(c => c.rank !== '5');
    if (safeTrumps.length > 0) return lowest(safeTrumps);
    return lowest(trumpCards);
  }

  if (trumpCards.length > 0 && trickPoints >= 5 && !partnerWinning) {
    // Points at stake, trump in
    const safeTrumps = trumpCards.filter(c => c.rank !== '5');
    if (safeTrumps.length > 0) return lowest(safeTrumps);
    return lowest(trumpCards);
  }

  // No trump or partner winning — discard lowest non-point
  return discardLowest(nonTrump.length > 0 ? nonTrump : playable, trump);
}

// --- Helpers ---

function currentTrickWinner(state) {
  const trick = state.currentTrick;
  if (trick.length === 0) return { winningSeat: null, winningCard: null };

  let winner = trick[0];
  for (let i = 1; i < trick.length; i++) {
    if (cardBeats(trick[i].card, winner.card, state.trumpSuit, state.ledSuit)) {
      winner = trick[i];
    }
  }
  return { winningSeat: winner.seat, winningCard: winner.card };
}

function cardBeats(a, b, trump, ledSuit) {
  const aIsTrump = a.suit === trump;
  const bIsTrump = b.suit === trump;

  if (aIsTrump && !bIsTrump) return true;
  if (!aIsTrump && bIsTrump) return false;
  if (a.suit === b.suit) return rankValue(a.rank) > rankValue(b.rank);
  return false;
}

function trickPointValue(trick, trump) {
  let pts = 0;
  for (const { card } of trick) {
    if (card.suit === trump && TRUMP_POINTS[card.rank]) {
      pts += TRUMP_POINTS[card.rank];
    } else if (card.suit !== trump && card.rank === '5') {
      pts += NON_TRUMP_FIVE;
    }
  }
  return pts;
}

function lowest(cards) {
  return cards.reduce((best, c) => rankValue(c.rank) < rankValue(best.rank) ? c : best);
}

function discardLowest(cards, trump) {
  // Prefer discarding non-point cards
  const nonPoint = cards.filter(c => {
    if (c.suit === trump) return !TRUMP_POINTS[c.rank];
    return c.rank !== '5'; // Protect non-trump 5s (worth 5 pts)
  });

  if (nonPoint.length > 0) return lowest(nonPoint);
  return lowest(cards);
}
