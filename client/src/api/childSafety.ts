import axios from 'axios';
import { API_BASE_URL } from '../lib/api';
import type { ClassroomScope } from './classroom';
export type SafetyContact = { name: string; relationship: string; phone: string };
export type SafetyDetails = {
  allergyStatus: 'unknown' | 'none' | 'recorded'; allergies: string; dietaryRestrictions: string;
  medicalAlerts: string; careInstructions: string; medicationInstructions: string; medicationLocation: string;
  physicianName: string; physicianPhone: string; pickupRestrictions: string;
  emergencyContacts: SafetyContact[]; authorizedPickup: SafetyContact[];
  treatmentConsent: 'unknown' | 'on-file' | 'not-on-file';
};
export type SafetyCard = SafetyDetails & { version: number; reviewedAt: string | null };
export const emptySafety = (): SafetyDetails => ({ allergyStatus: 'unknown', allergies: '', dietaryRestrictions: '', medicalAlerts: '',
  careInstructions: '', medicationInstructions: '', medicationLocation: '', physicianName: '', physicianPhone: '', pickupRestrictions: '',
  emergencyContacts: [], authorizedPickup: [], treatmentConsent: 'unknown' });
export async function readSafety(childId: string, teacher: boolean, signal?: AbortSignal) {
  const path = teacher ? '/classroom/children/' : '/children/';
  const result = (await axios.get<{ data: SafetyCard | (ClassroomScope & { childId: string; card: SafetyCard }) }>(
    API_BASE_URL + '/api' + path + encodeURIComponent(childId) + '/safety', { signal })).data.data;
  return result;
}
export async function saveSafety(childId: string, details: SafetyDetails, version: number, reviewed: boolean) {
  return (await axios.put<{ data: SafetyCard }>(API_BASE_URL + '/api/children/' + encodeURIComponent(childId) + '/safety', { ...details, version, reviewed })).data.data;
}
