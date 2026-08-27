export interface UploadResult {
  jobId: string;
  fileName: string;
  fileType: string;
  charCount: number;
}

export interface CategoryStat {
  category: string;
  total: number;
  masked: number;
  skipped: number;
}

export interface ProcessStats {
  totalFields: number;
  masked: number;
  skipped: number;
  pending: number;
  maskedRate: number;
  byCategory: CategoryStat[];
}

export interface DetectionSuggestion {
  fieldId: string;
  fieldName: string;
  originalValue: string;
  maskedValue: string;
  reason: string;
  sensitivity: string;
  source: string;
  confidence: number;
  occurrences: number;
  verified: boolean;
  context: string;
}

export interface ProcessResult {
  stats: ProcessStats;
  suggestions: DetectionSuggestion[];
}

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((body as { error: string }).error || res.statusText);
  }
  return res.json() as Promise<T>;
}

export async function uploadFile(file: File): Promise<UploadResult> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch('/api/upload', { method: 'POST', body: form });
  return handleResponse<UploadResult>(res);
}

export function processJobStream(
  jobId: string,
  onChunk: (text: string) => void
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const es = new EventSource(`/api/process/${jobId}/stream`);
    const MAX_RETRIES = 5;
    let retries = 0;
    let settled = false;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      es.close();
      fn();
    };

    es.onopen = () => {
      retries = 0;
    };

    es.onmessage = (event: MessageEvent<string>) => {
      try {
        const data = JSON.parse(event.data) as
          | { type: 'chunk'; text: string }
          | { type: 'done'; stats: ProcessStats; fileName: string; suggestions: DetectionSuggestion[] }
          | { type: 'error'; message: string };

        if (data.type === 'chunk') {
          onChunk(data.text);
        } else if (data.type === 'done') {
          settle(() => resolve({ stats: data.stats, suggestions: data.suggestions ?? [] }));
        } else if (data.type === 'error') {
          settle(() => reject(new Error(data.message)));
        }
      } catch {
        settle(() => reject(new Error('Invalid SSE message')));
      }
    };

    // Transient drops are recovered automatically: the browser reconnects and
    // the server attaches the new connection to the same in-flight job (or
    // replays the finished result). Only give up when the browser marks the
    // connection permanently closed or the retry budget is spent.
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) {
        settle(() => reject(new Error(
          'Lost connection to the server. Please check the server is running, then try again.'
        )));
      } else if (++retries > MAX_RETRIES) {
        settle(() => reject(new Error(
          'Connection kept dropping while processing. Please check your network and try again.'
        )));
      }
    };
  });
}

export async function confirmMasking(
  jobId: string,
  decisions: Array<{ fieldId: string; accepted: boolean }>
): Promise<ProcessStats> {
  const res = await fetch(`/api/process/${jobId}/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decisions }),
  });
  const data = await handleResponse<{ ok: boolean; stats: ProcessStats }>(res);
  return data.stats;
}

export function downloadMaskedFile(jobId: string, fileName: string): void {
  const ext = fileName.split('.').pop() || 'pdf';
  const a = document.createElement('a');
  a.href = `/api/export/${jobId}/file`;
  a.download = fileName.replace(/\.[^.]+$/, '') + `-masked.${ext.toLowerCase()}`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}
