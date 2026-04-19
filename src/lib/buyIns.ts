export interface TableBuyInRow {
  userId: string;
  name: string;
  total: number;
  isSelf: boolean;
}

interface BuyInInput {
  userId: string;
  amount: number;
  status: 'pending' | 'approved' | 'rejected';
}

interface PlayerInput {
  userId: string;
  name: string;
}

export function aggregateTableBuyIns(
  allBuyIns: BuyInInput[],
  players: PlayerInput[],
  currentUserId: string
): TableBuyInRow[] {
  const nameFor = new Map(players.map(p => [p.userId, p.name]));
  const totals = new Map<string, number>();

  for (const b of allBuyIns) {
    if (b.status !== 'approved') continue;
    totals.set(b.userId, (totals.get(b.userId) ?? 0) + b.amount);
  }

  return Array.from(totals.entries())
    .map(([userId, total]) => ({
      userId,
      name: nameFor.get(userId) ?? 'Player',
      total,
      isSelf: userId === currentUserId,
    }))
    .sort((a, b) => b.total - a.total);
}

export function potShare(total: number, pot: number): number {
  if (pot <= 0) return 0;
  return (total / pot) * 100;
}

export function tablePot(rows: Pick<TableBuyInRow, 'total'>[]): number {
  return rows.reduce((sum, r) => sum + r.total, 0);
}
