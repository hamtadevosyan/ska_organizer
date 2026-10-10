import axios from 'axios';
import { API_BASE_URL } from '../lib/api';

// This authenticated endpoint runs OCR on the facility server. It does not
// save a document or send the selected image to an external service.
export async function readStaffDocumentImage(staffId: string, image: string, signal: AbortSignal): Promise<string> {
  const response = await axios.post<{ text: string }>(`${API_BASE_URL}/api/staff/${encodeURIComponent(staffId)}/documents/expiration-check`,
    { image }, { signal, timeout: 32000 });
  if (typeof response.data.text !== 'string' || response.data.text.length > 80000) throw new Error('Document text is unavailable.');
  return response.data.text;
}
