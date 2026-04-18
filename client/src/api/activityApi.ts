import axios from "axios";
import { API_BASE_URL } from "../lib/api";

export async function getAllActivities() {
  const res = await axios.get(`${API_BASE_URL}/api/activity`);
  return res.data;
}

