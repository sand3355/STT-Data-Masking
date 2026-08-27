import React, { useCallback, useState } from 'react';
import { uploadFile, processJobStream, DetectionSuggestion } from '../services/api.ts';

interface Props {
  onDone: (jobId: string, fileName: string, suggestions: DetectionSuggestion[]) => void;
}

type Phase = 'idle' | 'uploading' | 'processing' | 'error';

const PHASE_LABELS: Record<Phase, string> = {
  idle: '',
  uploading: 'Uploading document…',
  processing: 'AI is reading and detecting sensitive data…',
  error: '',
};

// Mirrors the server-side limits in src/utils/config.ts (limits block):
// uploads beyond these are rejected by the server with the same reasoning.
const MAX_UPLOAD_MB = 10;
// Above this the server masks in multiple AI passes — noticeably slower
// (server: maxSinglePassChars)
const LARGE_TEXT_WARN_CHARS = 150_000;

export default function UploadZone({ onDone }: Props) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [largeDocNotice, setLargeDocNotice] = useState('');

  const process = useCallback(async (file: File) => {
    setError('');
    setStreamText('');
    setLargeDocNotice('');

    // Instant client-side check — no point uploading a file the server rejects
    if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
      setError(
        `${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB — ` +
        `the maximum upload size is ${MAX_UPLOAD_MB} MB. Please split the document and upload the parts separately.`
      );
      setPhase('error');
      return;
    }

    setPhase('uploading');

    try {
      const { jobId, fileName, charCount } = await uploadFile(file);
      if (charCount > LARGE_TEXT_WARN_CHARS) {
        setLargeDocNotice('Large document — processing may take a few minutes. Please keep this tab open.');
      }
      setPhase('processing');

      const { suggestions } = await processJobStream(jobId, (delta) => {
        setStreamText((prev) => prev + delta);
      });

      onDone(jobId, fileName, suggestions);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'An error occurred');
      setPhase('error');
    }
  }, [onDone]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) process(file);
  }, [process]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) process(file);
    e.target.value = '';
  }, [process]);

  const isLoading = phase === 'uploading' || phase === 'processing';

  return (
    <div className="flex flex-col items-center justify-center min-h-[65vh] px-4">
      <div className="w-full max-w-lg space-y-6">
        {/* Upload zone */}
        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
          className={`
            border-2 border-dashed rounded-2xl p-12 text-center transition-all
            ${dragging ? 'border-blue-500 bg-blue-50 dark:bg-blue-950' :
              'border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800'}
            ${isLoading ? 'opacity-60 pointer-events-none' :
              'cursor-pointer hover:border-blue-400 hover:bg-blue-50 dark:hover:bg-gray-700'}
          `}
        >
          {isLoading ? (
            <div className="flex flex-col items-center gap-4">
              <div className="w-14 h-14 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
              <p className="text-lg font-semibold text-gray-700 dark:text-gray-200">
                {PHASE_LABELS[phase]}
              </p>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {phase === 'processing'
                  ? 'Claude is scanning every table, cell, and value for sensitive data…'
                  : 'Sending file to server…'}
              </p>
            </div>
          ) : (
            <>
              <svg className="mx-auto mb-4 w-14 h-14 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                  d="M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              <p className="text-xl font-semibold text-gray-700 dark:text-gray-200 mb-2">
                Drop your document here
              </p>
              <p className="text-sm text-gray-500 dark:text-gray-400 mb-1">
                AI will detect sensitive vendor data for your review before masking
              </p>
              <p className="text-xs text-gray-400 dark:text-gray-500 mb-6">
                Supports PDF, Excel (.xlsx), CSV, Word (.docx, .doc) — max 10 MB
              </p>
              <label className="inline-block cursor-pointer bg-blue-600 hover:bg-blue-700 text-white font-medium px-6 py-2.5 rounded-lg transition-colors">
                Browse files
                <input
                  type="file"
                  accept=".xlsx,.csv,.pdf,.docx,.doc"
                  className="hidden"
                  onChange={handleChange}
                  disabled={isLoading}
                />
              </label>
            </>
          )}
        </div>

        {/* Large document notice */}
        {phase === 'processing' && largeDocNotice && (
          <div className="bg-amber-50 dark:bg-amber-900/30 border border-amber-300 dark:border-amber-700 rounded-xl p-4 text-amber-800 dark:text-amber-300 text-sm">
            <strong>Heads up:</strong> {largeDocNotice}
          </div>
        )}

        {/* Live AI stream */}
        {phase === 'processing' && streamText && (
          <div className="bg-gray-900 dark:bg-black rounded-xl p-4 font-mono text-xs text-green-400 max-h-44 overflow-y-auto">
            <span className="opacity-50 text-[10px] block mb-1">AI response stream</span>
            {streamText}
            <span className="animate-pulse">▌</span>
          </div>
        )}

        {/* Error */}
        {phase === 'error' && (
          <div className="bg-red-50 dark:bg-red-900/30 border border-red-300 dark:border-red-700 rounded-xl p-4 text-red-700 dark:text-red-300 text-sm">
            <strong>Error:</strong> {error}
            <button onClick={() => setPhase('idle')} className="ml-4 underline hover:no-underline">
              Try again
            </button>
          </div>
        )}

      </div>
    </div>
  );
}
