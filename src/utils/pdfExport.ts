export function exportLedgerToPdf(sessions: any[], players: any[]) {
  const dateStr = new Date().toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  });

  const leaderboardRows = players
    .map(
      (p) => `
      <tr>
        <td style="padding:10px 16px;border-bottom:1px solid #e5e7eb;font-weight:600">${p.name}</td>
        <td style="padding:10px 16px;border-bottom:1px solid #e5e7eb;text-align:right;font-weight:700;color:${p.total_profit >= 0 ? '#059669' : '#dc2626'}">
          ${p.total_profit >= 0 ? '+' : '-'}₹${Math.abs(p.total_profit).toFixed(2)}
        </td>
      </tr>`
    )
    .join('');

  const sessionRows = sessions
    .map((session) => {
      const results = session.results
        .map(
          (r: any) => `
        <div style="display:inline-block;min-width:120px;margin:8px 16px 8px 0">
          <div style="font-size:11px;color:#6b7280;text-transform:uppercase;font-weight:700;letter-spacing:0.05em">${r.name}</div>
          <div style="font-size:18px;font-weight:800;font-family:monospace;color:${r.amount >= 0 ? '#059669' : '#dc2626'}">
            ${r.amount >= 0 ? '+' : '-'}₹${Math.abs(r.amount).toFixed(2)}
          </div>
        </div>`
        )
        .join('');

      return `
      <div style="margin-bottom:24px;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;page-break-inside:avoid">
        <div style="background:#f9fafb;padding:14px 20px;border-bottom:1px solid #e5e7eb;display:flex;align-items:center;gap:12px">
          <div style="background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:4px 10px;font-weight:800;font-size:13px">${session.date}</div>
          <span style="font-weight:700;font-size:15px;text-transform:uppercase">${session.note || 'Untitled Session'}</span>
        </div>
        <div style="padding:16px 20px">${results}</div>
      </div>`;
    })
    .join('');

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Poker Ledger – Report</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #111; padding: 40px; max-width: 900px; margin: 0 auto; }
    h1 { font-size: 28px; font-weight: 900; text-transform: uppercase; letter-spacing: -0.02em; margin-bottom: 4px; }
    h2 { font-size: 18px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.05em; margin: 32px 0 14px; color: #374151; }
    .meta { font-size: 13px; color: #6b7280; margin-bottom: 32px; }
    table { width: 100%; border-collapse: collapse; border: 1px solid #e5e7eb; border-radius: 10px; overflow: hidden; }
    th { background: #f3f4f6; padding: 10px 16px; text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #6b7280; font-weight: 700; }
    th:last-child { text-align: right; }
    @media print { body { padding: 20px; } }
  </style>
</head>
<body>
  <h1>🃏 Poker Ledger</h1>
  <p class="meta">Report generated on ${dateStr}</p>
  <h2>Leaderboard</h2>
  <table>
    <thead><tr><th>Player</th><th style="text-align:right">Net Profit / Loss</th></tr></thead>
    <tbody>${leaderboardRows}</tbody>
  </table>
  <h2>Session History</h2>
  ${sessionRows || '<p style="color:#6b7280">No sessions recorded.</p>'}
</body>
</html>`;

  const win = window.open('', '_blank');
  if (!win) {
    alert('Please allow pop-ups to export PDF.');
    return;
  }
  win.document.write(html);
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 500);
}
