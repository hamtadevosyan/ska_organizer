import axios from 'axios';
import { API_BASE_URL } from '../lib/api';

export type Room = {
  id: string; name: string; ageMinMonths: number | null; ageMaxMonths: number | null;
  capacity: number | null; active: boolean; needsConfiguration: boolean;
  assignedChildCount: number; availablePlaces: number | null; overCapacity: boolean;
};
export type ChildOption = { id: string; firstName: string; lastName: string; roomId: string | null };
export type AssignmentPreview = {
  room: Room; childId: string; proposedChildCount: number; exceedsCapacity: boolean; alreadyAssigned: boolean;
};
export type RoomSettings = Pick<Room, 'name' | 'ageMinMonths' | 'ageMaxMonths' | 'capacity' | 'active'>;
export const roomsUrl = API_BASE_URL + '/api/rooms';
export async function saveRoom(id: string | null, settings: Partial<RoomSettings>) {
  const response = id
    ? await axios.put<{ data: Room }>(roomsUrl + '/' + encodeURIComponent(id), settings)
    : await axios.post<{ data: Room }>(roomsUrl, settings);
  return response.data.data;
}
export const assignChild = (childId: string, roomId: string | null, confirmOverCapacity = false) =>
  axios.put(API_BASE_URL + '/api/children/' + encodeURIComponent(childId) + '/room', { roomId, confirmOverCapacity });
