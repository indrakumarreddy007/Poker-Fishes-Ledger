import { jsPDF } from "jspdf";
import "jspdf-autotable";

export function exportLedgerToPdf(sessions: any[], players: any[]) {
  const doc = new jsPDF();
  
  // Title
  doc.setFontSize(20);
  doc.text("Poker Fishes Ledger Report", 14, 22);
  doc.setFontSize(11);
  doc.setTextColor(100);
  doc.text(`Generated on ${new Date().toLocaleDateString()}`, 14, 30);

  // Leaderboard Section
  doc.setFontSize(16);
  doc.setTextColor(0);
  doc.text("Leaderboard", 14, 45);
  
  const leaderboardData = players.map(p => [
    p.name,
    p.total_profit >= 0 ? `+$${p.total_profit.toFixed(2)}` : `-$${Math.abs(p.total_profit).toFixed(2)}`
  ]);

  (doc as any).autoTable({
    startY: 50,
    head: [['Player', 'Total Profit/Loss']],
    body: leaderboardData,
    theme: 'striped',
    headStyles: { fillColor: [63, 63, 70] },
  });

  // Sessions Section
  let currentY = (doc as any).lastAutoTable.finalY + 15;
  doc.setFontSize(16);
  doc.text("Session History", 14, currentY);
  currentY += 5;

  sessions.forEach((session, index) => {
    if (currentY > 250) {
      doc.addPage();
      currentY = 20;
    }

    doc.setFontSize(12);
    doc.setFont("helvetica", "bold");
    doc.text(`Session: ${session.date} ${session.note ? `(${session.note})` : ''}`, 14, currentY + 10);
    currentY += 12;

    const sessionResults = session.results.map((r: any) => [
      r.name,
      r.amount >= 0 ? `+$${r.amount.toFixed(2)}` : `-$${Math.abs(r.amount).toFixed(2)}`
    ]);

    (doc as any).autoTable({
      startY: currentY,
      head: [['Player', 'Result']],
      body: sessionResults,
      theme: 'plain',
      headStyles: { fillColor: [113, 113, 122] },
      margin: { left: 20 },
    });

    currentY = (doc as any).lastAutoTable.finalY + 10;
  });

  doc.save("poker-fishes-ledger.pdf");
}
