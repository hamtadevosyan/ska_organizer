import { dayLabel, materialUnitLabel, orderedEntries, timeRange } from '../../api/activities';
import type { Entry } from '../../api/activities';

export function ActivityPrint({ roomName, weekStart, dates, entries, draft }: { roomName: string; weekStart: string; dates: string[]; entries: Entry[]; draft: boolean }) {
  const ordered = orderedEntries(entries);
  return <section className="activity-print hidden print:block">
    <h1 className="text-2xl font-bold">{roomName} — Weekly activities</h1>
    <p className="mb-4">Week of {weekStart}{draft ? ' · Draft — not saved' : ''}</p>
    <table className="w-full border-collapse text-left text-sm"><caption className="sr-only">Weekly activity schedule for {roomName}</caption>
      <thead><tr><th className="border p-2">Day</th><th className="border p-2">Time</th><th className="border p-2">Activity</th></tr></thead>
      {dates.map((date) => {
        const day = ordered.filter((entry) => entry.date === date);
        return <tbody key={date}>{day.length ? day.map((entry) => <tr key={entry.id} className="break-inside-avoid">
          <th scope="row" className="w-1/6 border p-2 align-top">{dayLabel(date)}<br />{date}</th>
          <td className="w-1/5 border p-2 align-top">{timeRange(entry)}</td>
          <td className="border p-2 align-top"><strong>{entry.activity?.name || 'Activity not chosen'}</strong><p className="whitespace-pre-wrap">{entry.activity?.description}</p>
            {!!entry.activity?.materials?.length && <p className="mt-2">Materials: {entry.activity.materials.map((material) => `${material.name}: ${material.quantity} ${materialUnitLabel(material.unit)}`).join('; ')}</p>}
          </td>
        </tr>) : <tr><th scope="row" className="border p-2">{dayLabel(date)}<br />{date}</th><td colSpan={2} className="border p-2">Nothing scheduled</td></tr>}</tbody>;
      })}
    </table>
  </section>;
}
