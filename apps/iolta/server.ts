import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import multer from "multer";
import { createRequire } from 'module';
import crypto from "crypto";
import { extractPdfText } from './src/pdf';
const require = createRequire(import.meta.url);
const firebaseConfig = require('./firebase-applet-config.json');
import * as xlsx from "xlsx";
import { parse as parseCsv } from "csv-parse/sync";
import fs from "fs";
import { GoogleGenAI, Type } from "@google/genai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==================================================================
// Firebase ID-token verification (audit issue #3)
// Verifies RS256 JWTs against Google's public securetoken certs using
// only node:crypto — no Admin SDK / service-account dependency needed.
// ==================================================================
const FIREBASE_PROJECT_ID = firebaseConfig.projectId;
const FIREBASE_CERT_URL =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

let certCache: { certs: Record<string, string>; expiresAt: number } = { certs: {}, expiresAt: 0 };

async function getPublicCerts(): Promise<Record<string, string>> {
  if (Date.now() < certCache.expiresAt && Object.keys(certCache.certs).length > 0) {
    return certCache.certs;
  }
  const res = await fetch(FIREBASE_CERT_URL);
  if (!res.ok) throw new Error(`Failed to fetch Firebase public certs (HTTP ${res.status})`);
  const cacheControl = res.headers.get('cache-control') || '';
  const maxAgeMatch = cacheControl.match(/max-age=(\d+)/);
  const maxAgeMs = (maxAgeMatch ? parseInt(maxAgeMatch[1], 10) : 3600) * 1000;
  const certs = (await res.json()) as Record<string, string>;
  certCache = { certs, expiresAt: Date.now() + maxAgeMs };
  return certs;
}

function base64UrlDecode(input: string): Buffer {
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(b64, 'base64');
}

async function verifyFirebaseIdToken(token: string): Promise<{ uid: string } | null> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, signatureB64] = parts;

    const header = JSON.parse(base64UrlDecode(headerB64).toString('utf-8'));
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') return null;

    const certs = await getPublicCerts();
    const cert = certs[header.kid];
    if (!cert) return null;

    const isValidSig = crypto.verify(
      'RSA-SHA256',
      Buffer.from(`${headerB64}.${payloadB64}`),
      cert,
      base64UrlDecode(signatureB64)
    );
    if (!isValidSig) return null;

    const payload = JSON.parse(base64UrlDecode(payloadB64).toString('utf-8'));
    const nowSec = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== 'number' || payload.exp < nowSec) return null;
    if (typeof payload.iat !== 'number' || payload.iat > nowSec + 300) return null;
    if (payload.aud !== FIREBASE_PROJECT_ID) return null;
    if (payload.iss !== `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`) return null;
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) return null;

    return { uid: payload.sub };
  } catch {
    return null;
  }
}

async function requireAuth(req: any, res: any, next: any) {
  const authHeader = req.headers.authorization || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/);
  if (!match) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const decoded = await verifyFirebaseIdToken(match[1]);
  if (!decoded) {
    return res.status(401).json({ error: 'Invalid or expired authentication token' });
  }
  req.uid = decoded.uid;
  next();
}

// ==================================================================
// Minimal in-memory rate limiter, keyed by authenticated uid (issue #3)
// ==================================================================
function rateLimit(maxRequests: number, windowMs: number) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  // Periodically drop expired entries so the map cannot grow unbounded.
  // (No .unref(): the HTTP listener already keeps the process alive.)
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (now >= entry.resetAt) hits.delete(key);
    }
  }, windowMs);

  return (req: any, res: any, next: any) => {
    const key = req.uid || req.ip || 'anonymous';
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > maxRequests) {
      return res.status(429).json({ error: 'Too many requests. Please try again shortly.' });
    }
    next();
  };
}

