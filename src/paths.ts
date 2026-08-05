import { homedir } from 'os';
import { join } from 'path';

export const APP_NAMESPACE = 'titan-code';

function xdgPath(envName: 'XDG_STATE_HOME' | 'XDG_DATA_HOME' | 'XDG_CONFIG_HOME', fallbackSegments: string[]): string {
  const fromEnv = process.env[envName];
  return fromEnv || join(homedir(), ...fallbackSegments);
}

export const STATE_DIR = process.env.TITAN_CODE_STATE_HOME || join(
  xdgPath('XDG_STATE_HOME', ['.local', 'state']),
  APP_NAMESPACE
);

export const DATA_DIR = process.env.TITAN_CODE_DATA_HOME || join(
  xdgPath('XDG_DATA_HOME', ['.local', 'share']),
  APP_NAMESPACE
);

export const CONFIG_DIR = process.env.TITAN_CODE_CONFIG_HOME || join(
  xdgPath('XDG_CONFIG_HOME', ['.config']),
  APP_NAMESPACE
);

export const DB_PATH = join(STATE_DIR, 'sessions.sqlite3');
export const CHECKPOINTS_DIR = join(STATE_DIR, 'checkpoints');
export const CHECKPOINTS_FILE = join(STATE_DIR, 'checkpoints.json');
export const PREFS_PATH = join(DATA_DIR, 'prefs.json');
export const MODELS_PATH = join(DATA_DIR, 'models.json');
export const SECRETS_FILE = join(CONFIG_DIR, 'secrets.json');
export const RULES_PATH = process.env.TITAN_CODE_RULES_PATH || join(CONFIG_DIR, 'RULES.md');
export const CHEATSHEET_PATH = process.env.TITAN_CODE_CHEATSHEET_PATH || join(CONFIG_DIR, 'CHEATSHEET.md');
export const SKILLS_DIR = process.env.TITAN_CODE_SKILLS_DIR || join(CONFIG_DIR, 'skills');
