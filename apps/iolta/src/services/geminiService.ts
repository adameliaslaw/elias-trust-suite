import { auth } from '../firebase';

export interface ExtractedTransaction {
  date: string;
  amount: number;
  type: 'receipt' | 'disbursement';
  description: string;
  checkNumber?: string;
  clientName?: string;
  clearDate?: string;
}

/**
 * Gemini calls are proxied through the Express server (see server.ts), which
 * holds GEMINI_API_KEY in server-side environment variables. The key is never
 * shipped in the browser bundle (audit issue #4). Every request carries the
 * user's Firebase ID token, which the server verifies (audit issue #3).
 */
async function callGeminiApi(path: string, payload: unknown): Promise<any> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error('You must be signed in to use AI features.');
  }
  const idToken = await user.getIdToken();

  const response = await fetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${idToken}`
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({} as any));
    throw new Error(body?.error || `AI request failed (HTTP ${response.status})`);
  }
  return response.json();
}

export async function parseBankContent(content: string, isImage: boolean = false): Promise<ExtractedTransaction[]> {
  const data = await callGeminiApi('/api/gemini/parse', { content, isImage });
  return Array.isArray(data?.transactions) ? data.transactions : [];
}

export async function chatWithGemini(message: string, history: { role: 'user' | 'model', parts: { text: string }[] }[] = []): Promise<string> {
  const data = await callGeminiApi('/api/gemini/chat', { message, history });
  return data?.text || "I'm sorry, I couldn't process that request.";
}
