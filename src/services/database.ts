import fs from 'fs';
import path from 'path';
import { User, UserDatabase } from '../types';

const DATA_DIR = path.join(process.cwd(), 'data');
const DB_FILE = path.join(DATA_DIR, 'users.json');

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadDatabase(): UserDatabase {
  ensureDataDir();
  if (!fs.existsSync(DB_FILE)) {
    return { users: {} };
  }
  const data = fs.readFileSync(DB_FILE, 'utf-8');
  return JSON.parse(data);
}

function saveDatabase(db: UserDatabase): void {
  ensureDataDir();
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

export function getUser(telegramId: number): User | null {
  const db = loadDatabase();
  return db.users[telegramId.toString()] || null;
}

export function saveUser(user: User): void {
  const db = loadDatabase();
  db.users[user.telegramId.toString()] = user;
  saveDatabase(db);
}

export function userExists(telegramId: number): boolean {
  return getUser(telegramId) !== null;
}
