import { useEffect, useRef, useState } from 'react';
import { FileText } from 'lucide-react';
import { authError } from '../auth/transport';
import { dateRange, downloadReport, readReport, reportConfig, saveReportDownload } from '../api/reports';
import type { ReportConfig, ReportData, ReportFilters, ReportKind } from '../api/reports';
import { ReportTable } from '../components/reports/ReportTable';

const button = 'rounded-lg border bg-white px-4 py-2 font-medium disabled:opacity-50';
const selectedButton = 'rounded-lg border border-emerald-700 bg-emerald-700 px-4 py-2 font-semibold text-white';
const PAGE_SIZE = 50;

export default function Reports() {
  const [config, setConfig] = useState<ReportConfig>();
  const [configError, setConfigError] = useState('');
  const [configRetry, setConfigRetry] = useState(0);
  const [kind, setKind] = useState<ReportKind>('attendance');
  const [filters, setFilters] = useState<ReportFilters>({ from: '', to: '', roomId: '' });
  const [data, setData] = useState<ReportData>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const [page, setPage] = useState(1);
  const [downloading, setDownloading] = useState(false);
  const [exportError, setExportError] = useState('');
  const [message, setMessage] = useState('');
  const exportRequest = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController(); setConfigError('');
    void reportConfig(controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setConfig(result);
      setFilters((current) => current.from ? current : { ...current, ...dateRange('month', result.today) });
    }).catch((failure) => {
      if (!controller.signal.aborted) setConfigError(authError(failure, 'Could not load report settings. Try again.'));
    });
    return () => controller.abort();
  }, [configRetry]);

  const datesError = !config ? '' : !filters.from || !filters.to ? 'Choose both dates.' :
    filters.from > filters.to ? 'The end date must be on or after the start date.' :
    (Date.parse(filters.to + 'T00:00:00Z') - Date.parse(filters.from + 'T00:00:00Z')) / 86400000 + 1 > config.maxRangeDays ?
      `Choose a range of up to ${config.maxRangeDays} days.` : '';
  useEffect(() => {
    const controller = new AbortController();
    setData(undefined); setPage(1); setError(''); setExportError(''); setMessage('');
    exportRequest.current?.abort(); exportRequest.current = null; setDownloading(false);
    if (!config || datesError) { setLoading(false); return () => controller.abort(); }
    setLoading(true);
    void readReport(kind, filters, controller.signal).then((result) => {
      if (!controller.signal.aborted) setData(result);
    }).catch((failure) => {
      if (!controller.signal.aborted) setError(authError(failure, 'Could not load the report. Try again.'));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); exportRequest.current?.abort(); };
  }, [kind, filters, config, datesError, retry]);

  const visible = data && !loading && !error && !datesError && data.kind === kind &&
    data.filters.from === filters.from && data.filters.to === filters.to &&
    (kind !== 'attendance' || (data.filters.roomId || '') === filters.roomId) ? data : undefined;
  async function download() {
    if (!visible || exportRequest.current) return;
    const controller = new AbortController(); exportRequest.current = controller;
    setDownloading(true); setExportError(''); setMessage('');
    try {
      const blob = await downloadReport(kind, filters, controller.signal);
      if (!controller.signal.aborted) {
        saveReportDownload(blob, `${kind}-${filters.from}-to-${filters.to}.csv`);
        setMessage('CSV downloaded for the selected dates.');
      }
    } catch (failure) {
      if (!controller.signal.aborted) setExportError(authError(failure, 'Could not download the report. Try again.'));
    } finally {
      if (exportRequest.current === controller) { exportRequest.current = null; setDownloading(false); }
    }
  }
  function preset(value: 'today' | 'week' | 'month') {
    if (config) setFilters((current) => ({ ...current, ...dateRange(value, config.today) }));
  }

  return <div className="reports-page mx-auto max-w-7xl space-y-5 p-2 sm:p-6 print:max-w-none print:p-0">
    <style>{`@media print {
      body:has(.reports-page), body:has(.reports-page) #root { height: auto !important; background: white !important; }
      body:has(.reports-page) #root > div, body:has(.reports-page) #root > div > div, body:has(.reports-page) main { display: block !important; height: auto !important; overflow: visible !important; padding: 0 !important; }
      .reports-page { color: black; font-size: 10pt; }
      .reports-page table { table-layout: fixed; font-size: 9pt; }
      .reports-page th, .reports-page td { overflow-wrap: anywhere; }
      .reports-page thead { display: table-header-group; }
    }`}</style>
    <header className="print:hidden"><h1 className="flex items-center gap-3 text-3xl font-bold text-slate-900"><FileText className="text-emerald-700" />Reports</h1>
      <p className="mt-2 text-slate-600">Choose dates to review attendance or purchases.</p></header>
    {!config && !configError && <p role="status">Loading report settings…</p>}
    {configError && <div role="alert" className="rounded-lg bg-red-50 p-4 text-red-800">{configError} <button className={button} onClick={() => setConfigRetry((n) => n + 1)}>Retry report settings</button></div>}
    {config && <section aria-label="Report filters" className="space-y-4 rounded-2xl border bg-white p-5 print:hidden">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Report type">
        <button className={kind === 'attendance' ? selectedButton : button} aria-pressed={kind === 'attendance'} onClick={() => setKind('attendance')}>Attendance</button>
        <button className={kind === 'purchases' ? selectedButton : button} aria-pressed={kind === 'purchases'} onClick={() => setKind('purchases')}>Purchases</button>
      </div>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Quick dates">{(['today', 'week', 'month'] as const).map((value) =>
        <button key={value} className={button} onClick={() => preset(value)}>{value === 'today' ? 'Today' : value === 'week' ? 'This week' : 'This month'}</button>)}</div>
      <div className="grid gap-4 sm:grid-cols-3">
        <label>From<input type="date" min="1900-01-01" max="9999-12-30" value={filters.from} onChange={(event) => setFilters({ ...filters, from: event.target.value })} className="mt-1 block w-full rounded-lg border p-2.5" /></label>
        <label>To<input type="date" min="1900-01-01" max="9999-12-30" value={filters.to} onChange={(event) => setFilters({ ...filters, to: event.target.value })} className="mt-1 block w-full rounded-lg border p-2.5" /></label>
        {kind === 'attendance' && <div>
          <label htmlFor="reports-room">Room</label>
          <select id="reports-room" value={filters.roomId} onChange={(event) => setFilters({ ...filters, roomId: event.target.value })} className="mt-1 block w-full rounded-lg border p-2.5">
            <option value="">All rooms</option>{config.rooms.map((room) => <option key={room.id} value={room.id}>{room.name}{room.active ? '' : ' (archived)'}</option>)}
          </select>
        </div>}
      </div>
    </section>}
    {config && <div className="flex flex-wrap gap-3 print:hidden">
      <button className={button} disabled={loading || !!datesError || downloading} onClick={() => setRetry((n) => n + 1)}>Refresh report</button>
      <button className={button} disabled={!visible || downloading} onClick={() => window.print()}>Print report</button>
      <button className={selectedButton + ' disabled:opacity-50'} disabled={!visible || downloading} onClick={() => void download()}>{downloading ? 'Downloading…' : 'Download CSV'}</button>
    </div>}
    {loading && <p role="status">Loading report…</p>}
    {datesError && <p role="alert" className="rounded-lg bg-amber-50 p-3 text-amber-900">{datesError}</p>}
    {error && <div role="alert" className="rounded-lg bg-red-50 p-4 text-red-800">{error} <button className={button} onClick={() => setRetry((n) => n + 1)}>Retry report</button></div>}
    {exportError && <p role="alert" className="text-red-800 print:hidden">{exportError}</p>}
    {message && <p role="status" className="text-emerald-800 print:hidden">{message}</p>}
    {visible && <section aria-label="Report results" className="space-y-4 rounded-2xl border bg-white p-5 print:border-0 print:p-0">
      <div><h2 className="text-2xl font-bold">{visible.title}</h2><p className="mt-1">{visible.filters.from} to {visible.filters.to}{visible.kind === 'attendance' ? ' · ' + visible.filters.roomName : ''}</p>
        <p className="mt-1 text-sm text-slate-600">Facility time: {visible.timeZone} · Generated {visible.generatedLabel}</p></div>
      <dl className="flex flex-wrap gap-x-8 gap-y-3">{visible.summary.map(({ label, value }) => <div key={label}><dt className="text-sm text-slate-600">{label}</dt><dd className="text-xl font-semibold">{value}</dd></div>)}</dl>
      {!visible.rows.length ? <p className="rounded-lg bg-slate-50 p-5">{kind === 'attendance' ? 'No attendance recorded for these dates and room.' : 'No purchases recorded for these dates.'}</p> : <>
        <div className="print:hidden" data-testid="screen-report"><ReportTable report={visible} rows={visible.rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)} /></div>
        <div className="hidden print:block" data-testid="printed-report"><ReportTable report={visible} rows={visible.rows} /></div>
        {visible.rows.length > PAGE_SIZE && <nav aria-label="Report pages" className="flex items-center justify-between gap-3 print:hidden">
          <button className={button} disabled={page === 1} onClick={() => setPage(page - 1)}>Previous page</button><span>Page {page} of {Math.ceil(visible.rows.length / PAGE_SIZE)} · {visible.rows.length} records</span>
          <button className={button} disabled={page * PAGE_SIZE >= visible.rows.length} onClick={() => setPage(page + 1)}>Next page</button>
        </nav>}
      </>}
      <div className="space-y-1 text-sm text-slate-600">{visible.notes.map((note) => <p key={note}>{note}</p>)}</div>
    </section>}
  </div>;
}
