import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import Reports from './Reports';
import { dateRange, downloadReport, readReport, reportConfig, saveReportDownload } from '../api/reports';
import type { ReportData, ReportFilters, ReportKind } from '../api/reports';

vi.mock('../api/reports', async (original) => ({ ...await original<typeof import('../api/reports')>(),
  reportConfig: vi.fn(), readReport: vi.fn(), downloadReport: vi.fn(), saveReportDownload: vi.fn(),
}));
const config = { today: '2026-09-14', timeZone: 'America/Los_Angeles', maxRangeDays: 366,
  rooms: [{ id: 'room', name: 'Sunflowers', active: true }, { id: 'old', name: 'Former room', active: false }] };
let rows: ReportData['rows'];
function report(kind: ReportKind, filters: ReportFilters): ReportData {
  return { kind, title: kind === 'attendance' ? 'Attendance report' : 'Purchasing report',
    filters: { from: filters.from, to: filters.to, roomId: kind === 'attendance' ? filters.roomId || null : null,
      roomName: kind === 'attendance' ? config.rooms.find((room) => room.id === filters.roomId)?.name || 'All rooms' : null },
    timeZone: config.timeZone, generatedAt: '2026-09-14T17:00:00Z', generatedLabel: '2026-09-14 10:00:00 GMT-7',
    columns: [{ key: 'item', label: 'Item' }, { key: 'totalCost', label: 'Total cost' }], rows: structuredClone(rows),
    summary: [{ label: 'Records', value: String(rows.length) }], notes: ['Missing costs are not treated as zero.'] };
}
const show = () => render(<Reports />);
beforeEach(() => {
  vi.resetAllMocks(); rows = [];
  vi.mocked(reportConfig).mockResolvedValue(config);
  vi.mocked(readReport).mockImplementation(async (kind, filters) => report(kind, filters));
  vi.mocked(downloadReport).mockResolvedValue(new Blob(['csv'], { type: 'text/csv' }));
});

test('facility date presets, archived room filters and empty reports are simple and truthful', async () => {
  show(); await screen.findByText('No attendance recorded for these dates and room.');
  expect(screen.getByLabelText('From')).toHaveValue('2026-09-01');
  expect(screen.getByLabelText('To')).toHaveValue('2026-09-14');
  expect(screen.getByRole('option', { name: 'Former room (archived)' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Today' }));
  await waitFor(() => expect(readReport).toHaveBeenLastCalledWith('attendance',
    { from: '2026-09-14', to: '2026-09-14', roomId: '' }, expect.any(AbortSignal)));
  fireEvent.change(screen.getByLabelText('Room'), { target: { value: 'old' } });
  await screen.findByText('2026-09-14 to 2026-09-14 · Former room');
  fireEvent.click(screen.getByRole('button', { name: 'Purchases' }));
  await screen.findByText('No purchases recorded for these dates.');
  expect(screen.queryByLabelText('Room')).not.toBeInTheDocument();
  expect(dateRange('week', '2026-09-20')).toEqual({ from: '2026-09-14', to: '2026-09-20' });
  expect(dateRange('month', '2024-02-29')).toEqual({ from: '2024-02-01', to: '2024-02-29' });
});

test('invalid date ranges hide old results and disable printing and export without sending requests', async () => {
  show(); await screen.findByRole('region', { name: 'Report results' });
  const calls = vi.mocked(readReport).mock.calls.length;
  fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-09-15' } });
  expect(await screen.findByRole('alert')).toHaveTextContent('The end date must be on or after the start date.');
  expect(screen.queryByRole('region', { name: 'Report results' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Print report' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Download CSV' })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('From'), { target: { value: '' } });
  expect(screen.getByRole('alert')).toHaveTextContent('Choose both dates.');
  fireEvent.change(screen.getByLabelText('From'), { target: { value: '2024-01-01' } });
  expect(screen.getByRole('alert')).toHaveTextContent('Choose a range of up to 366 days.');
  expect(readReport).toHaveBeenCalledTimes(calls);
});

test('refresh failures hide stale reports and retry preserves the selected dates and room', async () => {
  show(); await screen.findByRole('region', { name: 'Report results' });
  fireEvent.change(screen.getByLabelText('Room'), { target: { value: 'room' } });
  await screen.findByText('2026-09-01 to 2026-09-14 · Sunflowers');
  vi.mocked(readReport).mockRejectedValueOnce(new Error('offline'));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh report' }));
  await screen.findByRole('alert');
  expect(screen.queryByRole('region', { name: 'Report results' })).not.toBeInTheDocument();
  expect(screen.getByLabelText('Room')).toHaveValue('room');
  fireEvent.click(screen.getByRole('button', { name: 'Retry report' }));
  await screen.findByText('2026-09-01 to 2026-09-14 · Sunflowers');
  expect(readReport).toHaveBeenLastCalledWith('attendance', { from: '2026-09-01', to: '2026-09-14', roomId: 'room' }, expect.any(AbortSignal));
});

test('changing filters ignores stale responses and cancels any download for the previous report', async () => {
  show(); await screen.findByRole('region', { name: 'Report results' });
  let finishOld!: (value: ReportData) => void;
  vi.mocked(readReport).mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }));
  fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-09-15' } });
  await waitFor(() => expect(readReport).toHaveBeenLastCalledWith('attendance', expect.objectContaining({ to: '2026-09-15' }), expect.any(AbortSignal)));
  const oldSignal = vi.mocked(readReport).mock.calls.at(-1)![2];
  fireEvent.click(screen.getByRole('button', { name: 'Today' }));
  await screen.findByText('2026-09-14 to 2026-09-14 · All rooms');
  expect(oldSignal.aborted).toBe(true);
  await act(async () => finishOld(report('attendance', { from: '2026-09-01', to: '2026-09-15', roomId: '' })));
  expect(screen.queryByText('2026-09-01 to 2026-09-15 · All rooms')).not.toBeInTheDocument();
  let finishDownload!: (value: Blob) => void;
  vi.mocked(downloadReport).mockImplementationOnce(() => new Promise((resolve) => { finishDownload = resolve; }));
  fireEvent.click(screen.getByRole('button', { name: 'Download CSV' }));
  const downloadSignal = vi.mocked(downloadReport).mock.calls.at(-1)![2];
  fireEvent.click(screen.getByRole('button', { name: 'Purchases' }));
  await screen.findByRole('heading', { name: 'Purchasing report' });
  expect(downloadSignal.aborted).toBe(true);
  await act(async () => finishDownload(new Blob(['old report'])));
  expect(saveReportDownload).not.toHaveBeenCalled();
});

