import type { ReportData } from '../../api/reports';

export function ReportTable({ report, rows }: { report: ReportData; rows: ReportData['rows'] }) {
  return <div className="overflow-x-auto print:overflow-visible"><table role="table" className="ska-record-table w-full border-collapse text-left text-sm">
    <caption className="sr-only">{report.title} records</caption>
    <thead role="rowgroup" className="bg-slate-50"><tr role="row">{report.columns.map(({ key, label }) => <th role="columnheader" scope="col" key={key} className="border-b p-3 print:border print:p-2">{label}</th>)}</tr></thead>
    <tbody role="rowgroup">{rows.map((row) => <tr role="row" key={row.id} className="border-b align-top break-inside-avoid">
      {report.columns.map(({ key, label }, index) => <td role="cell" data-label={label} data-primary={index === 0 || undefined} key={key} className="p-3 print:border print:p-2">{row[key]}</td>)}
    </tr>)}</tbody>
  </table></div>;
}
