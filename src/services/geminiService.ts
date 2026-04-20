export interface ExtractedResult {
  name: string;
  amount: number;
}

// The Fishes routes (including /api/extract) live behind the same
// tenant-resolve middleware as the Live routes — every request must
// carry X-Tenant-Code. The value is pulled from localStorage, which the
// landing page populates after the user picks a group. A missing or
// invalid code triggers a reload back to the landing page.

function getTenantCode(): string {
  if (typeof localStorage === 'undefined') return '';
  return localStorage.getItem('tenantCode') || '';
}

function clearTenantAndReload(): void {
  if (typeof localStorage !== 'undefined') localStorage.removeItem('tenantCode');
  if (typeof window !== 'undefined') window.location.reload();
}

export async function extractPokerResults(
  data: string,
  mimeType: string,
  isText: boolean = false
): Promise<ExtractedResult[]> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const code = getTenantCode();
  if (code) headers['X-Tenant-Code'] = code;

  const response = await fetch('/api/extract', {
    method: 'POST',
    headers,
    body: JSON.stringify({ data, mimeType, isText }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to process file.' }));
    if (
      response.status === 401 &&
      (error?.error === 'missing_tenant_code' || error?.error === 'invalid_tenant_code')
    ) {
      clearTenantAndReload();
    }
    throw new Error(error.error || 'Failed to extract data from file.');
  }

  return response.json();
}
