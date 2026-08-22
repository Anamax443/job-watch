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
  // Kontaktní osoba (hlavně z MPSV) — ať lze oslovit konkrétního člověka i po skončení VŘ.
  contactName?: string; // tituly + jméno + příjmení
  contactEmail?: string;
  contactPhone?: string;
  contactPosition?: string; // pozice kontaktní osoby ve firmě
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
  notifySlack: boolean;
  profile?: string; // CV / o mně — AI porovnává pozice proti tomuto profilu
  // AI backend „dle úhrady": '' = podle serveru (default zdarma Workers AI),
  // 'workers-ai' | 'anthropic' | 'off' (viz src/ai.ts). Přebíjí env.AI_PROVIDER.
  aiProvider?: string;
}

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  // Cloudflare Workers AI binding — free backend AI vrstvy (skórování). Viz wrangler.toml [ai].
  AI?: Ai;
  // Výběr AI backendu: '' = podle serveru (default zdarma Workers AI), 'workers-ai' | 'anthropic' | 'off'.
  AI_PROVIDER?: string;
  ANTHROPIC_API_KEY: string;
  TELEGRAM_BOT_TOKEN: string;
  // Cloudflare Email Sending binding (viz wrangler.toml [[send_email]]) — odesílání bez SMTP/klíčů.
  // Doména odesílatele (EMAIL_FROM) musí být onboardovaná na Email Sending.
  EMAIL?: {
    send(message: {
      to: string | string[];
      from: { email: string; name?: string };
      replyTo?: string;
      subject: string;
      text?: string;
      html?: string;
    }): Promise<{ messageId: string }>;
  };
  // Adresa odesílatele e-mailů (necitlivé, viz [vars]); default jobwatch@maxferit.cz.
  EMAIL_FROM?: string;
  SLACK_WEBHOOK_URL?: string;
  SERPER_API_KEY?: string;
  ADZUNA_APP_ID?: string;
  ADZUNA_APP_KEY?: string;
  SCORE_MODEL: string;
  ENRICH_MODEL: string;
  MAX_INCREMENT_BACKFILL_DAYS?: string;
  MAX_DISCOVERY_PER_RUN?: string;
  MAX_LIVENESS_CHECKS_PER_RUN?: string;
  // Strop notifikací odeslaných z fronty na jeden běh (dohánění historie ať neudělá lavinu).
  MAX_NOTIFY_FROM_QUEUE_PER_RUN?: string;
  // Strop AI hodnocení na jeden běh (předvídatelná spotřeba AI backendu). Default 150.
  MAX_SCORES_PER_RUN?: string;
  WEB_SEARCH?: string;
  GIT_COMMIT?: string;
  BUILT_AT?: string;
  // Allowlist e-mailů, které smí do aplikace (oddělovač , ; nebo mezera; "*" = kterýkoli
  // účet ověřený Accessem). Prázdné = projde každý přihlášený — hlásí se v /api/health.
  // Aplikace tak neověřuje jen „je za Accessem", ale KDO. Viz src/access.ts.
  ACCESS_ALLOWED_EMAILS?: string;
  // Bypass autorizace pro `wrangler dev` (v .dev.vars, NIKDY na produkci). Musí být přesně "1".
  DEV_OPEN?: string;
}