// ==================================================================
// Gemini (server-side only — the API key never reaches the browser,
// audit issue #4)
// ==================================================================
const geminiApiKey = process.env.GEMINI_API_KEY;
const ai = geminiApiKey ? new GoogleGenAI({ apiKey: geminiApiKey }) : null;
const GEMINI_MODEL = "gemini-3-flash-preview";

const EXTRACTION_SYSTEM_INSTRUCTION = `
  You are an expert legal accountant specializing in New Jersey IOLTA (Interest on Lawyers Trust Accounts) rules (Rule 1:21-6).
  Your task is to extract transaction data from bank statements or check images.

  RULES:
  1. For disbursements (checks), identify the check number and the date issued if visible.
  2. For receipts, identify the source and date.
  3. Look for potential client names in memos, descriptions, or check "Pay to the order of" lines.
  4. Return a JSON array of transactions.
  5. Dates must be in YYYY-MM-DD format.
  6. Amounts must be numbers (positive for receipts, negative for disbursements).
  7. If you are unsure about a client name, put it in 'potentialClientName'.

  NJ RPC VIOLATION ALERTS:
  - Note if a transaction looks like commingling (e.g., "Firm Rent", "Payroll").
  - Note if a check is made out to "Cash".
  - Note if a disbursement exceeds a client's balance (if balance context were provided).
`;

const CHAT_SYSTEM_INSTRUCTION = `
  You are an expert NJ IOLTA Trust Accounting assistant.
  You help lawyers understand New Jersey Rule 1:21-6 and RPC 1.15.
  You can answer questions about three-way reconciliation, record-keeping requirements,
  and how to identify potential RPC violations like commingling or unidentified funds.
  Be professional, accurate, and concise.
  If asked about specific transactions, refer to the data provided in the app.
`;

