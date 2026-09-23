import type { ReportData } from '../../api/reports';

export function ReportTable({ report, rows }: { report: ReportData; rows: ReportData['rows'] }) {
  return <div className="overflow-x-auto print:overflow-visible"><table className="w-full border-collapse text-left text-sm">
    <caption className="sr-only">{report.title} records</caption>
    <thead className="bg-slate-50"><tr>{report.columns.map(({ key, label }) => <th scope="col" key={key} className="border-b p-3 print:border print:p-2">{label}</th>)}</tr></thead>
    <tbody>{rows.map((row) => <tr key={row.id} className="border-b align-top break-inside-avoid">
      {report.columns.map(({ key }) => <td key={key} className="p-3 print:border print:p-2">{row[key]}</td>)}
    </tr>)}</tbody>
  </table></div>;
}
