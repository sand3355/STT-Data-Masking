import { useState } from 'react';
import { confirmMasking, downloadMaskedFile, DetectionSuggestion, ProcessStats } from '../services/api.ts';

interface Props {
  jobId: string;
  fileName: string;
  suggestions: DetectionSuggestion[];
  onConfirmed: (stats: ProcessStats) => void;
  onReset: () => void;
}

export default function ReviewPanel({ jobId, fileName, suggestions, onConfirmed, onReset }: Props) {
  const [accepted, setAccepted] = useState<Set<string>>(
    () => new Set(suggestions.map((s) => s.fieldId))
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const toggle = (fieldId: string) => {
    setAccepted((prev) => {
      const next = new Set(prev);
      if (next.has(fieldId)) next.delete(fieldId);
      else next.add(fieldId);
      return next;
    });
  };

  const selectAll = () => setAccepted(new Set(suggestions.map((s) => s.fieldId)));
  const deselectAll = () => setAccepted(new Set());

  const handleConfirm = async () => {
    setLoading(true);
    setError('');
    try {
      const decisions = suggestions.map((s) => ({ fieldId: s.fieldId, accepted: accepted.has(s.fieldId) }));
      const stats = await confirmMasking(jobId, decisions);
      downloadMaskedFile(jobId, fileName);
      onConfirmed(stats);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Confirm failed');
      setLoading(false);
    }
  };

  const acceptedCount = accepted.size;
  const total = suggestions.length;

  return (
    <div className="px-4 py-8 max-w-3xl mx-auto">

      {/* Header */}
      <div className="mb-5">
        <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-1">
          Review Detected Items
        </h2>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          AI detected <strong className="text-gray-700 dark:text-gray-200">{total}</strong> sensitive{' '}
          {total === 1 ? 'item' : 'items'} in <span className="font-medium">{fileName}</span>.
          Uncheck any that should <em>not</em> be masked, then confirm to download.
        </p>
      </div>

      {/* Actions — top */}
      <div className="flex flex-wrap gap-3 mb-5">
        <button
          onClick={handleConfirm}
          disabled={loading}
          className="flex items-center gap-2 px-6 py-3 bg-blue-600 hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed text-white font-semibold rounded-xl transition-colors shadow-sm"
        >
          {loading ? (
            <>
              <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              Applying…
            </>
          ) : (
            <>
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              Confirm &amp; Download ({acceptedCount} masked)
            </>
          )}
        </button>

        <button
          onClick={onReset}
          disabled={loading}
          className="flex items-center gap-2 px-5 py-3 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50 rounded-xl font-medium transition-colors"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
          Cancel
        </button>
      </div>

      {/* Stats bar */}
      <div className="flex items-center gap-4 mb-5 p-3 rounded-xl bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800">
        <div className="text-blue-700 dark:text-blue-300">
          <span className="text-2xl font-bold">{acceptedCount}</span>
          <span className="text-sm ml-1">of {total} will be masked</span>
        </div>
        {total > 0 && (
          <div className="flex-1 h-2 bg-blue-200 dark:bg-blue-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-500 rounded-full transition-all"
              style={{ width: `${Math.round((acceptedCount / total) * 100)}%` }}
            />
          </div>
        )}
        <div className="flex gap-2 shrink-0">
          <button
            onClick={selectAll}
            className="text-xs px-2 py-1 rounded-lg border border-blue-300 dark:border-blue-700 text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-800 transition-colors"
          >
            All
          </button>
          <button
            onClick={deselectAll}
            className="text-xs px-2 py-1 rounded-lg border border-blue-300 dark:border-blue-700 text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-800 transition-colors"
          >
            None
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="mb-4 p-3 rounded-xl bg-red-50 dark:bg-red-900/30 border border-red-300 dark:border-red-700 text-red-700 dark:text-red-300 text-sm">
          <strong>Error:</strong> {error}
        </div>
      )}

      {/* Empty state */}
      {suggestions.length === 0 && (
        <div className="text-center py-12 text-gray-400 dark:text-gray-500">
          <svg className="mx-auto mb-3 w-12 h-12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
              d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p className="font-medium">No sensitive items detected</p>
          <p className="text-sm mt-1">The document appears to have no sensitive vendor data.</p>
        </div>
      )}

      {/* Flat item list */}
      <div className="space-y-2">
        {suggestions.map((s) => {
          const isChecked = accepted.has(s.fieldId);
          return (
            <label
              key={s.fieldId}
              className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-colors ${
                isChecked
                  ? 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-750'
                  : 'border-dashed border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 opacity-60 hover:opacity-80'
              }`}
            >
              <input
                type="checkbox"
                checked={isChecked}
                onChange={() => toggle(s.fieldId)}
                className="mt-0.5 w-4 h-4 rounded accent-blue-600 cursor-pointer shrink-0"
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-sm font-semibold text-gray-900 dark:text-white break-all">
                    {s.originalValue}
                  </span>
                  {isChecked && (
                    <span className="text-xs text-gray-400 dark:text-gray-500 shrink-0">
                      → <span className="font-mono text-red-500 dark:text-red-400">XXXX</span>
                    </span>
                  )}
                </div>
                {s.context && (
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 italic leading-relaxed">
                    {s.context}
                  </p>
                )}
              </div>
            </label>
          );
        })}
      </div>

    </div>
  );
}
