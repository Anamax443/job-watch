// Normalizovaný tvar inzerátu napříč všemi zdroji.
export interface JobPosting {
  id: string; // source-prefixed, např. "mpsv:123" nebo "ats:recruitee:firma:67"
  source: string; // "mpsv" | "ats:recruitee:firma" | ...
  title: string;
  employer: string;
  employerIco?: string;
  location?: string;
  region?: string;
  czIsco?: string;
  salaryFrom?: number;
  salaryTo?: number;
  url?: string;
  description?: string;
  datePosted?: string; // ISO
  dateChanged?: string; // ISO
  isAgency: boolean;
}

export interface ScoreResult {
  relevance: number; // 0–100
  seniority: 'lead' | 'senior' | 'other';
  reason: string;
}

export interface EnrichResult {
  realEmployer?: string;
  realEmployerUrl?: string;
  confidence: number; // 0–100
  duplicateUrls: string[];
}

// Cíl ATS fetche — odvozený z dynamicky objevených `sources` v D1 (ne ze statické konfigurace).
export interface AtsTarget {
  platform: 'recruitee' | 'greenhouse' | 'lever' | 'ashby' | 'smartrecruiters';
  company: string; // slug v URL daného ATS
  label?: string;
  isAgency?: boolean;
  sourceId?: number;
}

export interface Settings {
  keywords: string[];
  czIscoPrefixes: string[];
  regionPriority?: string;
  notifyThreshold: number;
  emailTo?: string;
  telegramChatId?: string;
  notifyEmail: boolean;
  notifyTelegram: boolean;
}

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ANTHROPIC_API_KEY: string;
  TELEGRAM_BOT_TOKEN: string;
  GRAPH_TENANT_ID: string;
  GRAPH_CLIENT_ID: string;
  GRAPH_CLIENT_SECRET: string;
  GRAPH_MAILBOX: string;
  SCORE_MODEL: string;
  ENRICH_MODEL: string;
  MAX_INCREMENT_BACKFILL_DAYS?: string;
  MAX_DISCOVERY_PER_RUN?: string;
}
