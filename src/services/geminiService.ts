export interface ExtractedResult {
  name: string;
  amount: number;
}

export async function extractPokerResults(data: string, mimeType: string, isText: boolean = false): Promise<ExtractedResult[]> {
  const response = await fetch('/api/extract', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data, mimeType, isText }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to process file.' }));
    throw new Error(error.error || 'Failed to extract data from file.');
  }

  return response.json();
}
