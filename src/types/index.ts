export interface User {
  telegramId: number;
  address: string;
  encryptedPrivateKey: string;
  createdAt: string;
}

export interface UserDatabase {
  users: Record<string, User>;
}

export interface TradeResult {
  success: boolean;
  orderId?: string;
  filledSize?: string;
  avgPrice?: string;
  error?: string;
}
