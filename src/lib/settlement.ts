export interface SettlementTx {
  from: string;
  to: string;
  amount: number;
}

export interface PlayerResult {
  userId: string;
  name: string;
  buyIn: number;
  winnings: number;
  net: number;
}

interface PlayerInput {
  userId: string;
  name: string;
  finalWinnings?: number;
}

interface BuyInInput {
  userId: string;
  amount: number;
}

export function computePlayerResults(
  players: PlayerInput[],
  approvedBuyIns: BuyInInput[]
): PlayerResult[] {
  return players
    .map(p => {
      const buyIn = approvedBuyIns
        .filter(b => b.userId === p.userId)
        .reduce((sum, b) => sum + b.amount, 0);
      const winnings = p.finalWinnings ?? 0;
      return {
        userId: p.userId,
        name: p.name,
        buyIn,
        winnings,
        net: winnings - buyIn,
      };
    })
    .sort((a, b) => b.net - a.net);
}

export function computeSettlements(results: PlayerResult[]): SettlementTx[] {
  const givers = results.filter(r => r.net < 0).map(r => ({ name: r.name, net: Math.abs(r.net) }));
  const receivers = results.filter(r => r.net > 0).map(r => ({ name: r.name, net: r.net }));

  const transactions: SettlementTx[] = [];
  let gIdx = 0;
  let rIdx = 0;

  while (gIdx < givers.length && rIdx < receivers.length) {
    const giver = givers[gIdx];
    const receiver = receivers[rIdx];

    const payment = Math.min(giver.net, receiver.net);
    if (payment > 0) {
      transactions.push({
        from: giver.name,
        to: receiver.name,
        amount: Math.round(payment * 100) / 100,
      });
    }

    giver.net -= payment;
    receiver.net -= payment;

    if (giver.net < 0.01) gIdx++;
    if (receiver.net < 0.01) rIdx++;
  }

  return transactions;
}
