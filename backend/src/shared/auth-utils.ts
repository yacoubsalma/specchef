import * as bcrypt from 'bcryptjs';

/**
 * Hash un mot de passe en clair avec bcrypt.
 */
export const cryptPassword = async (password: string): Promise<string> => {
  return bcrypt.hash(password, 10);
};

/**
 * Compare un mot de passe en clair avec son hash bcrypt.
 */
export const comparePassword = async (
  password: string,
  hashedPassword: string,
): Promise<boolean> => {
  return bcrypt.compare(password, hashedPassword);
};

/**
 * Génère un code OTP numérique à `length` chiffres (par défaut 6).
 * Ex: generateOtp() -> "482913"
 */
export const generateOtp = (length: number = 6): string => {
  return Math.floor(Math.random() * Math.pow(10, length))
    .toString()
    .padStart(length, '0');
};

/**
 * Génère un mot de passe temporaire lisible (utilisé quand un Admin
 * crée un compte sans fournir de mot de passe).
 */
export const generateTempPassword = (): string => {
  const chars =
    'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$';
  let pwd = '';
  for (let i = 0; i < 12; i++) {
    pwd += chars[Math.floor(Math.random() * chars.length)];
  }
  return pwd;
};
