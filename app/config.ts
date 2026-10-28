import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type Config = {
  databaseUrl: string; mode: 'fake'|'meta'; appSecret: string; verifyToken: string;
  businessAccountId: string; phoneNumberId: string; accessToken: string; apiVersion: string;
  testRecipients: string[]; storeName: string; supportContact: string; paused: boolean;
  host: string; port: number;
};
export class ConfigError extends Error {}

export function loadConfig(): Config {
  const env = new URL('../.env',import.meta.url);
  if (existsSync(env)) process.loadEnvFile(fileURLToPath(env));
  const value = (key: string) => process.env[key]?.trim() ?? '';
  const required = (key: string) => {
    const result=value(key);
    if (!result) throw new ConfigError(`Configure ${key}`);
    return result;
  };
  // shortcut: this first slice uses the demo schema; production requires a separate rollout.
  if (!['local','development','dev','test','staging'].includes(value('APP_ENV') || 'development')) throw new ConfigError('Production is not enabled for the demo schema');
  const mode=value('WHATSAPP_MODE') || 'fake';
  if (mode !== 'fake' && mode !== 'meta') throw new ConfigError('WHATSAPP_MODE must be fake or meta');
  const port=Number(value('PORT') || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigError('PORT must be between 1 and 65535');
  if (value('AUTOMATION_PAUSED') && !['true','false'].includes(value('AUTOMATION_PAUSED'))) throw new ConfigError('AUTOMATION_PAUSED must be true or false');
  const config: Config = {
    databaseUrl: required('DATABASE_URL'), mode, appSecret: required('WHATSAPP_APP_SECRET'),
    verifyToken: required('WHATSAPP_VERIFY_TOKEN'), businessAccountId: required('WHATSAPP_BUSINESS_ACCOUNT_ID'),
    phoneNumberId: required('WHATSAPP_PHONE_NUMBER_ID'), accessToken: value('WHATSAPP_ACCESS_TOKEN'),
    apiVersion: value('WHATSAPP_API_VERSION'), testRecipients: value('WHATSAPP_TEST_RECIPIENTS').split(',').map(s=>s.trim()).filter(Boolean),
    storeName: value('STORE_NAME') || 'Grocery Store Demo', supportContact: value('SUPPORT_CONTACT') || 'Please contact the store directly for help.',
    paused: value('AUTOMATION_PAUSED') === 'true', host: value('HOST') || '127.0.0.1', port,
  };
  if (config.appSecret.length<16 || config.verifyToken.length<16) throw new ConfigError('Webhook secret and verify token must each contain at least 16 characters');
  if (config.storeName.length>100 || config.supportContact.length>500) throw new ConfigError('Store name or support contact is too long');
  if (mode === 'meta') {
    required('WHATSAPP_ACCESS_TOKEN'); required('SUPPORT_CONTACT');
    if (!/^v\d+\.\d+$/.test(config.apiVersion)) throw new ConfigError('Configure a supported WHATSAPP_API_VERSION, for example vNN.0');
    if (!/^\d+$/.test(config.businessAccountId) || !/^\d+$/.test(config.phoneNumberId)) throw new ConfigError('Configure actual numeric Meta business-account and phone-number IDs');
    if (!config.testRecipients.length) throw new ConfigError('WHATSAPP_TEST_RECIPIENTS must explicitly allow the test recipients');
  }
  return config;
}