test('screen pagination never truncates printing and downloads retain dates, zero and unknown costs', async () => {
  rows = Array.from({ length: 51 }, (_, i) => ({ id: 'row-' + i, item: 'Item ' + i, totalCost: i === 0 ? '0.00' : 'Not recorded' }));
  show(); await screen.findByTestId('screen-report');
  const screenTable = within(screen.getByTestId('screen-report'));
  const printed = within(screen.getByTestId('printed-report'));
  expect(screenTable.getAllByRole('row')).toHaveLength(51); // Header plus 50 records.
  expect(printed.getAllByRole('row')).toHaveLength(52);
  expect(screenTable.getByText('0.00')).toBeInTheDocument();
  expect(printed.getAllByText('Not recorded')).toHaveLength(50);
  fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
  expect(screenTable.getByText('Item 50')).toBeInTheDocument();
  expect(screenTable.queryByText('Item 0')).not.toBeInTheDocument();
  const print = vi.spyOn(window, 'print').mockImplementation(() => {});
  fireEvent.click(screen.getByRole('button', { name: 'Print report' }));
  expect(print).toHaveBeenCalledTimes(1); print.mockRestore();
  fireEvent.click(screen.getByRole('button', { name: 'Download CSV' }));
  await screen.findByText('CSV downloaded for the selected dates.');
  expect(downloadReport).toHaveBeenCalledWith('attendance', { from: '2026-09-01', to: '2026-09-14', roomId: '' }, expect.any(AbortSignal));
  expect(saveReportDownload).toHaveBeenCalledWith(expect.any(Blob), 'attendance-2026-09-01-to-2026-09-14.csv');
});

test('settings and download failures can be retried and unmount cancels remaining requests', async () => {
  vi.mocked(reportConfig).mockRejectedValueOnce(new Error('offline'));
  const view = show(); await screen.findByRole('alert');
  expect(readReport).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Retry report settings' }));
  await screen.findByRole('region', { name: 'Report results' });
  vi.mocked(downloadReport).mockRejectedValueOnce(new Error('offline'));
  fireEvent.click(screen.getByRole('button', { name: 'Download CSV' }));
  await screen.findByText('Could not download the report. Try again.');
  expect(screen.getByRole('region', { name: 'Report results' })).toBeInTheDocument();
  vi.mocked(downloadReport).mockImplementationOnce(() => new Promise(() => {}));
  fireEvent.click(screen.getByRole('button', { name: 'Download CSV' }));
  const downloadSignal = vi.mocked(downloadReport).mock.calls.at(-1)![2];
  const readSignal = vi.mocked(readReport).mock.calls.at(-1)![2];
  view.unmount();
  expect(downloadSignal.aborted).toBe(true); expect(readSignal.aborted).toBe(true);
});
