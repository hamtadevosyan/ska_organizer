import type { SelectHTMLAttributes } from 'react';
import type { Room } from '../../api/rooms';

type Props = Omit<SelectHTMLAttributes<HTMLSelectElement>, 'value' | 'onChange'> & {
  rooms: Room[]; value: string; onChange: (id: string) => void; allowArchived?: boolean;
};
export function RoomSelect({ rooms, value, onChange, allowArchived = false, ...props }: Props) {
  const options = rooms.filter((room) => room.active || allowArchived || room.id === value);
  return <select {...props} value={value} onChange={(event) => onChange(event.target.value)}>
    <option value="">Choose a room</option>
    {value && !options.some((room) => room.id === value) && <option value={value} disabled>Room unavailable</option>}
    {options.map((room) => <option key={room.id} value={room.id} disabled={!allowArchived && !room.active}>
      {room.name}{room.active ? '' : ' (archived)'}{room.needsConfiguration ? ' — needs setup' : ''}
    </option>)}
  </select>;
}
