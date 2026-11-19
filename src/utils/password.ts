import bcrypt from 'bcrypt';

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  compare(password: string, hash: string): Promise<boolean>;
}

/** bcrypt cost 12 in production (security.md 2.3). Tests pass a low cost to stay fast. */
export function createPasswordHasher(cost: number): PasswordHasher {
  return {
    hash: (password) => bcrypt.hash(password, cost),
    compare: (password, hash) => bcrypt.compare(password, hash),
  };
}
