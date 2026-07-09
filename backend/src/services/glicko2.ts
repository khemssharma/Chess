/**
 * Glicko-2 rating system — same algorithm lichess.org uses.
 * Reference: Mark Glickman, "Example of the Glicko-2 system" (glicko.net/glicko/glicko2.pdf)
 *
 * A rating is three numbers:
 *   rating (r)            — skill estimate, starts at 1500
 *   ratingDeviation (RD)  — uncertainty, starts at 350, shrinks as you play
 *   volatility (σ)        — how erratic the player's results are, starts at 0.06
 */

export interface GlickoRating {
  rating: number;
  ratingDeviation: number;
  volatility: number;
}

export interface GlickoResult {
  opponent: GlickoRating;
  /** 1 = win, 0.5 = draw, 0 = loss (from the player's perspective) */
  score: number;
}

// System constant — constrains volatility change per rating period.
// Lichess uses ~0.75 for games; 0.5 is the conservative paper default.
const TAU = 0.5;
const GLICKO2_SCALE = 173.7178;
const CONVERGENCE = 0.000001;

export const DEFAULT_RATING: GlickoRating = {
  rating: 1500,
  ratingDeviation: 350,
  volatility: 0.06,
};

// step 2: convert to Glicko-2 internal scale
const toMu = (r: GlickoRating) => (r.rating - 1500) / GLICKO2_SCALE;
const toPhi = (r: GlickoRating) => r.ratingDeviation / GLICKO2_SCALE;

// g(φ) dampens the impact of uncertain opponents
const g = (phi: number) => 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));

// E — expected score against an opponent
const E = (mu: number, muJ: number, phiJ: number) =>
  1 / (1 + Math.exp(-g(phiJ) * (mu - muJ)));

/**
 * Update a player's rating given a set of results from one rating period.
 * For online play we apply this after every game/puzzle with a single result,
 * which is how lichess handles live rating updates too.
 */
export function updateRating(player: GlickoRating, results: GlickoResult[]): GlickoRating {
  const mu = toMu(player);
  const phi = toPhi(player);

  // No games this period → only RD grows (step 6 special case)
  if (results.length === 0) {
    const phiStar = Math.sqrt(phi * phi + player.volatility * player.volatility);
    return {
      rating: player.rating,
      ratingDeviation: Math.min(phiStar * GLICKO2_SCALE, 350),
      volatility: player.volatility,
    };
  }

  // step 3: estimated variance of the player's rating based on game outcomes
  let vInv = 0;
  for (const res of results) {
    const muJ = toMu(res.opponent);
    const phiJ = toPhi(res.opponent);
    const e = E(mu, muJ, phiJ);
    vInv += g(phiJ) * g(phiJ) * e * (1 - e);
  }
  const v = 1 / vInv;

  // step 4: estimated improvement delta
  let deltaSum = 0;
  for (const res of results) {
    const muJ = toMu(res.opponent);
    const phiJ = toPhi(res.opponent);
    deltaSum += g(phiJ) * (res.score - E(mu, muJ, phiJ));
  }
  const delta = v * deltaSum;

  // step 5: new volatility via Illinois algorithm (iterative root finding)
  const a = Math.log(player.volatility * player.volatility);
  const f = (x: number) => {
    const ex = Math.exp(x);
    const phiSq = phi * phi;
    const num = ex * (delta * delta - phiSq - v - ex);
    const den = 2 * Math.pow(phiSq + v + ex, 2);
    return num / den - (x - a) / (TAU * TAU);
  };

  let A = a;
  let B: number;
  if (delta * delta > phi * phi + v) {
    B = Math.log(delta * delta - phi * phi - v);
  } else {
    let k = 1;
    while (f(a - k * TAU) < 0) k++;
    B = a - k * TAU;
  }

  let fA = f(A);
  let fB = f(B);
  while (Math.abs(B - A) > CONVERGENCE) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) {
      A = B;
      fA = fB;
    } else {
      fA = fA / 2;
    }
    B = C;
    fB = fC;
  }
  const newVolatility = Math.exp(A / 2);

  // step 6 + 7: new RD and new rating
  const phiStar = Math.sqrt(phi * phi + newVolatility * newVolatility);
  const newPhi = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const newMu = mu + newPhi * newPhi * deltaSum;

  // step 8: convert back to the display scale
  return {
    rating: newMu * GLICKO2_SCALE + 1500,
    // RD never drops below ~30 in practice on lichess; clamp for stability
    ratingDeviation: Math.max(newPhi * GLICKO2_SCALE, 30),
    volatility: newVolatility,
  };
}

/** Convenience: update both sides of a single game. scoreForA: 1 A wins, 0 B wins, 0.5 draw */
export function updatePair(a: GlickoRating, b: GlickoRating, scoreForA: number) {
  return {
    a: updateRating(a, [{ opponent: b, score: scoreForA }]),
    b: updateRating(b, [{ opponent: a, score: 1 - scoreForA }]),
  };
}
