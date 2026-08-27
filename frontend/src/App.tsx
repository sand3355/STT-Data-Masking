import { useEffect, useState } from 'react';
import UploadZone from './components/UploadZone.tsx';
import ReviewPanel from './components/ReviewPanel.tsx';
import DonePanel from './components/DonePanel.tsx';
import { DetectionSuggestion, ProcessStats } from './services/api.ts';

type Screen = 'upload' | 'review' | 'done';

export default function App() {
  const [darkMode, setDarkMode] = useState<boolean>(() => {
    return localStorage.getItem('darkMode') === 'true';
  });
  const [screen, setScreen] = useState<Screen>('upload');
  const [jobId, setJobId] = useState('');
  const [fileName, setFileName] = useState('');
  const [suggestions, setSuggestions] = useState<DetectionSuggestion[]>([]);
  const [stats, setStats] = useState<ProcessStats | null>(null);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode);
    localStorage.setItem('darkMode', String(darkMode));
  }, [darkMode]);

  // Called when AI finishes processing — move to review screen
  const handleProcessDone = (id: string, name: string, sugs: DetectionSuggestion[]) => {
    setJobId(id);
    setFileName(name);
    setSuggestions(sugs);
    setScreen('review');
  };

  // Called when user confirms review decisions — move to done screen
  const handleReviewConfirmed = (finalStats: ProcessStats) => {
    setStats(finalStats);
    setScreen('done');
  };

  const handleReset = () => {
    setJobId('');
    setFileName('');
    setSuggestions([]);
    setStats(null);
    setScreen('upload');
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-white transition-colors">
      <header className="sticky top-0 z-10 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 shadow-sm">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center text-white">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
              </svg>
            </div>
            <h1 className="font-bold text-gray-900 dark:text-white">Data Masking</h1>
          </div>

          {/* Step indicator */}
          {screen !== 'upload' && (
            <div className="hidden sm:flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
              <span className={screen === 'review' ? 'text-blue-600 dark:text-blue-400 font-medium' : 'text-green-600 dark:text-green-400'}>
                1 Upload
              </span>
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
              <span className={screen === 'review' ? 'text-blue-600 dark:text-blue-400 font-medium' : screen === 'done' ? 'text-green-600 dark:text-green-400' : ''}>
                2 Review
              </span>
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
              <span className={screen === 'done' ? 'text-blue-600 dark:text-blue-400 font-medium' : ''}>
                3 Download
              </span>
            </div>
          )}

          <button
            onClick={() => setDarkMode((d) => !d)}
            className="w-9 h-9 flex items-center justify-center rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-500 dark:text-gray-400 transition-colors"
            title="Toggle dark mode"
          >
            {darkMode ? (
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
              </svg>
            ) : (
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
              </svg>
            )}
          </button>
        </div>
      </header>

      <main className="max-w-5xl mx-auto">
        {screen === 'upload' && (
          <UploadZone onDone={handleProcessDone} />
        )}
        {screen === 'review' && (
          <ReviewPanel
            jobId={jobId}
            fileName={fileName}
            suggestions={suggestions}
            onConfirmed={handleReviewConfirmed}
            onReset={handleReset}
          />
        )}
        {screen === 'done' && stats && (
          <DonePanel jobId={jobId} fileName={fileName} stats={stats} onReset={handleReset} />
        )}
      </main>
    </div>
  );
}
