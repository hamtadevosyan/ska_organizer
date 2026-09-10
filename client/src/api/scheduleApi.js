import axios from "axios";

import { API_BASE_URL } from "../lib/api";
const API_BASE = API_BASE_URL + "/api/schedule";

export async function getWeek(roomId, weekStart) {
  const res = await axios.get(`${API_BASE}/week`, {
    params: { roomId, start: weekStart }
  });
  return res.data;
}

export async function getSuggestions(roomId, weekStart) {
  const res = await axios.get(`${API_BASE}/suggestions`, {
    params: { roomId, start: weekStart }
  });
  return res.data;
}

export async function saveWeek(roomId, weekStart, entries) {
  const res = await axios.post(`${API_BASE}/week`, {
    roomId,
    weekStart,
    entries
  });
  return res.data;
}
