import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

/**
 * Chiffrement symétrique (AES-256-GCM) du token API Jira avant stockage en base.
 *
 * On ne stocke JAMAIS le token en clair : seul `encrypted_token` (+ IV et auth tag)
 * est persisté. La clé de chiffrement provient de la variable d'environnement
 * `JIRA_TOKEN_ENCRYPTION_KEY` (n'importe quelle chaîne, dérivée en 32 octets via scrypt).
 *
 * ⚠️ Si cette variable change, tous les tokens déjà stockés deviennent indéchiffrables
 * (l'utilisateur devra reconnecter son compte Jira).
 */

const ALGORITHM = 'aes-256-gcm';
// Sel fixe : suffisant ici car la clé source (JIRA_TOKEN_ENCRYPTION_KEY) est déjà
// un secret à haute entropie fourni par l'environnement, pas un mot de passe utilisateur.
const SALT = 'jira-credential-encryption-v1';

function getKey(): Buffer {
  const secret = process.env.JIRA_TOKEN_ENCRYPTION_KEY;
  if (!secret || secret.length < 8) {
    throw new Error(
      "JIRA_TOKEN_ENCRYPTION_KEY manquant ou trop court dans l'environnement. " +
      'Définissez une valeur secrète (≥ 16 caractères aléatoires) pour activer ' +
      "l'intégration Jira.",
    );
  }
  return scryptSync(secret, SALT, 32);
}

export interface EncryptedPayload {
  encryptedToken: string;
  iv: string;
  authTag: string;
}

export function encryptToken(plainToken: string): EncryptedPayload {
  const key = getKey();
  const iv = randomBytes(12); // 96 bits, recommandé pour GCM
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plainToken, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    encryptedToken: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
  };
}

export function decryptToken(payload: EncryptedPayload): string {
  const key = getKey();
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(payload.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(payload.authTag, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payload.encryptedToken, 'base64')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}
