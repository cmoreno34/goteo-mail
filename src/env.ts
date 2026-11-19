export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  PUBLIC_URL: string; // https://goteo.tudominio.com (sin barra final)
  ALERT_EMAIL?: string; // a quién avisar si un buzón se atasca
  ADMIN_PASSWORD: string;
  ENC_KEY: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  MS_CLIENT_ID: string;
  MS_CLIENT_SECRET: string;
  DRY_RUN?: string; // "1" = simula los envíos (no conecta con ningún buzón)
}