const extractionSchema = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: {
      date: { type: Type.STRING },
      amount: { type: Type.NUMBER },
      type: { type: Type.STRING, enum: ["receipt", "disbursement"] },
      description: { type: Type.STRING },
      checkNumber: { type: Type.STRING },
      clientName: { type: Type.STRING },
      clearDate: { type: Type.STRING }
    },
    required: ["date", "amount", "type", "description"]
  }
};

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Base64-encoded statement images travel through the JSON API, so keep a
  // bounded but practical body limit (multer independently caps raw uploads).
  app.use(express.json({ limit: '20mb' }));

  // Upload constraints (audit issue #3): 10 MB per file, max 10 files,
  // extension allowlist enforced in fileFilter.
  const ALLOWED_EXTENSIONS = new Set(['.pdf', '.xlsx', '.xls', '.csv', '.jpg', '.jpeg', '.png']);
  fs.mkdirSync('uploads', { recursive: true });
  const upload = multer({
    dest: 'uploads/',
    limits: { fileSize: 10 * 1024 * 1024, files: 10 },
    fileFilter: (_req: any, file: any, cb: any) => {
      const ext = path.extname(file.originalname).toLowerCase();
      if (ALLOWED_EXTENSIONS.has(ext)) {
        cb(null, true);
      } else {
        cb(new Error(`Unsupported file type: ${ext || '(none)'}`));
      }
    }
  });

  // Wrap multer so limit/file-type rejections become clean 4xx responses.
  const uploadMiddleware = (req: any, res: any, next: any) => {
    upload.array('files')(req, res, (err: any) => {
      if (err) {
        const status = err.code === 'LIMIT_FILE_SIZE' || err.code === 'LIMIT_FILE_COUNT' ? 413 : 400;
        return res.status(status).json({ error: `Upload rejected: ${err.message}` });
      }
      next();
    });
  };

  // API Route for file processing (now requires auth + rate limit, issue #3)
  app.post("/api/process-files", requireAuth, rateLimit(20, 60_000), uploadMiddleware, async (req: any, res) => {
    const files = (req.files as any[]) || [];
    try {
      const results = [];

      for (const file of files) {
        try {
          let content = "";
          const fileExtension = path.extname(file.originalname).toLowerCase();

          if (fileExtension === ".pdf") {
            const dataBuffer = fs.readFileSync(file.path);
            content = await extractPdfText(dataBuffer);
          } else if (fileExtension === ".xlsx" || fileExtension === ".xls") {
            const workbook = xlsx.readFile(file.path);
            const sheetNames = workbook.SheetNames;
            sheetNames.forEach(sheetName => {
              const worksheet = workbook.Sheets[sheetName];
              content += xlsx.utils.sheet_to_csv(worksheet) + "\n";
            });
          } else if (fileExtension === ".csv") {
            content = fs.readFileSync(file.path, 'utf-8');
          } else if (['.jpg', '.jpeg', '.png'].includes(fileExtension)) {
            // For images, we'll send the base64 to the frontend to handle with Gemini Vision
            const base64 = fs.readFileSync(file.path, { encoding: 'base64' });
            content = `IMAGE_DATA:${base64}:${file.mimetype}`;
          }

          results.push({
            name: file.originalname,
            type: fileExtension,
            content: content
          });
        } finally {
          // Always remove the temp file, even when parsing throws (issue #3).
          fs.unlink(file.path, () => {});
        }
      }

      res.json({ files: results });
    } catch (error) {
      console.error("Error processing files:", error);
      // Best-effort cleanup of any temp files that were never processed.
      for (const file of files) {
        try { fs.unlinkSync(file.path); } catch { /* already removed */ }
      }
      res.status(500).json({ error: "Failed to process files" });
    }
  });

  // API Route: AI extraction of bank statement text/images (issue #4)
  app.post("/api/gemini/parse", requireAuth, rateLimit(30, 60_000), async (req: any, res) => {
    if (!ai) {
      return res.status(503).json({ error: "Gemini API key is not configured on the server" });
    }
    const { content, isImage } = req.body || {};
    if (typeof content !== 'string' || content.length === 0) {
      return res.status(400).json({ error: "Field 'content' (string) is required" });
    }
    if (content.length > 15 * 1024 * 1024) {
      return res.status(413).json({ error: "Content too large" });
    }

    try {
      const prompt = isImage
        ? "Extract all transactions from this check image or bank statement page. Focus on Date, Amount, Check Number, and Payee/Client Name."
        : `Extract all transactions from the following bank statement text:\n\n${content}`;

      const response = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: isImage ? {
          parts: [
            { text: prompt },
            { inlineData: { data: content.split(':')[1], mimeType: content.split(':')[2] || "image/jpeg" } }
          ]
        } : prompt,
        config: {
          systemInstruction: EXTRACTION_SYSTEM_INSTRUCTION,
          responseMimeType: "application/json",
          responseSchema: extractionSchema
        }
      });

      let transactions = [];
      try {
        transactions = JSON.parse(response.text || "[]");
      } catch {
        transactions = [];
      }
      res.json({ transactions });
    } catch (error) {
      console.error("Gemini parse error:", error);
      res.status(502).json({ error: "AI extraction failed" });
    }
  });

  // API Route: AI chat assistant (issue #4)
  app.post("/api/gemini/chat", requireAuth, rateLimit(30, 60_000), async (req: any, res) => {
    if (!ai) {
      return res.status(503).json({ error: "Gemini API key is not configured on the server" });
    }
    const { message, history } = req.body || {};
    if (typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({ error: "Field 'message' (string) is required" });
    }
    if (message.length > 8000) {
      return res.status(413).json({ error: "Message too long" });
    }

    try {
      const chat = ai.chats.create({
        model: GEMINI_MODEL,
        config: { systemInstruction: CHAT_SYSTEM_INSTRUCTION },
        history: Array.isArray(history) ? history.slice(-20) : [],
      });
      const result = await chat.sendMessage({ message });
      res.json({ text: result.text || "I'm sorry, I couldn't process that request." });
    } catch (error) {
      console.error("Gemini chat error:", error);
      res.status(502).json({ error: "AI chat failed" });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
