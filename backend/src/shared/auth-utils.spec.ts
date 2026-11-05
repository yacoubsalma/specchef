import {
  comparePassword,
  cryptPassword,
  generateOtp,
  generateTempPassword,
} from './auth-utils';

describe('auth-utils', () => {
  it('hash un mot de passe sans le stocker en clair', async () => {
    const hash = await cryptPassword('Secret#123');
    expect(hash).not.toBe('Secret#123');
    expect(hash.length).toBeGreaterThan(20);
  });

  it('valide le bon mot de passe et refuse le mauvais', async () => {
    const hash = await cryptPassword('Secret#123');
    await expect(comparePassword('Secret#123', hash)).resolves.toBe(true);
    await expect(comparePassword('autre', hash)).resolves.toBe(false);
  });

  it('génère un OTP numérique de 6 chiffres par défaut', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateOtp()).toMatch(/^\d{6}$/);
    }
  });

  it('respecte la longueur demandée pour l\'OTP', () => {
    expect(generateOtp(4)).toMatch(/^\d{4}$/);
    expect(generateOtp(8)).toMatch(/^\d{8}$/);
  });

  it('génère un mot de passe temporaire de 12 caractères', () => {
    const pwd = generateTempPassword();
    expect(pwd).toHaveLength(12);
    expect(generateTempPassword()).not.toBe(pwd);
  });
});
