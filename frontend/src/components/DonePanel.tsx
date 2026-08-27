import { downloadMaskedFile, ProcessStats } from '../services/api.ts';

interface Props {
  jobId: string;
  fileName: string;
  stats: ProcessStats;
  onReset: () => void;
}

function StatCard({ label, value, accent }: { label: string; value: string | number; accent: string }) {
  return (
    <div className={`rounded-xl p-5 flex flex-col gap-1 ${accent}`}>
      <span className="text-3xl font-bold">{value}</span>
      <span className="text-sm opacity-75">{label}</span>
    </div>
  );
}

export default function DonePanel({ jobId, fileName, stats, onReset }: Props) {
  const ext = (fileName.split('.').pop() || 'pdf').toLowerCase();
  const maskedCount = stats.masked + stats.pending;

  const handleDownload = () => downloadMaskedFile(jobId, fileName);

  return (
    <div className="px-4 py-10 max-w-3xl mx-auto">
      {/* Success banner */}
      <div className="flex items-center gap-3 mb-8">
        <div className="w-12 h-12 rounded-full bg-green-100 dark:bg-green-900/40 flex items-center justify-center flex-shrink-0">
          <svg className="w-6 h-6 text-green-600 dark:text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <div>
          <h2 className="text-xl font-bold text-gray-900 dark:text-white">Document masked successfully</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Your file has downloaded automatically. Use the button below if you need it again.
          </p>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-8">
        <StatCard
          label="Fields detected"
          value={stats.totalFields}
          accent="bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-100"
        />
        <StatCard
          label="Values masked"
          value={maskedCount}
          accent="bg-red-100 dark:bg-red-900/40 text-red-800 dark:text-red-200"
        />
        <StatCard
          label="Masked rate"
          value={`${stats.maskedRate}%`}
          accent="bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-200"
        />
      </div>

      {/* Actions */}
      <div className="flex flex-wrap gap-3">
        <button
          onClick={handleDownload}
          className="flex items-center gap-2 px-5 py-3 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-xl transition-colors shadow-sm"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
          Download masked .{ext} again
        </button>

        <button
          onClick={onReset}
          className="flex items-center gap-2 px-5 py-3 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-xl font-medium transition-colors"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m-8-8h16" />
          </svg>
          Mask another document
        </button>
      </div>
    </div>
  );
}
